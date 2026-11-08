//! Tauri glue: commands the UI calls, and the sink that streams terminal output and engine events
//! back to it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tether_core::term::Size;
use tether_core::{Answer, Core, Event, Session, Settings, Sink, Snippet, Store, TermId, Tunnel};
use uuid::Uuid;

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn errx(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Terminal output goes to each terminal's own channel (ordered, binary); everything else is an
/// app event. Output that arrives before the UI's channel is registered is held, then flushed.
struct UiSink {
    app: AppHandle,
    channels: Mutex<HashMap<TermId, Channel<InvokeResponseBody>>>,
    early: Mutex<HashMap<TermId, Vec<u8>>>,
}

impl Sink for UiSink {
    fn output(&self, term: TermId, data: &[u8]) {
        let chans = self.channels.lock();
        match chans.get(&term) {
            Some(ch) => {
                let _ = ch.send(InvokeResponseBody::Raw(data.to_vec()));
            }
            None => self.early.lock().entry(term).or_default().extend_from_slice(data),
        }
    }

    fn event(&self, e: Event) {
        let _ = self.app.emit("tether", e);
    }
}

impl UiSink {
    fn attach(&self, term: TermId, ch: Channel<InvokeResponseBody>) {
        let mut chans = self.channels.lock();
        if let Some(buf) = self.early.lock().remove(&term) {
            let _ = ch.send(InvokeResponseBody::Raw(buf));
        }
        chans.insert(term, ch);
    }

    fn detach(&self, term: TermId) {
        self.channels.lock().remove(&term);
        self.early.lock().remove(&term);
    }
}

struct App {
    core: Arc<Core>,
    sink: Arc<UiSink>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Boot {
    sessions: Vec<Session>,
    tunnels: Vec<Tunnel>,
    snippets: Vec<Snippet>,
    settings: Settings,
    shells: Vec<tether_core::shells::Shell>,
    platform: &'static str,
    /// a tiling window manager draws no title bar buttons, so neither do we
    tiling: bool,
    system_theme: Option<tether_core::theme::TerminalTheme>,
    version: &'static str,
    download_dir: String,
    has_ssh_config: bool,
    running_tunnels: Vec<Uuid>,
    /// an ssh://… link Tether was started with; handed out once, so a reload doesn't reopen it
    open_url: Option<String>,
}

static LAUNCH_URL: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);

fn download_dir(settings: &Settings) -> PathBuf {
    if !settings.download_dir.trim().is_empty() {
        return PathBuf::from(settings.download_dir.trim());
    }
    dirs::download_dir().or_else(dirs::home_dir).unwrap_or_else(std::env::temp_dir)
}

#[tauri::command]
fn bootstrap(app: State<'_, App>) -> Boot {
    let store = &app.core.store;
    let settings = store.settings();
    let tunnels = store.tunnels();
    let running_tunnels = tunnels.iter().filter(|t| app.core.tunnel_running(t.id)).map(|t| t.id).collect();
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase();
    Boot {
        sessions: store.sessions(),
        snippets: store.snippets(),
        shells: tether_core::shells::list(),
        platform: std::env::consts::OS,
        tiling: ["hyprland", "sway", "i3", "niri", "river", "bspwm", "qtile", "dwm"].iter().any(|w| desktop.contains(w)),
        system_theme: tether_core::theme::system_theme(),
        version: env!("CARGO_PKG_VERSION"),
        download_dir: download_dir(&settings).to_string_lossy().into_owned(),
        has_ssh_config: tether_core::ssh::ssh_dir().join("config").exists(),
        running_tunnels,
        open_url: LAUNCH_URL.lock().take(),
        tunnels,
        settings,
    }
}

// ---------------------------------------------------------------- saved data

#[tauri::command]
fn save_sessions(app: State<'_, App>, sessions: Vec<Session>) -> R<()> {
    // forget passwords of sessions that were deleted or no longer save one
    let keep: HashMap<Uuid, bool> = sessions.iter().map(|s| (s.id, s.save_password)).collect();
    for old in app.core.store.sessions() {
        if !keep.get(&old.id).copied().unwrap_or(false) && old.save_password {
            tether_core::secrets::delete(old.id);
        }
    }
    app.core.store.save_sessions(&sessions).map_err(err)
}

#[tauri::command]
fn save_tunnels(app: State<'_, App>, tunnels: Vec<Tunnel>) -> R<()> {
    app.core.store.save_tunnels(&tunnels).map_err(err)
}

#[tauri::command]
fn save_snippets(app: State<'_, App>, snippets: Vec<Snippet>) -> R<()> {
    app.core.store.save_snippets(&snippets).map_err(err)
}

#[tauri::command]
fn save_settings(app: State<'_, App>, settings: Settings) -> R<()> {
    app.core.store.save_settings(&settings).map_err(err)
}

#[tauri::command]
fn set_password(id: Uuid, password: Option<String>) -> R<()> {
    match password {
        Some(p) if !p.is_empty() => tether_core::secrets::set(id, &p).map_err(errx),
        _ => {
            tether_core::secrets::delete(id);
            Ok(())
        }
    }
}

#[tauri::command]
fn has_password(id: Uuid) -> bool {
    tether_core::secrets::get(id).is_some()
}

// ---------------------------------------------------------------- terminals

#[tauri::command]
async fn term_open(app: State<'_, App>, session: Session, cols: u16, rows: u16, output: Channel<InvokeResponseBody>) -> R<TermId> {
    // register the channel before anything can print: open() picks the id, so hold output until then
    let id = app.core.open(session, Size { cols, rows }).map_err(errx)?;
    app.sink.attach(id, output);
    Ok(id)
}

#[tauri::command]
async fn term_duplicate(app: State<'_, App>, of: TermId, cols: u16, rows: u16, output: Channel<InvokeResponseBody>) -> R<TermId> {
    let id = app.core.duplicate(of, Size { cols, rows }).map_err(errx)?;
    app.sink.attach(id, output);
    Ok(id)
}

#[tauri::command]
async fn term_reconnect(app: State<'_, App>, id: TermId, cols: u16, rows: u16) -> R<()> {
    app.core.reconnect(id, Size { cols, rows }).map_err(errx)
}

#[tauri::command]
fn term_write(app: State<'_, App>, id: TermId, data: String) -> R<()> {
    app.core.write(id, data.as_bytes()).map_err(errx)
}

#[tauri::command]
fn term_write_many(app: State<'_, App>, ids: Vec<TermId>, data: String) {
    app.core.write_many(&ids, data.as_bytes());
}

#[tauri::command]
fn term_resize(app: State<'_, App>, id: TermId, cols: u16, rows: u16) -> R<()> {
    app.core.resize(id, Size { cols, rows }).map_err(errx)
}

#[tauri::command]
async fn term_close(app: State<'_, App>, id: TermId) -> R<()> {
    app.sink.detach(id);
    app.core.close(id).await;
    Ok(())
}

#[tauri::command]
async fn remote_cwd(app: State<'_, App>, id: TermId) -> R<Option<String>> {
    Ok(app.core.remote_cwd(id).await)
}

#[tauri::command]
fn answer(app: State<'_, App>, id: u64, answer: Option<Answer>) {
    app.core.answer(id, answer);
}

#[tauri::command]
async fn stats(app: State<'_, App>, id: TermId, prev: Option<(u64, u64)>) -> R<(tether_core::stats::Stats, (u64, u64))> {
    app.core.stats(id, prev).await.map_err(errx)
}

#[tauri::command]
async fn vnc_bridge(app: State<'_, App>, id: TermId) -> R<tether_core::vnc::Bridge> {
    app.core.vnc_bridge(id).await.map_err(errx)
}

// ---------------------------------------------------------------- files

#[tauri::command]
async fn sftp_list(app: State<'_, App>, id: TermId, path: String) -> R<(String, Vec<tether_core::sftp::Entry>)> {
    app.core.sftp_list(id, &path).await.map_err(errx)
}

#[tauri::command]
async fn sftp_mkdir(app: State<'_, App>, id: TermId, path: String) -> R<()> {
    app.core.sftp_mkdir(id, &path).await.map_err(errx)
}

#[tauri::command]
async fn sftp_touch(app: State<'_, App>, id: TermId, path: String) -> R<()> {
    app.core.sftp_touch(id, &path).await.map_err(errx)
}

#[tauri::command]
async fn sftp_rename(app: State<'_, App>, id: TermId, from: String, to: String) -> R<()> {
    app.core.sftp_rename(id, &from, &to).await.map_err(errx)
}

#[tauri::command]
async fn sftp_chmod(app: State<'_, App>, id: TermId, path: String, mode: u32) -> R<()> {
    app.core.sftp_chmod(id, &path, mode).await.map_err(errx)
}

#[tauri::command]
async fn sftp_remove(app: State<'_, App>, id: TermId, paths: Vec<String>) -> R<()> {
    app.core.sftp_remove(id, &paths).await.map_err(errx)
}

#[tauri::command]
async fn sftp_read_text(app: State<'_, App>, id: TermId, path: String) -> R<String> {
    app.core.sftp_read_text(id, &path, 256 * 1024).await.map_err(errx)
}

#[tauri::command]
async fn sftp_download(app: State<'_, App>, id: TermId, paths: Vec<String>, dir: Option<String>) -> R<Uuid> {
    let dir = dir.map(PathBuf::from).unwrap_or_else(|| download_dir(&app.core.store.settings()));
    Ok(app.core.sftp_download(id, paths, dir))
}

#[tauri::command]
async fn sftp_upload(app: State<'_, App>, id: TermId, paths: Vec<String>, dir: String) -> R<Uuid> {
    Ok(app.core.sftp_upload(id, paths.into_iter().map(PathBuf::from).collect(), dir))
}

#[tauri::command]
fn cancel_transfer(app: State<'_, App>, transfer: Uuid) {
    app.core.cancel_transfer(transfer);
}

/// Open a remote file in the user's own editor; saving uploads it again.
#[tauri::command]
async fn sftp_edit(handle: AppHandle, app: State<'_, App>, id: TermId, path: String) -> R<String> {
    let local = app.core.sftp_edit(id, path).await.map_err(errx)?;
    handle.opener().open_path(local.to_string_lossy(), None::<&str>).map_err(err)?;
    Ok(local.to_string_lossy().into_owned())
}

/// Show a finished download (only inside the download folder).
#[tauri::command]
fn reveal(handle: AppHandle, app: State<'_, App>, path: String) -> R<()> {
    let p = PathBuf::from(&path);
    let base = download_dir(&app.core.store.settings());
    if !p.starts_with(&base) {
        return Err("only downloads can be shown".into());
    }
    handle.opener().reveal_item_in_dir(&p).map_err(err)
}

// ---------------------------------------------------------------- tunnels

#[tauri::command]
async fn tunnel_start(app: State<'_, App>, tunnel: Tunnel) -> R<()> {
    app.core.start_tunnel(tunnel).map_err(errx)
}

#[tauri::command]
async fn tunnel_stop(app: State<'_, App>, id: Uuid) -> R<()> {
    app.core.stop_tunnel(id);
    Ok(())
}

// ---------------------------------------------------------------- misc

#[tauri::command]
fn serial_ports() -> Vec<tether_core::serial::PortInfo> {
    tether_core::serial::ports()
}

#[tauri::command]
fn import(kind: String, path: Option<String>) -> R<tether_core::import::Imported> {
    Ok(match kind.as_str() {
        "ssh" => tether_core::import::ssh_config(&path.map(PathBuf::from).unwrap_or_else(|| tether_core::ssh::ssh_dir().join("config"))),
        "mobaxterm" => tether_core::import::mobaxterm(&PathBuf::from(path.ok_or("pick a file")?)),
        "putty" => tether_core::import::putty(),
        _ => return Err("unknown import".into()),
    })
}

#[tauri::command]
fn system_theme() -> Option<tether_core::theme::TerminalTheme> {
    tether_core::theme::system_theme()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("TETHER_LOG").unwrap_or_else(|_| "warn".into()))
        .init();

    *LAUNCH_URL.lock() = std::env::args().skip(1).find(|a| a.contains("://"));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            // a second launch (e.g. an ssh:// link) goes to the running window
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(url) = argv.iter().skip(1).find(|a| a.contains("://")) {
                let _ = app.emit("tether-open", url.clone());
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("tether"));
            let store = Store::new(dir)?;
            let sink = Arc::new(UiSink { app: app.handle().clone(), channels: Mutex::default(), early: Mutex::default() });
            // Core spawns tokio tasks: enter Tauri's runtime for setup-time work
            let core = tauri::async_runtime::block_on(async {
                let core = Core::new(sink.clone(), store);
                core.watch_system_theme();
                core.autostart_tunnels();
                core
            });
            app.manage(App { core, sink });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.state::<App>();
                let core = app.core.clone();
                tauri::async_runtime::block_on(core.shutdown());
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            save_sessions,
            save_tunnels,
            save_snippets,
            save_settings,
            set_password,
            has_password,
            term_open,
            term_duplicate,
            term_reconnect,
            term_write,
            term_write_many,
            term_resize,
            term_close,
            remote_cwd,
            answer,
            stats,
            vnc_bridge,
            sftp_list,
            sftp_mkdir,
            sftp_touch,
            sftp_rename,
            sftp_chmod,
            sftp_remove,
            sftp_read_text,
            sftp_download,
            sftp_upload,
            cancel_transfer,
            sftp_edit,
            reveal,
            tunnel_start,
            tunnel_stop,
            serial_ports,
            import,
            system_theme,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tether");
}

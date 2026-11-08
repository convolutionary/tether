//! RDP opens in the system's own client (mstsc on Windows, FreeRDP on Linux), optionally through
//! an SSH session; the tab shows its state and can reconnect or close it.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};

use crate::model::{Forward, ForwardKind};
use crate::term::{Io, Term};
use crate::{Core, Event};

impl Core {
    pub(crate) async fn run_rdp(self: &Arc<Self>, term: Arc<Term>) -> Result<()> {
        let s = term.session.clone();
        let (mut host, mut port) = (s.host.clone(), s.port_or_default());

        if let Some(via) = s.jump {
            let mut via = self.session(via).ok_or_else(|| anyhow!("the SSH session to go through was deleted"))?;
            via.forwards.clear();
            let core = self.clone();
            let id = term.id;
            let status = move |text: String| core.emit(Event::Status { term: id, text });
            let core2 = self.clone();
            let resolve = move |sid: uuid::Uuid| core2.session(sid);
            let opts = crate::ssh::ConnectOpts { term: Some(term.id), status: &status, resolve: &resolve, depth: 0 };
            let conn = crate::ssh::connect(self.prompter.clone(), &via, &opts).await?;
            let local = crate::tunnel::free_port()?;
            let f = Forward { kind: ForwardKind::Local, bind: "127.0.0.1".into(), port: local, host: host.clone(), host_port: port };
            let h = crate::tunnel::start_forward(conn.clone(), f, None, self.sink.clone()).await?;
            term.forwards.lock().push(h);
            *term.conn.lock() = Some(conn);
            host = "127.0.0.1".into();
            port = local;
        }

        let password = if s.save_password { crate::secrets::get(s.id) } else { None };
        self.emit(Event::Status { term: term.id, text: format!("Opening {}…", s.target()) });
        let child = launch(&host, port, &s.user, &s.domain, password.as_deref(), &s.rdp_args)?;
        *term.io.lock() = Io::Viewer(parking_lot::Mutex::new(Some(child)));
        self.emit(Event::Ready { term: term.id, remote: None });

        // report when the window closes
        let core = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let code = {
                    let io = term.io.lock();
                    let Io::Viewer(child) = &*io else { return };
                    let mut c = child.lock();
                    match c.as_mut().map(|c| c.try_wait()) {
                        Some(Ok(Some(st))) => Some(st.code()),
                        Some(Ok(None)) => None,
                        _ => Some(None),
                    }
                };
                if let Some(code) = code {
                    core.emit(Event::ViewerExit { term: term.id, code });
                    return;
                }
            }
        });
        Ok(())
    }
}

#[cfg(windows)]
fn launch(host: &str, port: u16, user: &str, domain: &str, password: Option<&str>, extra: &str) -> Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x0800_0000;
    let target = format!("{host}:{port}");
    if let Some(pw) = password {
        let who = if domain.is_empty() { user.to_string() } else { format!("{domain}\\{user}") };
        // mstsc reads saved credentials for TERMSRV/<host>
        let _ = Command::new("cmdkey")
            .args([format!("/generic:TERMSRV/{host}"), format!("/user:{who}"), format!("/pass:{pw}")])
            .creation_flags(NO_WINDOW)
            .status();
    }
    let mut cmd = Command::new("mstsc");
    cmd.arg(format!("/v:{target}"));
    cmd.args(crate::pty::shell_words(extra));
    cmd.spawn().context("couldn't start mstsc")
}

#[cfg(not(windows))]
fn launch(host: &str, port: u16, user: &str, domain: &str, password: Option<&str>, extra: &str) -> Result<std::process::Child> {
    let candidates = ["sdl-freerdp3", "xfreerdp3", "wlfreerdp3", "sdl-freerdp", "xfreerdp", "wlfreerdp"];
    let Some(bin) = candidates.iter().find(|b| which(b)) else {
        if which("remmina") {
            let url = if user.is_empty() { format!("rdp://{host}:{port}") } else { format!("rdp://{user}@{host}:{port}") };
            return Command::new("remmina").args(["-c", &url]).spawn().context("couldn't start Remmina");
        }
        bail!("no RDP client found. Install FreeRDP (Debian: sudo apt install freerdp3-sdl)");
    };
    let mut cmd = Command::new(bin);
    cmd.arg(format!("/v:{host}:{port}"));
    if !user.is_empty() {
        cmd.arg(format!("/u:{user}"));
    }
    if !domain.is_empty() {
        cmd.arg(format!("/d:{domain}"));
    }
    cmd.args(["/dynamic-resolution", "+clipboard", "/cert:tofu", "/sound", "/microphone"]);
    cmd.args(crate::pty::shell_words(extra));
    if password.is_some() {
        cmd.arg("/from-stdin:force");
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn().with_context(|| format!("couldn't start {bin}"))?;
    if let (Some(pw), Some(mut stdin)) = (password, child.stdin.take()) {
        // /from-stdin asks for whatever is missing: only the password here
        let _ = writeln!(stdin, "{pw}");
    }
    Ok(child)
}

#[cfg(not(windows))]
pub fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}

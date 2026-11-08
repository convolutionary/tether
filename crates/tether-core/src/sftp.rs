//! The files side of an SSH tab: browse, transfer (with progress and cancel), rename, delete,
//! permissions, and edit-in-place (download, open locally, upload again on every save).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, anyhow, bail};
use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

use crate::{Core, Event, TermId};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: Kind,
    pub size: u64,
    /// unix seconds
    pub modified: Option<u64>,
    /// rwx bits, e.g. 0o644
    pub mode: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
    /// for symlinks: what it points at is a directory
    pub link_dir: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Dir,
    File,
    Link,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub id: Uuid,
    pub term: TermId,
    pub direction: Direction,
    /// what's being moved ("photo.jpg", "3 items")
    pub label: String,
    pub done: u64,
    pub total: u64,
    pub state: TransferState,
    pub error: Option<String>,
    /// where it ended up (download: local path)
    pub dest: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Download,
    Upload,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Default)]
pub(crate) struct Transfers {
    cancel: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

pub fn parent(path: &str) -> String {
    match path.trim_end_matches('/').rsplit_once('/') {
        Some(("", _)) | None => "/".into(),
        Some((p, _)) => p.into(),
    }
}

fn kind_of(a: &FileAttributes) -> Kind {
    if a.is_dir() {
        Kind::Dir
    } else if a.is_symlink() {
        Kind::Link
    } else if a.is_regular() {
        Kind::File
    } else {
        Kind::Other
    }
}

impl Core {
    async fn sftp_of(&self, term: TermId) -> Result<Arc<SftpSession>> {
        let t = self.term(term)?;
        let conn = t.conn().ok_or_else(|| anyhow!("not connected"))?;
        conn.sftp().await
    }

    pub async fn sftp_home(&self, term: TermId) -> Result<String> {
        Ok(self.sftp_of(term).await?.canonicalize(".").await?)
    }

    pub async fn sftp_list(&self, term: TermId, path: &str) -> Result<(String, Vec<Entry>)> {
        let sftp = self.sftp_of(term).await?;
        let path = sftp.canonicalize(if path.is_empty() { "." } else { path }).await.with_context(|| format!("{path} doesn't exist"))?;
        let mut out = Vec::new();
        for e in sftp.read_dir(&path).await.with_context(|| format!("can't open {path}"))? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let m = e.metadata();
            let full = join(&path, &name);
            let kind = kind_of(&m);
            let link_dir = kind == Kind::Link && sftp.metadata(&full).await.map(|t| t.is_dir()).unwrap_or(false);
            out.push(Entry {
                name,
                path: full,
                kind,
                size: m.size.unwrap_or(0),
                modified: m.mtime.map(|t| t as u64),
                mode: m.permissions.map(|p| p & 0o7777),
                owner: m.user.clone().or(m.uid.map(|u| u.to_string())),
                group: m.group.clone().or(m.gid.map(|g| g.to_string())),
                link_dir,
            });
        }
        out.sort_by(|a, b| {
            let ad = a.kind == Kind::Dir || a.link_dir;
            let bd = b.kind == Kind::Dir || b.link_dir;
            bd.cmp(&ad).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok((path, out))
    }

    pub async fn sftp_mkdir(&self, term: TermId, path: &str) -> Result<()> {
        Ok(self.sftp_of(term).await?.create_dir(path).await?)
    }

    pub async fn sftp_touch(&self, term: TermId, path: &str) -> Result<()> {
        let sftp = self.sftp_of(term).await?;
        if sftp.try_exists(path).await.unwrap_or(false) {
            bail!("{path} already exists");
        }
        let f = sftp.create(path).await?;
        f.close().await?;
        Ok(())
    }

    pub async fn sftp_rename(&self, term: TermId, from: &str, to: &str) -> Result<()> {
        Ok(self.sftp_of(term).await?.rename(from, to).await?)
    }

    pub async fn sftp_chmod(&self, term: TermId, path: &str, mode: u32) -> Result<()> {
        let sftp = self.sftp_of(term).await?;
        let attrs = FileAttributes { permissions: Some(mode & 0o7777), ..FileAttributes::empty() };
        Ok(sftp.set_metadata(path, attrs).await?)
    }

    /// Delete files and folders (folders with everything in them).
    pub async fn sftp_remove(&self, term: TermId, paths: &[String]) -> Result<()> {
        let sftp = self.sftp_of(term).await?;
        for p in paths {
            remove_tree(&sftp, p).await?;
        }
        Ok(())
    }

    /// Read a small text file (preview / quick look).
    pub async fn sftp_read_text(&self, term: TermId, path: &str, max: u64) -> Result<String> {
        let sftp = self.sftp_of(term).await?;
        let mut f = sftp.open(path).await?;
        let mut buf = Vec::new();
        (&mut f).take(max).read_to_end(&mut buf).await?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    pub fn cancel_transfer(&self, id: Uuid) {
        if let Some(c) = self.transfers().cancel.lock().get(&id) {
            c.store(true, Ordering::Relaxed);
        }
    }

    fn transfers(&self) -> &Transfers {
        &self.transfers
    }

    /// Download files/folders into a local folder. Returns the transfer id at once.
    pub fn sftp_download(self: &Arc<Self>, term: TermId, remote: Vec<String>, local_dir: PathBuf) -> Uuid {
        let id = Uuid::new_v4();
        let cancel = Arc::new(AtomicBool::new(false));
        self.transfers().cancel.lock().insert(id, cancel.clone());
        let core = self.clone();
        tokio::spawn(async move {
            let label = label_of(remote.iter().map(|r| r.rsplit('/').next().unwrap_or(r).to_string()).collect());
            let mut p = Progress::new(core.clone(), id, term, Direction::Download, label, local_dir.to_string_lossy().into());
            let res = async {
                let sftp = core.sftp_of(term).await?;
                // plan: every file with its size, so progress is honest
                let mut plan = Vec::new();
                for r in &remote {
                    let name = r.trim_end_matches('/').rsplit('/').next().unwrap_or("download").to_string();
                    plan_remote(&sftp, r, local_dir.join(&name), &mut plan).await?;
                }
                p.total = plan.iter().map(|(_, _, s)| s).sum();
                if plan.len() == 1 {
                    p.dest = plan[0].1.to_string_lossy().into();
                } else if remote.len() == 1 {
                    p.dest = local_dir.join(remote[0].trim_end_matches('/').rsplit('/').next().unwrap_or("")).to_string_lossy().into();
                }
                for (src, dst, _) in plan {
                    if let Some(dir) = dst.parent() {
                        tokio::fs::create_dir_all(dir).await?;
                    }
                    let dst = unique_path(dst);
                    let mut rf = sftp.open(&src).await.with_context(|| format!("can't read {src}"))?;
                    let mut lf = tokio::fs::File::create(&dst).await.with_context(|| format!("can't write {}", dst.display()))?;
                    let mut buf = vec![0u8; 256 * 1024];
                    loop {
                        if cancel.load(Ordering::Relaxed) {
                            drop(lf);
                            let _ = tokio::fs::remove_file(&dst).await;
                            return Err(anyhow!("cancelled"));
                        }
                        let n = rf.read(&mut buf).await?;
                        if n == 0 {
                            break;
                        }
                        lf.write_all(&buf[..n]).await?;
                        p.add(n as u64);
                    }
                    lf.flush().await?;
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            p.finish(res, &cancel);
            core.transfers().cancel.lock().remove(&id);
        });
        id
    }

    /// Upload local files/folders into a remote folder.
    pub fn sftp_upload(self: &Arc<Self>, term: TermId, local: Vec<PathBuf>, remote_dir: String) -> Uuid {
        let id = Uuid::new_v4();
        let cancel = Arc::new(AtomicBool::new(false));
        self.transfers().cancel.lock().insert(id, cancel.clone());
        let core = self.clone();
        tokio::spawn(async move {
            let label = label_of(local.iter().map(|l| l.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).collect());
            let mut p = Progress::new(core.clone(), id, term, Direction::Upload, label, remote_dir.clone());
            let res = async {
                let sftp = core.sftp_of(term).await?;
                let mut plan = Vec::new();
                let mut dirs = Vec::new();
                for l in &local {
                    let name = l.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    plan_local(l, join(&remote_dir, &name), &mut plan, &mut dirs)?;
                }
                p.total = plan.iter().map(|(_, _, s)| s).sum();
                for d in dirs {
                    if !sftp.try_exists(&d).await.unwrap_or(false) {
                        sftp.create_dir(&d).await.with_context(|| format!("can't create {d}"))?;
                    }
                }
                for (src, dst, _) in plan {
                    let mut lf = tokio::fs::File::open(&src).await.with_context(|| format!("can't read {}", src.display()))?;
                    let mut rf = sftp
                        .open_with_flags(&dst, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
                        .await
                        .with_context(|| format!("can't write {dst}"))?;
                    let mut buf = vec![0u8; 256 * 1024];
                    loop {
                        if cancel.load(Ordering::Relaxed) {
                            drop(rf);
                            let _ = sftp.remove_file(&dst).await;
                            return Err(anyhow!("cancelled"));
                        }
                        let n = lf.read(&mut buf).await?;
                        if n == 0 {
                            break;
                        }
                        rf.write_all(&buf[..n]).await?;
                        p.add(n as u64);
                    }
                    rf.shutdown().await?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if let Ok(m) = std::fs::metadata(&src) {
                            let attrs = FileAttributes { permissions: Some(m.permissions().mode() & 0o777), ..FileAttributes::empty() };
                            let _ = sftp.set_metadata(&dst, attrs).await;
                        }
                    }
                }
                Ok::<_, anyhow::Error>(())
            }
            .await;
            p.finish(res, &cancel);
            core.transfers().cancel.lock().remove(&id);
        });
        id
    }

    /// Download a remote file to a private temp folder, then upload it again whenever it's saved.
    /// Returns the local path for the UI to open in the user's editor.
    pub async fn sftp_edit(self: &Arc<Self>, term: TermId, remote: String) -> Result<PathBuf> {
        let sftp = self.sftp_of(term).await?;
        let name = remote.rsplit('/').next().unwrap_or("file").to_string();
        let dir = std::env::temp_dir().join("tether-edit").join(Uuid::new_v4().simple().to_string());
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir.parent().unwrap_or(&dir), std::fs::Permissions::from_mode(0o700));
        }
        let local = dir.join(&name);
        let data = sftp.read(&remote).await.with_context(|| format!("can't read {remote}"))?;
        std::fs::write(&local, &data)?;

        let core = self.clone();
        let watch = local.clone();
        tokio::spawn(async move {
            let mut last = mtime(&watch);
            let started = Instant::now();
            loop {
                tokio::time::sleep(Duration::from_millis(700)).await;
                // stop when the tab is gone, or after a day
                let Ok(t) = core.term(term) else { break };
                if t.conn().is_none_or(|c| c.is_closed()) || started.elapsed() > Duration::from_secs(86_400) {
                    break;
                }
                let now = mtime(&watch);
                if now.is_none() || now == last {
                    continue;
                }
                last = now;
                // editors often write in several steps: wait for quiet
                tokio::time::sleep(Duration::from_millis(250)).await;
                let res = async {
                    let bytes = tokio::fs::read(&watch).await?;
                    let sftp = core.sftp_of(term).await?;
                    sftp.write(&remote, &bytes).await.map_err(anyhow::Error::from)?;
                    Ok::<_, anyhow::Error>(())
                }
                .await;
                core.emit(Event::EditSynced { term, path: remote.clone(), error: res.err().map(|e| format!("{e:#}")) });
            }
            let _ = std::fs::remove_dir_all(watch.parent().unwrap_or(&watch));
        });
        Ok(local)
    }
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn label_of(names: Vec<String>) -> String {
    match names.len() {
        0 => "nothing".into(),
        1 => names[0].clone(),
        n => format!("{n} items"),
    }
}

/// "name.txt" -> "name (1).txt" when it already exists
fn unique_path(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = p.parent().map(Path::to_path_buf).unwrap_or_default();
    for i in 1.. {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    p
}

fn plan_remote<'a>(
    sftp: &'a SftpSession,
    src: &'a str,
    dst: PathBuf,
    out: &'a mut Vec<(String, PathBuf, u64)>,
) -> futures::future::BoxFuture<'a, Result<()>> {
    Box::pin(async move {
        let m = sftp.metadata(src).await.with_context(|| format!("{src} is gone"))?;
        if m.is_dir() {
            std::fs::create_dir_all(&dst).ok();
            for e in sftp.read_dir(src).await? {
                let n = e.file_name();
                if n == "." || n == ".." {
                    continue;
                }
                plan_remote(sftp, &join(src, &n), dst.join(&n), out).await?;
            }
        } else {
            out.push((src.to_string(), dst, m.size.unwrap_or(0)));
        }
        Ok(())
    })
}

fn plan_local(src: &Path, dst: String, out: &mut Vec<(PathBuf, String, u64)>, dirs: &mut Vec<String>) -> Result<()> {
    let m = std::fs::metadata(src).with_context(|| format!("{} is gone", src.display()))?;
    if m.is_dir() {
        dirs.push(dst.clone());
        for e in std::fs::read_dir(src)? {
            let e = e?;
            plan_local(&e.path(), join(&dst, &e.file_name().to_string_lossy()), out, dirs)?;
        }
    } else {
        out.push((src.to_path_buf(), dst, m.len()));
    }
    Ok(())
}

fn remove_tree<'a>(sftp: &'a SftpSession, path: &'a str) -> futures::future::BoxFuture<'a, Result<()>> {
    Box::pin(async move {
        let m = sftp.symlink_metadata(path).await.with_context(|| format!("{path} is gone"))?;
        if m.is_dir() {
            for e in sftp.read_dir(path).await? {
                let n = e.file_name();
                if n == "." || n == ".." {
                    continue;
                }
                remove_tree(sftp, &join(path, &n)).await?;
            }
            sftp.remove_dir(path).await.with_context(|| format!("can't delete {path}"))?;
        } else {
            sftp.remove_file(path).await.with_context(|| format!("can't delete {path}"))?;
        }
        Ok(())
    })
}

struct Progress {
    core: Arc<Core>,
    ev: TransferEvent,
    total: u64,
    dest: String,
    last: Instant,
}

impl Progress {
    fn new(core: Arc<Core>, id: Uuid, term: TermId, direction: Direction, label: String, dest: String) -> Self {
        let ev = TransferEvent { id, term, direction, label, done: 0, total: 0, state: TransferState::Running, error: None, dest: dest.clone() };
        core.emit(Event::Transfer(ev.clone()));
        Progress { core, ev, total: 0, dest, last: Instant::now() }
    }

    fn add(&mut self, n: u64) {
        self.ev.done += n;
        if self.last.elapsed() > Duration::from_millis(120) {
            self.last = Instant::now();
            self.ev.total = self.total;
            self.core.emit(Event::Transfer(self.ev.clone()));
        }
    }

    fn finish(mut self, res: Result<()>, cancel: &AtomicBool) {
        self.ev.total = self.total;
        self.ev.dest = self.dest.clone();
        self.ev.state = match &res {
            Ok(()) => TransferState::Done,
            Err(_) if cancel.load(Ordering::Relaxed) => TransferState::Cancelled,
            Err(_) => TransferState::Failed,
        };
        if self.ev.state == TransferState::Failed {
            self.ev.error = res.err().map(|e| format!("{e:#}"));
        }
        self.core.emit(Event::Transfer(self.ev.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/etc", "hosts"), "/etc/hosts");
        assert_eq!(parent("/etc/hosts"), "/etc");
        assert_eq!(parent("/etc"), "/");
        assert_eq!(parent("/"), "/");
    }
}

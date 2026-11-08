//! A tab's terminal, whatever it's connected to.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use parking_lot::Mutex;
use russh::ChannelMsg;
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::model::{Protocol, Session};
use crate::ssh::{self, Conn, ConnectOpts};
use crate::{Core, Event, RemoteInfo, TermId, pty, serial, telnet};

/// Our marker the remote shell prints once with its PID, then is removed from the output:
/// ESC ] 6973 ; <pid> BEL. The PID lets the SFTP panel follow the shell's working folder.
const PID_MARK: &[u8] = b"\x1b]6973;";

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

pub(crate) enum Io {
    Pty(pty::Pty),
    Ssh { tx: mpsc::UnboundedSender<SshCmd> },
    Telnet(telnet::Telnet),
    Serial(serial::Serial),
    /// not a terminal: an RDP client window we launched
    Viewer(Mutex<Option<std::process::Child>>),
    /// not a terminal: SFTP-only / VNC tabs (state lives elsewhere)
    None,
}

pub(crate) enum SshCmd {
    Data(Vec<u8>),
    Resize(Size),
    Close,
}

pub struct Term {
    pub id: TermId,
    pub session: Session,
    pub(crate) io: Mutex<Io>,
    pub conn: Mutex<Option<Arc<Conn>>>,
    /// remote shell PID (ssh, Unix servers)
    pub(crate) shell_pid: Mutex<Option<u32>>,
    /// local listeners for the session's own forwards, stopped with the tab
    pub(crate) forwards: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pub(crate) log: Mutex<Option<std::fs::File>>,
}

impl Term {
    fn new(id: TermId, session: Session) -> Arc<Term> {
        Arc::new(Term {
            id,
            session,
            io: Mutex::new(Io::None),
            conn: Mutex::new(None),
            shell_pid: Mutex::new(None),
            forwards: Mutex::new(Vec::new()),
            log: Mutex::new(None),
        })
    }

    pub fn conn(&self) -> Option<Arc<Conn>> {
        self.conn.lock().clone()
    }

    pub fn write(&self, data: &[u8]) {
        match &*self.io.lock() {
            Io::Pty(p) => p.write(data),
            Io::Ssh { tx } => {
                let _ = tx.send(SshCmd::Data(data.to_vec()));
            }
            Io::Telnet(t) => t.write(data),
            Io::Serial(s) => s.write(data),
            _ => {}
        }
    }

    pub fn resize(&self, size: Size) {
        if size.cols == 0 || size.rows == 0 {
            return;
        }
        match &*self.io.lock() {
            Io::Pty(p) => p.resize(size),
            Io::Ssh { tx } => {
                let _ = tx.send(SshCmd::Resize(size));
            }
            Io::Telnet(t) => t.resize(size),
            _ => {}
        }
    }

    pub async fn close(&self) {
        let io = std::mem::replace(&mut *self.io.lock(), Io::None);
        match io {
            Io::Pty(p) => p.kill(),
            Io::Ssh { tx } => {
                let _ = tx.send(SshCmd::Close);
            }
            Io::Telnet(t) => t.close(),
            Io::Serial(s) => s.close(),
            Io::Viewer(child) => {
                if let Some(mut c) = child.lock().take() {
                    let _ = c.kill();
                }
            }
            Io::None => {}
        }
        for h in self.forwards.lock().drain(..) {
            h.abort();
        }
        let conn = self.conn.lock().take();
        if let Some(c) = conn {
            c.close().await;
        }
    }

    fn log(&self, data: &[u8]) {
        if let Some(f) = self.log.lock().as_mut() {
            use std::io::Write;
            let _ = f.write_all(data);
        }
    }
}

impl Core {
    /// Open a tab for a session. Returns at once; progress and output arrive as events.
    pub fn open(self: &Arc<Self>, session: Session, size: Size) -> Result<TermId> {
        let id = self.next_id();
        self.open_as(id, session, size)?;
        Ok(id)
    }

    fn open_as(self: &Arc<Self>, id: TermId, session: Session, size: Size) -> Result<()> {
        let term = Term::new(id, session.clone());
        if session.log && matches!(session.protocol, Protocol::Ssh | Protocol::Local | Protocol::Telnet | Protocol::Serial | Protocol::Mosh) {
            *term.log.lock() = open_log(&self.store, &session);
        }
        self.terms.lock().insert(id, term.clone());
        if !session.id.is_nil() {
            self.touch(session.id);
        }
        let core = self.clone();
        match session.protocol {
            Protocol::Local | Protocol::Mosh => {
                let sink = self.sink.clone();
                let t2 = term.clone();
                let on_out = move |d: &[u8]| {
                    t2.log(d);
                    sink.output(id, d)
                };
                let core2 = core.clone();
                let on_exit = move |code: Option<i32>| {
                    core2.emit(Event::Exit { term: id, code, reason: String::new() });
                };
                let p = pty::Pty::spawn(&session, size, &self.store.settings().default_shell, on_out, on_exit)?;
                *term.io.lock() = Io::Pty(p);
                self.emit(Event::Ready { term: id, remote: None });
            }
            Protocol::Ssh => {
                tokio::spawn(async move {
                    if let Err(e) = core.run_ssh(term, size).await {
                        core.emit(Event::Exit { term: id, code: None, reason: format!("{e:#}") });
                    }
                });
            }
            Protocol::Sftp => {
                tokio::spawn(async move {
                    match core.connect_for(&term).await {
                        Ok(conn) => {
                            let home = conn.sftp().await.ok();
                            let home = match home {
                                Some(s) => s.canonicalize(".").await.ok(),
                                None => None,
                            };
                            *term.conn.lock() = Some(conn.clone());
                            core.emit(Event::Ready {
                                term: id,
                                remote: Some(RemoteInfo { os: String::new(), home, user: conn.user.clone(), host: term.session.host.clone() }),
                            });
                        }
                        Err(e) => core.emit(Event::Exit { term: id, code: None, reason: format!("{e:#}") }),
                    }
                });
            }
            Protocol::Telnet => {
                tokio::spawn(async move {
                    let sink = core.sink.clone();
                    let t2 = term.clone();
                    let core2 = core.clone();
                    core.emit(Event::Status { term: id, text: format!("Connecting to {}…", term.session.target()) });
                    let res = telnet::Telnet::connect(
                        &term.session,
                        size,
                        move |d: &[u8]| {
                            t2.log(d);
                            sink.output(id, d)
                        },
                        move |reason: String| core2.emit(Event::Exit { term: id, code: None, reason }),
                    )
                    .await;
                    match res {
                        Ok(t) => {
                            *term.io.lock() = Io::Telnet(t);
                            core.emit(Event::Ready { term: id, remote: None });
                        }
                        Err(e) => core.emit(Event::Exit { term: id, code: None, reason: format!("{e:#}") }),
                    }
                });
            }
            Protocol::Serial => {
                let sink = self.sink.clone();
                let t2 = term.clone();
                let core2 = core.clone();
                let s = serial::Serial::open(
                    &session,
                    move |d: &[u8]| {
                        t2.log(d);
                        sink.output(id, d)
                    },
                    move |reason: String| core2.emit(Event::Exit { term: id, code: None, reason }),
                )?;
                *term.io.lock() = Io::Serial(s);
                self.emit(Event::Ready { term: id, remote: None });
            }
            Protocol::Rdp => {
                tokio::spawn(async move {
                    if let Err(e) = core.run_rdp(term).await {
                        core.emit(Event::Exit { term: id, code: None, reason: format!("{e:#}") });
                    }
                });
            }
            Protocol::Vnc => {
                // the UI asks for a bridge (Core::vnc_bridge) once the tab exists
            }
        }
        Ok(())
    }

    /// A new tab on the same server, reusing the tab's login (no second password or 2FA prompt).
    pub fn duplicate(self: &Arc<Self>, of: TermId, size: Size) -> Result<TermId> {
        let src = self.term(of)?;
        let conn = src.conn().filter(|c| !c.is_closed());
        let Some(conn) = conn else {
            return self.open(src.session.clone(), size);
        };
        let id = self.next_id();
        let term = Term::new(id, src.session.clone());
        self.terms.lock().insert(id, term.clone());
        let core = self.clone();
        tokio::spawn(async move {
            *term.conn.lock() = Some(conn.clone());
            if let Err(e) = core.start_shell(&term, conn, size, false).await {
                core.emit(Event::Exit { term: id, code: None, reason: format!("{e:#}") });
            }
        });
        Ok(id)
    }

    pub fn write(&self, term: TermId, data: &[u8]) -> Result<()> {
        self.term(term)?.write(data);
        Ok(())
    }

    /// Type into several tabs at once (multi-exec).
    pub fn write_many(&self, terms: &[TermId], data: &[u8]) {
        let map = self.terms.lock();
        for t in terms {
            if let Some(t) = map.get(t) {
                t.write(data);
            }
        }
    }

    pub fn resize(&self, term: TermId, size: Size) -> Result<()> {
        self.term(term)?.resize(size);
        Ok(())
    }

    pub async fn close(&self, term: TermId) {
        let t = self.terms.lock().remove(&term);
        if let Some(t) = t {
            t.close().await;
        }
    }

    /// Reconnect a tab whose connection ended: same tab, fresh connection.
    pub fn reconnect(self: &Arc<Self>, term: TermId, size: Size) -> Result<()> {
        let old = self.term(term)?;
        let session = old.session.clone();
        let core = self.clone();
        tokio::spawn(async move {
            old.close().await;
            core.terms.lock().remove(&term);
            if let Err(e) = core.open_as(term, session, size) {
                core.emit(Event::Exit { term, code: None, reason: format!("{e:#}") });
            }
        });
        Ok(())
    }

    pub(crate) async fn connect_for(self: &Arc<Self>, term: &Term) -> Result<Arc<Conn>> {
        let core = self.clone();
        let id = term.id;
        let status = move |text: String| core.emit(Event::Status { term: id, text });
        let core2 = self.clone();
        let resolve = move |sid: uuid::Uuid| core2.session(sid);
        let opts = ConnectOpts { term: Some(id), status: &status, resolve: &resolve, depth: 0 };
        ssh::connect(self.prompter.clone(), &term.session, &opts).await
    }

    async fn run_ssh(self: &Arc<Self>, term: Arc<Term>, size: Size) -> Result<()> {
        let conn = self.connect_for(&term).await?;
        *term.conn.lock() = Some(conn.clone());
        // the session's own port forwards live as long as the tab
        for f in &term.session.forwards {
            match crate::tunnel::start_forward(conn.clone(), f.clone(), None, self.sink.clone()).await {
                Ok(h) => term.forwards.lock().push(h),
                Err(e) => self.emit(Event::Status { term: term.id, text: format!("Forward {}: {e:#}", crate::tunnel::describe(f)) }),
            }
        }
        self.start_shell(&term, conn, size, true).await
    }

    async fn start_shell(self: &Arc<Self>, term: &Arc<Term>, conn: Arc<Conn>, size: Size, probe: bool) -> Result<()> {
        let id = term.id;
        let s = &term.session;

        // which OS? (decides whether we can follow the shell's folder and show stats)
        if probe || conn.os.lock().is_empty() {
            let os = match conn.exec("uname -s", Duration::from_secs(4)).await {
                Ok((Some(0), out)) => out.trim().to_string(),
                _ => String::new(),
            };
            *conn.os.lock() = os;
        }
        let os = conn.os.lock().clone();
        let unix = matches!(os.as_str(), "Linux" | "Darwin" | "FreeBSD" | "OpenBSD" | "NetBSD" | "SunOS" | "DragonFly");

        let ch = conn.handle.channel_open_session().await?;
        if s.x11 {
            let (proto, cookie) = ssh::x11_cookie();
            let _ = ch.request_x11(false, false, proto, cookie, 0).await;
        }
        if s.agent_forward {
            let _ = ch.agent_forward(false).await;
        }
        for (k, v) in &s.env {
            let _ = ch.set_env(false, k.clone(), v.clone()).await;
        }
        let term_type = if s.term_type.is_empty() { "xterm-256color" } else { s.term_type.as_str() };
        ch.request_pty(true, term_type, size.cols as u32, size.rows as u32, 0, 0, &[]).await?;

        let mut strip_pid = false;
        if !s.remote_command.trim().is_empty() {
            ch.exec(true, s.remote_command.clone()).await?;
        } else if unix && s.follow_cwd {
            // same login shell as always, but it tells us its PID first (then hides the marker)
            ch.exec(true, r#"exec sh -c 'printf "\033]6973;%s\007" "$$"; exec "${SHELL:-/bin/sh}" -l'"#).await?;
            strip_pid = true;
        } else {
            ch.request_shell(true).await?;
        }

        let home = match conn.sftp().await {
            Ok(sftp) => sftp.canonicalize(".").await.ok(),
            Err(_) => None,
        };
        self.emit(Event::Ready {
            term: id,
            remote: Some(RemoteInfo { os, home, user: conn.user.clone(), host: s.host.clone() }),
        });

        let (tx, mut rx) = mpsc::unbounded_channel::<SshCmd>();
        *term.io.lock() = Io::Ssh { tx };
        let (mut read, write) = ch.split();

        let sink = self.sink.clone();
        let t = term.clone();
        let core = self.clone();
        tokio::spawn(async move {
            // write side: keystrokes, resizes, close
            let writer = tokio::spawn(async move {
                while let Some(cmd) = rx.recv().await {
                    match cmd {
                        SshCmd::Data(d) => {
                            if write.data_bytes(d).await.is_err() {
                                break;
                            }
                        }
                        SshCmd::Resize(sz) => {
                            let _ = write.window_change(sz.cols as u32, sz.rows as u32, 0, 0).await;
                        }
                        SshCmd::Close => {
                            let _ = write.close().await;
                            break;
                        }
                    }
                }
            });
            let mut pending: Vec<u8> = Vec::new();
            let mut looking = strip_pid;
            let mut code = None;
            let mut signal = None;
            while let Some(msg) = read.wait().await {
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        let mut bytes: &[u8] = &data;
                        let owned;
                        if looking {
                            pending.extend_from_slice(bytes);
                            match take_pid(&pending) {
                                Scan::Found(pid, rest) => {
                                    *t.shell_pid.lock() = Some(pid);
                                    looking = false;
                                    owned = rest;
                                    pending.clear();
                                    bytes = &owned;
                                }
                                Scan::NeedMore if pending.len() < 4096 => continue,
                                _ => {
                                    looking = false;
                                    owned = std::mem::take(&mut pending);
                                    bytes = &owned;
                                }
                            }
                        }
                        if !bytes.is_empty() {
                            t.log(bytes);
                            sink.output(t.id, bytes);
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status as i32),
                    ChannelMsg::ExitSignal { signal_name, error_message, .. } => {
                        signal = Some(format!("{signal_name:?} {error_message}").trim().to_string())
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            writer.abort();
            let reason = match (&signal, conn.is_closed()) {
                (Some(s), _) => format!("ended by signal {s}"),
                (None, true) if code.is_none() => "connection lost".into(),
                _ => String::new(),
            };
            core.emit(Event::Exit { term: t.id, code, reason });
        });
        Ok(())
    }

    /// The remote shell's working folder (for the SFTP panel). None if unknown.
    pub async fn remote_cwd(&self, term: TermId) -> Option<String> {
        let t = self.term(term).ok()?;
        let pid = (*t.shell_pid.lock())?;
        let conn = t.conn()?;
        let os = conn.os.lock().clone();
        if os == "Linux" {
            let sftp = conn.sftp().await.ok()?;
            // the shell may have started a program: follow the deepest foreground child's folder? no —
            // the shell's own folder is what `cd` changes
            return sftp.read_link(format!("/proc/{pid}/cwd")).await.ok();
        }
        let cmd = format!("lsof -a -p {pid} -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'");
        let (_, out) = conn.exec(&cmd, Duration::from_secs(3)).await.ok()?;
        let p = out.trim();
        (!p.is_empty()).then(|| p.to_string())
    }
}

enum Scan {
    Found(u32, Vec<u8>),
    NeedMore,
    NotThere,
}

/// Find and cut out our PID marker.
fn take_pid(buf: &[u8]) -> Scan {
    let Some(start) = find(buf, PID_MARK) else {
        // could the marker begin at the end of what we have?
        let tail = buf.len().saturating_sub(PID_MARK.len());
        return if (tail..buf.len()).any(|i| PID_MARK.starts_with(&buf[i..])) { Scan::NeedMore } else { Scan::NotThere };
    };
    let after = &buf[start + PID_MARK.len()..];
    let Some(end) = after.iter().position(|b| *b == 0x07) else {
        return if after.len() < 12 { Scan::NeedMore } else { Scan::NotThere };
    };
    let Ok(pid) = std::str::from_utf8(&after[..end]).unwrap_or("").parse::<u32>() else {
        return Scan::NotThere;
    };
    let mut rest = buf[..start].to_vec();
    rest.extend_from_slice(&after[end + 1..]);
    Scan::Found(pid, rest)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn open_log(store: &crate::Store, s: &Session) -> Option<std::fs::File> {
    let dir = store.dir().join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let safe: String = s.name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '.' { c } else { '_' }).collect();
    let name = format!("{}-{}.log", if safe.is_empty() { "session".into() } else { safe }, chrono::Local::now().format("%Y%m%d-%H%M%S"));
    std::fs::File::create(dir.join(name)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_marker() {
        match take_pid(b"hello\x1b]6973;4242\x07world") {
            Scan::Found(pid, rest) => {
                assert_eq!(pid, 4242);
                assert_eq!(rest, b"helloworld");
            }
            _ => panic!(),
        }
        assert!(matches!(take_pid(b"abc\x1b]69"), Scan::NeedMore));
        assert!(matches!(take_pid(b"abc\x1b]6973;12"), Scan::NeedMore));
        assert!(matches!(take_pid(b"plain output"), Scan::NotThere));
    }
}

//! SSH connections: host-key checking against ~/.ssh/known_hosts, every common way of logging in
//! (agent, key files, saved or typed passwords, keyboard-interactive/2FA), jump hosts, and the
//! server-initiated channels (remote port forwards, X11, agent forwarding).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use parking_lot::Mutex;
use russh::client::{self, ChannelOpenHandle, Handle, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, MethodKind, MethodSet};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

use crate::model::Session;
use crate::prompt::{Field, PromptKind, Prompter};
use crate::{TermId, secrets};

/// Where remote forwards (-R) land: (server bind address, server port) -> local host:port
pub type RemoteForwards = Arc<Mutex<HashMap<(String, u32), (String, u16)>>>;

#[derive(Clone)]
pub struct X11Target {
    /// unix socket (Linux) or TCP address (Windows X servers: VcXsrv, X410, …)
    pub addr: X11Addr,
}

#[derive(Clone)]
pub enum X11Addr {
    #[cfg(unix)]
    Unix(PathBuf),
    Tcp(String),
}

pub struct Client {
    prompter: Arc<Prompter>,
    term: Option<TermId>,
    host: String,
    port: u16,
    pub(crate) forwards: RemoteForwards,
    x11: Option<X11Target>,
    agent_forward: bool,
    /// set when the user refused the host key, to report that rather than a generic error
    refused: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, key: &keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key: PublicKey = match key {
            keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            keys::PublicKeyOrCertificate::Certificate(c) => PublicKey::new(c.public_key().clone(), ""),
        };
        let path = known_hosts_path();
        let changed = match keys::check_known_hosts_path(&self.host, self.port, &key, &path) {
            Ok(true) => return Ok(true),
            Ok(false) => None,
            Err(keys::Error::KeyChanged { line }) => Some(line),
            Err(e) => {
                tracing::warn!("known_hosts unreadable: {e}");
                None
            }
        };
        let answer = self
            .prompter
            .ask(
                self.term,
                PromptKind::HostKey {
                    host: self.host.clone(),
                    port: self.port,
                    algorithm: key.algorithm().to_string(),
                    fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                    changed: changed.is_some(),
                },
            )
            .await;
        match answer {
            Some(a) => {
                if a.remember {
                    if let Some(line) = changed {
                        let _ = forget_known_host_line(&path, line);
                    }
                    if let Err(e) = keys::known_hosts::learn_known_hosts_path(&self.host, self.port, &key, &path) {
                        tracing::warn!("couldn't record host key: {e}");
                    }
                }
                Ok(true)
            }
            None => {
                *self.refused.lock() = Some(if changed.is_some() {
                    "The server's key has changed and wasn't accepted".into()
                } else {
                    "Host key not accepted".into()
                });
                Ok(false)
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = {
            let map = self.forwards.lock();
            map.get(&(connected_address.to_string(), connected_port))
                .or_else(|| map.iter().find(|((_, p), _)| *p == connected_port).map(|(_, v)| v))
                .cloned()
        };
        let Some((host, port)) = target else {
            drop(reply);
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((host.as_str(), port)).await {
                Ok(mut tcp) => {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                }
                Err(e) => {
                    tracing::warn!("remote forward to {host}:{port}: {e}");
                    let _ = channel.close().await;
                }
            }
        });
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        channel: Channel<Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some(x11) = self.x11.clone() else {
            drop(reply);
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = match x11.addr {
                #[cfg(unix)]
                X11Addr::Unix(path) => match tokio::net::UnixStream::connect(&path).await {
                    Ok(mut s) => tokio::io::copy_bidirectional(&mut s, &mut stream).await.map(|_| ()),
                    Err(e) => Err(e),
                },
                X11Addr::Tcp(addr) => match tokio::net::TcpStream::connect(&addr).await {
                    Ok(mut s) => tokio::io::copy_bidirectional(&mut s, &mut stream).await.map(|_| ()),
                    Err(e) => Err(e),
                },
            };
        });
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if !self.agent_forward {
            drop(reply);
            return Ok(());
        }
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            #[cfg(unix)]
            if let Ok(sock) = std::env::var("SSH_AUTH_SOCK")
                && let Ok(mut agent) = tokio::net::UnixStream::connect(sock).await
            {
                let _ = tokio::io::copy_bidirectional(&mut agent, &mut stream).await;
            }
            #[cfg(windows)]
            if let Ok(mut agent) =
                tokio::net::windows::named_pipe::ClientOptions::new().open(r"\\.\pipe\openssh-ssh-agent")
            {
                let _ = tokio::io::copy_bidirectional(&mut agent, &mut stream).await;
            }
        });
        Ok(())
    }
}

/// An authenticated SSH connection. Terminals, SFTP, stats and forwards open channels on it.
pub struct Conn {
    pub handle: Handle<Client>,
    pub session: Session,
    pub user: String,
    pub forwards: RemoteForwards,
    /// the hop this connection goes through, kept alive as long as we are
    _jump: Option<Arc<Conn>>,
    pub(crate) sftp: AsyncMutex<Option<Arc<russh_sftp::client::SftpSession>>>,
    /// remote OS from `uname -s` ("Linux", "Darwin", …; "" = not a Unix shell)
    pub os: Mutex<String>,
}

impl Conn {
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// Run a command and collect stdout (stats, cwd lookups, probes).
    pub async fn exec(&self, cmd: &str, timeout: Duration) -> Result<(Option<u32>, String)> {
        let fut = async {
            let mut ch = self.handle.channel_open_session().await?;
            ch.exec(true, cmd).await?;
            let mut out = Vec::new();
            let mut code = None;
            while let Some(msg) = ch.wait().await {
                match msg {
                    russh::ChannelMsg::Data { data } => out.extend_from_slice(&data),
                    russh::ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    russh::ChannelMsg::Eof | russh::ChannelMsg::Close => {
                        if code.is_some() || matches!(msg, russh::ChannelMsg::Close) {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            Ok::<_, anyhow::Error>((code, String::from_utf8_lossy(&out).into_owned()))
        };
        tokio::time::timeout(timeout, fut).await.map_err(|_| anyhow!("timed out"))?
    }

    /// The SFTP subsystem, opened once per connection.
    pub async fn sftp(&self) -> Result<Arc<russh_sftp::client::SftpSession>> {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let ch = self.handle.channel_open_session().await?;
        ch.request_subsystem(true, "sftp").await?;
        let s = Arc::new(
            russh_sftp::client::SftpSession::new(ch.into_stream())
                .await
                .context("the server has no SFTP")?,
        );
        *guard = Some(s.clone());
        Ok(s)
    }

    pub async fn close(&self) {
        let _ = self.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
}

pub struct ConnectOpts<'a> {
    pub term: Option<TermId>,
    pub status: &'a (dyn Fn(String) + Send + Sync),
    /// look up saved sessions for jump hosts
    pub resolve: &'a (dyn Fn(uuid::Uuid) -> Option<Session> + Send + Sync),
    pub depth: u8,
}

pub fn connect<'a>(
    prompter: Arc<Prompter>,
    session: &'a Session,
    opts: &'a ConnectOpts<'a>,
) -> futures::future::BoxFuture<'a, Result<Arc<Conn>>> {
    Box::pin(async move {
        if opts.depth > 4 {
            bail!("jump hosts go more than 4 hops deep (is there a loop?)");
        }
        let host = session.host.trim().to_string();
        if host.is_empty() {
            bail!("no host");
        }
        let port = session.port_or_default();

        let mut config = client::Config {
            inactivity_timeout: None,
            keepalive_interval: (session.keepalive_secs > 0).then(|| Duration::from_secs(session.keepalive_secs as u64)),
            keepalive_max: 4,
            nodelay: true,
            ..Default::default()
        };
        if session.compression {
            config.preferred.compression =
                std::borrow::Cow::Borrowed(&[russh::compression::ZLIB, russh::compression::ZLIB_LEGACY, russh::compression::NONE]);
        }
        let config = Arc::new(config);

        let forwards: RemoteForwards = Arc::default();
        let refused = Arc::new(Mutex::new(None));
        let handler = Client {
            prompter: prompter.clone(),
            term: opts.term,
            host: host.clone(),
            port,
            forwards: forwards.clone(),
            x11: if session.x11 { x11_target() } else { None },
            agent_forward: session.agent_forward,
            refused: refused.clone(),
        };

        let (handle, jump) = match session.jump.and_then(|id| (opts.resolve)(id)) {
            Some(jump_session) => {
                (opts.status)(format!("Connecting to {} (jump host)…", jump_session.target()));
                let sub = ConnectOpts { term: opts.term, status: opts.status, resolve: opts.resolve, depth: opts.depth + 1 };
                let jump = connect(prompter.clone(), &jump_session, &sub).await?;
                (opts.status)(format!("Connecting to {host} through {}…", jump_session.target()));
                let ch = jump.handle.channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0).await?;
                let h = client::connect_stream(config, ch.into_stream(), handler).await;
                (h, Some(jump))
            }
            None => {
                (opts.status)(format!("Connecting to {host}:{port}…"));
                let h = tokio::time::timeout(Duration::from_secs(20), client::connect(config, (host.as_str(), port), handler))
                    .await
                    .map_err(|_| anyhow!("{host}:{port} didn't answer within 20 seconds"))?;
                (h, None)
            }
        };
        let mut handle = match handle {
            Ok(h) => h,
            Err(e) => {
                if let Some(msg) = refused.lock().take() {
                    bail!(msg);
                }
                return Err(e).with_context(|| format!("couldn't connect to {host}:{port}"));
            }
        };

        let mut user = session.user.trim().to_string();
        if user.is_empty() {
            let a = prompter
                .ask(opts.term, PromptKind::Username { host: host.clone() })
                .await
                .ok_or_else(|| anyhow!("cancelled"))?;
            user = a.first();
        }
        (opts.status)(format!("Logging in as {user}…"));
        authenticate(&mut handle, &prompter, session, &user, &host, opts.term).await?;

        Ok(Arc::new(Conn {
            handle,
            session: session.clone(),
            user,
            forwards,
            _jump: jump,
            sftp: AsyncMutex::new(None),
            os: Mutex::new(String::new()),
        }))
    })
}

async fn authenticate(
    handle: &mut Handle<Client>,
    prompter: &Prompter,
    session: &Session,
    user: &str,
    host: &str,
    term: Option<TermId>,
) -> Result<()> {
    // what the server says we may still try; starts as "everything"
    let mut allowed: Option<MethodSet> = None;
    let may = |allowed: &Option<MethodSet>, m: MethodKind| allowed.as_ref().is_none_or(|s| s.contains(&m));
    let rsa_hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();

    macro_rules! check {
        ($res:expr) => {
            match $res {
                russh::client::AuthResult::Success => return Ok(()),
                russh::client::AuthResult::Failure { remaining_methods, .. } => {
                    allowed = Some(remaining_methods);
                }
            }
        };
    }

    // 1. an explicit key file (one that isn't there counts as none, so the usual keys still get tried)
    let named = !session.identity.trim().is_empty() && expand_home(session.identity.trim()).exists();
    if named {
        let path = expand_home(session.identity.trim());
        if let Some(key) = load_key(prompter, &path, term).await? {
            check!(handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash)).await?);
        }
    }

    // 2. the SSH agent (ssh-agent / gpg-agent / KeePassXC / 1Password on Linux; Pageant or OpenSSH agent on Windows)
    if may(&allowed, MethodKind::PublicKey)
        && let Some(mut agent) = agent().await
        && let Ok(ids) = agent.request_identities().await
    {
        for id in ids.into_iter().take(8) {
            if !may(&allowed, MethodKind::PublicKey) {
                break;
            }
            let res = handle.authenticate_publickey_with(user, id.public_key().into_owned(), rsa_hash, &mut agent).await;
            match res {
                Ok(r) => check!(r),
                Err(e) => tracing::debug!("agent key refused: {e:?}"),
            }
        }
    }

    // 3. the usual key files, when no key was named (unencrypted ones silently; encrypted ones ask)
    if !named && may(&allowed, MethodKind::PublicKey) {
        for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            let path = ssh_dir().join(name);
            if !path.exists() || !may(&allowed, MethodKind::PublicKey) {
                continue;
            }
            if let Some(key) = load_key(prompter, &path, term).await? {
                check!(handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash)).await?);
            }
        }
    }

    // 4. a saved password
    let saved = if session.save_password { secrets::get(session.id) } else { None };
    if let Some(pw) = &saved
        && may(&allowed, MethodKind::Password)
    {
        check!(handle.authenticate_password(user, pw.clone()).await?);
    }

    // 5. keyboard-interactive (passwords, OTP, Duo push …), answering password prompts with the saved one
    if may(&allowed, MethodKind::KeyboardInteractive) {
        let mut used_saved = false;
        let mut resp = handle.authenticate_keyboard_interactive_start(user, None).await?;
        let mut rounds = 0;
        loop {
            match resp {
                KeyboardInteractiveAuthResponse::Success => return Ok(()),
                KeyboardInteractiveAuthResponse::Failure { remaining_methods, .. } => {
                    allowed = Some(remaining_methods);
                    break;
                }
                KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                    rounds += 1;
                    if rounds > 10 {
                        break;
                    }
                    let answers = if prompts.is_empty() {
                        vec![]
                    } else if prompts.len() == 1
                        && !prompts[0].echo
                        && prompts[0].prompt.to_lowercase().contains("password")
                    {
                        if let (Some(pw), false) = (&saved, used_saved) {
                            used_saved = true;
                            vec![pw.clone()]
                        } else {
                            let a = prompter
                                .ask(term, PromptKind::Password { user: user.into(), host: host.into(), retry: rounds > 1 || used_saved, remember: true })
                                .await
                                .ok_or_else(|| anyhow!("cancelled"))?;
                            if a.remember {
                                remember_password(session, &a.first());
                            }
                            vec![a.first()]
                        }
                    } else {
                        let fields = prompts.iter().map(|p| Field { label: p.prompt.trim().to_string(), echo: p.echo }).collect();
                        let a = prompter
                            .ask(term, PromptKind::Interactive { host: host.into(), name, instructions, fields })
                            .await
                            .ok_or_else(|| anyhow!("cancelled"))?;
                        let mut v = a.values;
                        v.resize(prompts.len(), String::new());
                        v
                    };
                    resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
                }
            }
        }
    }

    // 6. typed password, a few tries
    if may(&allowed, MethodKind::Password) {
        for attempt in 0..3 {
            let a = prompter
                .ask(term, PromptKind::Password { user: user.into(), host: host.into(), retry: attempt > 0 || saved.is_some(), remember: true })
                .await
                .ok_or_else(|| anyhow!("cancelled"))?;
            let pw = a.first();
            match handle.authenticate_password(user, pw.clone()).await? {
                russh::client::AuthResult::Success => {
                    if a.remember {
                        remember_password(session, &pw);
                    }
                    return Ok(());
                }
                russh::client::AuthResult::Failure { remaining_methods, .. } => {
                    if !remaining_methods.contains(&MethodKind::Password) {
                        break;
                    }
                }
            }
        }
    }

    bail!("{user}@{host} refused every way of logging in that was tried")
}

fn remember_password(session: &Session, pw: &str) {
    if session.id.is_nil() {
        return;
    }
    if let Err(e) = secrets::set(session.id, pw) {
        tracing::warn!("{e}");
    }
}

async fn load_key(prompter: &Prompter, path: &Path, term: Option<TermId>) -> Result<Option<keys::PrivateKey>> {
    let p = path.to_string_lossy().to_string();
    match keys::load_secret_key(path, None) {
        Ok(k) => return Ok(Some(k)),
        Err(keys::Error::KeyIsEncrypted) => {}
        Err(e) => {
            tracing::warn!("{p}: {e}");
            return Ok(None);
        }
    }
    if let Some(pass) = secrets::get_passphrase(&p)
        && let Ok(k) = keys::load_secret_key(path, Some(&pass))
    {
        return Ok(Some(k));
    }
    for retry in [false, true, true] {
        let Some(a) = prompter.ask(term, PromptKind::Passphrase { path: p.clone(), retry }).await else {
            return Ok(None); // skip this key, try the next method
        };
        if let Ok(k) = keys::load_secret_key(path, Some(&a.first())) {
            if a.remember {
                secrets::set_passphrase(&p, &a.first());
            }
            return Ok(Some(k));
        }
    }
    Ok(None)
}

#[cfg(unix)]
async fn agent() -> Option<keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>> {
    keys::agent::client::AgentClient::connect_env().await.ok().map(|a| a.dynamic())
}

#[cfg(windows)]
async fn agent() -> Option<keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>> {
    // Windows' own OpenSSH agent first, then Pageant
    if let Ok(a) = keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        return Some(a.dynamic());
    }
    keys::agent::client::AgentClient::connect_pageant().await.ok().map(|a| a.dynamic())
}

pub fn ssh_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ssh")
}

pub fn known_hosts_path() -> PathBuf {
    ssh_dir().join("known_hosts")
}

pub fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else {
        PathBuf::from(p)
    }
}

/// Drop entry number `line` as russh counts them (comment lines aren't counted).
fn forget_known_host_line(path: &Path, line: usize) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path)?;
    let mut n = 0usize;
    let mut out = String::with_capacity(text.len());
    for l in text.split_inclusive('\n') {
        if !l.starts_with('#') {
            n += 1;
            if n == line {
                continue;
            }
        }
        out.push_str(l);
    }
    std::fs::write(path, out)
}

/// Where X11 connections from the server go, and the cookie to present.
pub fn x11_target() -> Option<X11Target> {
    let display = std::env::var("DISPLAY").ok().filter(|d| !d.is_empty());
    #[cfg(unix)]
    {
        let d = display?;
        let num = d.strip_prefix(':')?.split('.').next()?.parse::<u32>().ok()?;
        Some(X11Target { addr: X11Addr::Unix(PathBuf::from(format!("/tmp/.X11-unix/X{num}"))) })
    }
    #[cfg(windows)]
    {
        // VcXsrv / X410 / Xming listen on TCP 6000 + display number
        let num = display.as_deref().and_then(|d| d.rsplit(':').next()).and_then(|n| n.split('.').next()?.parse::<u16>().ok()).unwrap_or(0);
        Some(X11Target { addr: X11Addr::Tcp(format!("127.0.0.1:{}", 6000 + num)) })
    }
}

/// The real X cookie for $DISPLAY (so the forwarded apps are accepted), or a random one.
pub fn x11_cookie() -> (String, String) {
    #[cfg(unix)]
    if let Ok(display) = std::env::var("DISPLAY")
        && let Ok(out) = std::process::Command::new("xauth").args(["list", &display]).output()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(line) = text.lines().next() {
            let parts: Vec<_> = line.split_whitespace().collect();
            if parts.len() == 3 {
                return (parts[1].to_string(), parts[2].to_string());
            }
        }
    }
    let cookie: String = uuid::Uuid::new_v4().simple().to_string();
    ("MIT-MAGIC-COOKIE-1".into(), cookie)
}

/// Read up to `max` bytes with a deadline; used by probes.
pub async fn read_some<R: tokio::io::AsyncRead + Unpin>(r: &mut R, max: usize, timeout: Duration) -> Vec<u8> {
    let mut buf = vec![0; max];
    match tokio::time::timeout(timeout, r.read(&mut buf)).await {
        Ok(Ok(n)) => {
            buf.truncate(n);
            buf
        }
        _ => Vec::new(),
    }
}

/// write_all + flush
pub async fn write_all<W: tokio::io::AsyncWrite + Unpin>(w: &mut W, data: &[u8]) -> std::io::Result<()> {
    w.write_all(data).await?;
    w.flush().await
}

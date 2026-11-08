//! Port forwarding over SSH: local (-L), remote (-R) and dynamic SOCKS5 (-D); saved tunnels that
//! run on their own (with reconnect), and a session's own forwards that live with its tab.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

use crate::model::{Forward, ForwardKind, Tunnel};
use crate::ssh::{self, Conn, ConnectOpts};
use crate::{Core, Event, Sink};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TunnelState {
    Stopped,
    Connecting,
    #[serde(rename_all = "camelCase")]
    Running { connections: u32 },
    #[serde(rename_all = "camelCase")]
    Failed { error: String, retrying: bool },
}

#[derive(Default)]
pub(crate) struct Tunnels {
    running: Mutex<HashMap<Uuid, tokio::task::JoinHandle<()>>>,
}

impl Tunnels {
    pub(crate) async fn stop_all(&self) {
        for (_, h) in self.running.lock().drain() {
            h.abort();
        }
    }
}

pub fn describe(f: &Forward) -> String {
    let bind = if f.bind.is_empty() { "localhost" } else { f.bind.as_str() };
    match f.kind {
        ForwardKind::Local => format!("{bind}:{} → {}:{}", f.port, f.host, f.host_port),
        ForwardKind::Remote => format!("server {bind}:{} → {}:{}", f.port, f.host, f.host_port),
        ForwardKind::Dynamic => format!("SOCKS5 on {bind}:{}", f.port),
    }
}

impl Core {
    pub fn tunnel_running(&self, id: Uuid) -> bool {
        self.tunnels.running.lock().get(&id).is_some_and(|h| !h.is_finished())
    }

    pub fn start_tunnel(self: &Arc<Self>, tunnel: Tunnel) -> Result<()> {
        if self.tunnel_running(tunnel.id) {
            return Ok(());
        }
        let session = self.session(tunnel.session).ok_or_else(|| anyhow!("its SSH session was deleted"))?;
        let core = self.clone();
        let id = tunnel.id;
        let handle = tokio::spawn(async move {
            let mut backoff = 2u64;
            loop {
                core.emit(Event::Tunnel { id, state: TunnelState::Connecting });
                let status = |_t: String| {};
                let core2 = core.clone();
                let resolve = move |sid: Uuid| core2.session(sid);
                let opts = ConnectOpts { term: None, status: &status, resolve: &resolve, depth: 0 };
                let res = async {
                    let conn = ssh::connect(core.prompter.clone(), &session, &opts).await?;
                    let h = start_forward(conn.clone(), tunnel.forward.clone(), Some(id), core.sink.clone()).await?;
                    backoff = 2;
                    // wait until the connection drops
                    while !conn.is_closed() && !h.is_finished() {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    h.abort();
                    Err::<(), _>(anyhow!("connection lost"))
                }
                .await;
                let err = res.err().map(|e| format!("{e:#}")).unwrap_or_default();
                let retry = tunnel.keep_alive && err != "cancelled";
                core.emit(Event::Tunnel { id, state: TunnelState::Failed { error: err, retrying: retry } });
                if !retry {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(60);
            }
        });
        self.tunnels.running.lock().insert(id, handle);
        Ok(())
    }

    pub fn stop_tunnel(&self, id: Uuid) {
        if let Some(h) = self.tunnels.running.lock().remove(&id) {
            h.abort();
        }
        self.emit(Event::Tunnel { id, state: TunnelState::Stopped });
    }

    /// Start every saved tunnel marked "start with Tether".
    pub fn autostart_tunnels(self: &Arc<Self>) {
        for t in self.store.tunnels() {
            if t.autostart
                && let Err(e) = self.start_tunnel(t.clone())
            {
                self.emit(Event::Tunnel { id: t.id, state: TunnelState::Failed { error: e.to_string(), retrying: false } });
            }
        }
    }
}

/// Start one forward on an open connection. The returned task owns the listener.
pub(crate) async fn start_forward(
    conn: Arc<Conn>,
    f: Forward,
    report: Option<Uuid>,
    sink: Arc<dyn Sink>,
) -> Result<tokio::task::JoinHandle<()>> {
    let bind = if f.bind.trim().is_empty() { "127.0.0.1".to_string() } else { f.bind.trim().to_string() };
    let count = Arc::new(AtomicU32::new(0));
    let notify = {
        let sink = sink.clone();
        let count = count.clone();
        move || {
            if let Some(id) = report {
                sink.event(Event::Tunnel { id, state: TunnelState::Running { connections: count.load(Ordering::Relaxed) } });
            }
        }
    };
    match f.kind {
        ForwardKind::Local | ForwardKind::Dynamic => {
            let listener = TcpListener::bind((bind.as_str(), f.port))
                .await
                .map_err(|e| anyhow!("can't listen on {bind}:{}: {e}", f.port))?;
            notify();
            let dynamic = f.kind == ForwardKind::Dynamic;
            Ok(tokio::spawn(async move {
                loop {
                    let Ok((mut sock, peer)) = listener.accept().await else { break };
                    if conn.is_closed() {
                        break;
                    }
                    let conn = conn.clone();
                    let f = f.clone();
                    let count = count.clone();
                    let notify = notify.clone();
                    tokio::spawn(async move {
                        count.fetch_add(1, Ordering::Relaxed);
                        notify();
                        let _ = sock.set_nodelay(true);
                        let target = if dynamic { socks5_handshake(&mut sock).await.ok() } else { Some((f.host.clone(), f.host_port)) };
                        if let Some((host, port)) = target {
                            match conn.handle.channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32).await {
                                Ok(ch) => {
                                    if dynamic {
                                        let _ = sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                                    }
                                    let mut stream = ch.into_stream();
                                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                                }
                                Err(_) => {
                                    if dynamic {
                                        // general failure / host unreachable
                                        let _ = sock.write_all(&[5, 4, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                                    }
                                }
                            }
                        }
                        count.fetch_sub(1, Ordering::Relaxed);
                        notify();
                    });
                }
            }))
        }
        ForwardKind::Remote => {
            let server_bind = if f.bind.trim().is_empty() { "localhost".to_string() } else { f.bind.trim().to_string() };
            let port = conn
                .handle
                .tcpip_forward(server_bind.clone(), f.port as u32)
                .await
                .map_err(|e| anyhow!("the server refused to listen on {server_bind}:{}: {e}", f.port))?;
            let port = if f.port == 0 { port } else { f.port as u32 };
            conn.forwards.lock().insert((server_bind.clone(), port), (f.host.clone(), f.host_port));
            notify();
            Ok(tokio::spawn(async move {
                // the handler routes incoming channels; we just keep the forward registered
                let _guard = Unforward { conn: conn.clone(), bind: server_bind, port };
                while !conn.is_closed() {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }))
        }
    }
}

struct Unforward {
    conn: Arc<Conn>,
    bind: String,
    port: u32,
}

impl Drop for Unforward {
    fn drop(&mut self) {
        self.conn.forwards.lock().remove(&(self.bind.clone(), self.port));
        let conn = self.conn.clone();
        let (bind, port) = (self.bind.clone(), self.port);
        tokio::spawn(async move {
            let _ = conn.handle.cancel_tcpip_forward(bind, port).await;
        });
    }
}

/// SOCKS5, no authentication, CONNECT only. Returns the requested host and port.
async fn socks5_handshake(s: &mut TcpStream) -> Result<(String, u16)> {
    let mut head = [0u8; 2];
    s.read_exact(&mut head).await?;
    if head[0] != 5 {
        bail!("not SOCKS5");
    }
    let mut methods = vec![0u8; head[1] as usize];
    s.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        s.write_all(&[5, 0xff]).await?;
        bail!("client wants authentication");
    }
    s.write_all(&[5, 0]).await?;
    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    if req[1] != 1 {
        s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        bail!("only CONNECT is supported");
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            s.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => bail!("bad address type"),
    };
    let mut port = [0u8; 2];
    s.read_exact(&mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}

/// A free local port (for RDP/VNC through SSH).
pub fn free_port() -> Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

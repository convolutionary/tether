//! VNC inside a tab: the UI runs noVNC, which speaks WebSocket; this bridges it to the server's TCP
//! port, directly or through an SSH session (so VNC never crosses the network unencrypted).

use std::sync::Arc;

use anyhow::{Result, anyhow};
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

use crate::{Core, Event, TermId};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bridge {
    /// ws://127.0.0.1:port/token
    pub url: String,
    /// saved VNC password, if any
    pub password: Option<String>,
}

impl Core {
    pub async fn vnc_bridge(self: &Arc<Self>, term: TermId) -> Result<Bridge> {
        let t = self.term(term)?;
        let s = t.session.clone();
        let port = s.port_or_default();

        // through SSH when the session names one to hop through
        if s.jump.is_some() && t.conn().is_none() {
            let mut via = self.session(s.jump.unwrap()).ok_or_else(|| anyhow!("the SSH session to go through was deleted"))?;
            via.forwards.clear();
            let core = self.clone();
            let status = move |text: String| core.emit(Event::Status { term, text });
            let core2 = self.clone();
            let resolve = move |sid: uuid::Uuid| core2.session(sid);
            let opts = crate::ssh::ConnectOpts { term: Some(term), status: &status, resolve: &resolve, depth: 0 };
            let conn = crate::ssh::connect(self.prompter.clone(), &via, &opts).await?;
            *t.conn.lock() = Some(conn);
        }

        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let local = listener.local_addr()?.port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let path = format!("/{token}");
        let core = self.clone();
        tokio::spawn(async move {
            // one viewer at a time; a reconnect from noVNC gets a fresh accept
            while let Ok((sock, _)) = listener.accept().await {
                let Ok(t) = core.term(term) else { break };
                let want = path.clone();
                let ws = tokio_tungstenite::accept_hdr_async(sock, |req: &Request, mut resp: Response| {
                    if req.uri().path() != want {
                        return Err(Response::builder().status(403).body(None).unwrap());
                    }
                    if let Some(p) = req.headers().get("sec-websocket-protocol")
                        && p.to_str().unwrap_or("").split(',').any(|x| x.trim() == "binary")
                    {
                        resp.headers_mut().insert("sec-websocket-protocol", "binary".parse().unwrap());
                    }
                    Ok(resp)
                })
                .await;
                let Ok(ws) = ws else { continue };
                let host = t.session.host.clone();
                let conn = t.conn();
                tokio::spawn(async move {
                    let res: Result<()> = async {
                        let (mut wtx, mut wrx) = ws.split();
                        macro_rules! pump {
                            ($stream:expr) => {{
                                let (mut rd, mut wr) = tokio::io::split($stream);
                                let up = async {
                                    while let Some(Ok(m)) = wrx.next().await {
                                        match m {
                                            Message::Binary(b) => wr.write_all(&b).await?,
                                            Message::Close(_) => break,
                                            _ => {}
                                        }
                                    }
                                    Ok::<_, anyhow::Error>(())
                                };
                                let down = async {
                                    let mut buf = vec![0u8; 64 * 1024];
                                    loop {
                                        let n = rd.read(&mut buf).await?;
                                        if n == 0 {
                                            break;
                                        }
                                        wtx.send(Message::Binary(buf[..n].to_vec().into())).await?;
                                    }
                                    Ok::<_, anyhow::Error>(())
                                };
                                tokio::select! { r = up => r?, r = down => r? }
                            }};
                        }
                        match conn {
                            Some(c) => {
                                let ch = c.handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await?;
                                pump!(ch.into_stream());
                            }
                            None => {
                                let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
                                pump!(tcp);
                            }
                        }
                        Ok(())
                    }
                    .await;
                    if let Err(e) = res {
                        tracing::debug!("vnc bridge: {e:#}");
                    }
                });
            }
        });
        let password = if s.save_password { crate::secrets::get(s.id) } else { None };
        Ok(Bridge { url: format!("ws://127.0.0.1:{local}/{token}"), password })
    }
}

//! Telnet: a TCP stream with just enough option negotiation for a usable terminal
//! (echo, suppress-go-ahead, terminal type, window size).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::model::Session;
use crate::term::Size;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;

pub struct Telnet {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    naws: Arc<AtomicBool>,
    size: Arc<Mutex<Size>>,
    task: tokio::task::JoinHandle<()>,
}

impl Telnet {
    pub async fn connect(
        s: &Session,
        size: Size,
        on_output: impl Fn(&[u8]) + Send + Sync + 'static,
        on_exit: impl FnOnce(String) + Send + 'static,
    ) -> Result<Telnet> {
        let port = s.port_or_default();
        let stream = tokio::time::timeout(std::time::Duration::from_secs(15), tokio::net::TcpStream::connect((s.host.as_str(), port)))
            .await
            .map_err(|_| anyhow::anyhow!("{}:{port} didn't answer", s.host))?
            .with_context(|| format!("couldn't connect to {}:{port}", s.host))?;
        let _ = stream.set_nodelay(true);
        let (mut rd, mut wr) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let naws = Arc::new(AtomicBool::new(false));
        let size = Arc::new(Mutex::new(size));
        let term_type = if s.term_type.is_empty() { "xterm-256color".to_string() } else { s.term_type.clone() };

        let tx2 = tx.clone();
        let naws2 = naws.clone();
        let size2 = size.clone();
        let task = tokio::spawn(async move {
            let writer = tokio::spawn(async move {
                while let Some(d) = rx.recv().await {
                    if wr.write_all(&d).await.is_err() {
                        break;
                    }
                }
            });
            let mut buf = [0u8; 16 * 1024];
            let mut p = Parser::default();
            let reason = loop {
                let n = match rd.read(&mut buf).await {
                    Ok(0) => break "connection closed".to_string(),
                    Ok(n) => n,
                    Err(e) => break e.to_string(),
                };
                let (data, replies) = p.feed(&buf[..n], &term_type);
                for r in replies {
                    if r == Reply::StartNaws {
                        naws2.store(true, Ordering::Relaxed);
                        let _ = tx2.send(naws_msg(*size2.lock()));
                    } else if let Reply::Bytes(b) = r {
                        let _ = tx2.send(b);
                    }
                }
                if !data.is_empty() {
                    on_output(&data);
                }
            };
            writer.abort();
            on_exit(reason);
        });
        Ok(Telnet { tx, naws, size, task })
    }

    pub fn write(&self, data: &[u8]) {
        // a literal 0xFF must be doubled; Enter is CR LF on the wire... most servers want CR NUL or CR LF
        let mut out = Vec::with_capacity(data.len() + 4);
        for &b in data {
            if b == IAC {
                out.push(IAC);
            }
            out.push(b);
            if b == b'\r' {
                out.push(0);
            }
        }
        let _ = self.tx.send(out);
    }

    pub fn resize(&self, size: Size) {
        *self.size.lock() = size;
        if self.naws.load(Ordering::Relaxed) {
            let _ = self.tx.send(naws_msg(size));
        }
    }

    pub fn close(&self) {
        self.task.abort();
    }
}

fn naws_msg(s: Size) -> Vec<u8> {
    let mut v = vec![IAC, SB, NAWS];
    for b in [(s.cols >> 8) as u8, s.cols as u8, (s.rows >> 8) as u8, s.rows as u8] {
        if b == IAC {
            v.push(IAC);
        }
        v.push(b);
    }
    v.extend_from_slice(&[IAC, SE]);
    v
}

#[derive(Debug, PartialEq)]
enum Reply {
    Bytes(Vec<u8>),
    StartNaws,
}

#[derive(Default)]
struct Parser {
    state: u8, // 0 data, 1 after IAC, 2 after IAC+verb, 3 in SB, 4 SB after IAC
    verb: u8,
    sb: Vec<u8>,
}

impl Parser {
    fn feed(&mut self, input: &[u8], term_type: &str) -> (Vec<u8>, Vec<Reply>) {
        let mut data = Vec::with_capacity(input.len());
        let mut replies = Vec::new();
        for &b in input {
            match self.state {
                0 => {
                    if b == IAC {
                        self.state = 1
                    } else {
                        data.push(b)
                    }
                }
                1 => match b {
                    IAC => {
                        data.push(IAC);
                        self.state = 0
                    }
                    DO | DONT | WILL | WONT => {
                        self.verb = b;
                        self.state = 2
                    }
                    SB => {
                        self.sb.clear();
                        self.state = 3
                    }
                    _ => self.state = 0,
                },
                2 => {
                    let opt = b;
                    match (self.verb, opt) {
                        (DO, NAWS) => {
                            replies.push(Reply::Bytes(vec![IAC, WILL, NAWS]));
                            replies.push(Reply::StartNaws);
                        }
                        (DO, TTYPE) | (DO, SGA) => replies.push(Reply::Bytes(vec![IAC, WILL, opt])),
                        (DO, o) => replies.push(Reply::Bytes(vec![IAC, WONT, o])),
                        (WILL, ECHO) | (WILL, SGA) => replies.push(Reply::Bytes(vec![IAC, DO, opt])),
                        (WILL, o) => replies.push(Reply::Bytes(vec![IAC, DONT, o])),
                        _ => {}
                    }
                    self.state = 0;
                }
                3 => {
                    if b == IAC {
                        self.state = 4
                    } else {
                        self.sb.push(b)
                    }
                }
                _ => {
                    if b == SE {
                        // terminal type SEND -> IS
                        if self.sb.first() == Some(&TTYPE) && self.sb.get(1) == Some(&1) {
                            let mut r = vec![IAC, SB, TTYPE, 0];
                            r.extend_from_slice(term_type.as_bytes());
                            r.extend_from_slice(&[IAC, SE]);
                            replies.push(Reply::Bytes(r));
                        }
                        self.state = 0;
                    } else {
                        self.sb.push(b);
                        self.state = 3;
                    }
                }
            }
        }
        (data, replies)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation() {
        let mut p = Parser::default();
        let (d, r) = p.feed(&[b'h', IAC, DO, NAWS, b'i', IAC, IAC, IAC, WILL, ECHO, IAC, DO, 99], "xterm");
        assert_eq!(d, vec![b'h', b'i', IAC]);
        assert_eq!(r[0], Reply::Bytes(vec![IAC, WILL, NAWS]));
        assert_eq!(r[1], Reply::StartNaws);
        assert_eq!(r[2], Reply::Bytes(vec![IAC, DO, ECHO]));
        assert_eq!(r[3], Reply::Bytes(vec![IAC, WONT, 99]));
        let (_, r) = p.feed(&[IAC, SB, TTYPE, 1, IAC, SE], "xterm");
        assert_eq!(r[0], Reply::Bytes(vec![IAC, SB, TTYPE, 0, b'x', b't', b'e', b'r', b'm', IAC, SE]));
    }
}

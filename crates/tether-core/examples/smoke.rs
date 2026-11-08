//! End-to-end check against a real sshd:  TETHER_TEST_HOST=127.0.0.1 TETHER_TEST_PORT=2222
//! TETHER_TEST_KEY=/path/to/key cargo run --example smoke

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tether_core::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Rec {
    out: Mutex<std::collections::HashMap<TermId, Vec<u8>>>,
    events: Mutex<Vec<Event>>,
    core: Mutex<Option<std::sync::Weak<Core>>>,
}

impl Sink for Rec {
    fn output(&self, term: TermId, data: &[u8]) {
        self.out.lock().entry(term).or_default().extend_from_slice(data);
    }
    fn event(&self, e: Event) {
        if let Event::Prompt { id, prompt, .. } = &e {
            println!("  prompt: {prompt:?}");
            let core = self.core.lock().as_ref().and_then(|w| w.upgrade());
            let id = *id;
            if let Some(core) = core {
                std::thread::spawn(move || core.answer(id, Some(Answer { values: vec![], remember: true })));
            }
        }
        self.events.lock().push(e);
    }
}

impl Rec {
    async fn wait<F: Fn(&Rec) -> bool>(&self, what: &str, f: F) {
        for _ in 0..200 {
            if f(self) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out waiting for {what}; events: {:#?}", self.events.lock());
    }
    fn text(&self, t: TermId) -> String {
        String::from_utf8_lossy(self.out.lock().get(&t).map(|v| v.as_slice()).unwrap_or(b"")).into_owned()
    }
    fn ready(&self, t: TermId) -> bool {
        self.events.lock().iter().any(|e| matches!(e, Event::Ready { term, .. } if *term == t))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = std::env::var("TETHER_TEST_HOST").unwrap_or("127.0.0.1".into());
    let port: u16 = std::env::var("TETHER_TEST_PORT").unwrap_or("2222".into()).parse()?;
    let key = std::env::var("TETHER_TEST_KEY")?;
    let dir = std::env::temp_dir().join(format!("tether-smoke-{}", uuid::Uuid::new_v4().simple()));
    let rec = Arc::new(Rec { out: Default::default(), events: Default::default(), core: Default::default() });
    let core = Core::new(rec.clone(), Store::new(dir.join("config"))?);
    *rec.core.lock() = Some(Arc::downgrade(&core));
    let size = term::Size { cols: 120, rows: 30 };

    let session = Session {
        name: "test".into(),
        host: host.clone(),
        port,
        user: std::env::var("USER")?,
        identity: key,
        ..Default::default()
    };
    core.store.save_sessions(std::slice::from_ref(&session))?;

    println!("1. SSH terminal");
    let t = core.open(session.clone(), size)?;
    rec.wait("ready", |r| r.ready(t)).await;
    core.write(t, b"cd /tmp && echo MARK-$((6*7))\n")?;
    rec.wait("shell output", |r| r.text(t).contains("MARK-42")).await;
    assert!(!rec.text(t).contains("6973"), "PID marker leaked into the terminal");
    println!("   ok: shell answered, marker hidden");

    println!("2. follows the shell's folder");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let cwd = core.remote_cwd(t).await;
    assert_eq!(cwd.as_deref(), Some("/tmp"), "cwd");
    println!("   ok: {cwd:?}");

    println!("3. SFTP");
    let base = format!("/tmp/tether-smoke-{}", uuid::Uuid::new_v4().simple());
    core.sftp_mkdir(t, &base).await?;
    let local_dir = dir.join("up");
    std::fs::create_dir_all(local_dir.join("sub"))?;
    let payload: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(local_dir.join("big.bin"), &payload)?;
    std::fs::write(local_dir.join("sub/note.txt"), "hello")?;
    let up = core.sftp_upload(t, vec![local_dir.clone()], base.clone());
    rec.wait("upload", |r| r.events.lock().iter().any(|e| matches!(e, Event::Transfer(x) if x.id == up && x.state != sftp::TransferState::Running))).await;
    let (_, list) = core.sftp_list(t, &format!("{base}/up")).await?;
    let names: Vec<_> = list.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["sub", "big.bin"], "dirs first");
    let down_dir = dir.join("down");
    std::fs::create_dir_all(&down_dir)?;
    let dn = core.sftp_download(t, vec![format!("{base}/up")], down_dir.clone());
    rec.wait("download", |r| r.events.lock().iter().any(|e| matches!(e, Event::Transfer(x) if x.id == dn && x.state != sftp::TransferState::Running))).await;
    assert_eq!(std::fs::read(down_dir.join("up/big.bin"))?, payload);
    assert_eq!(std::fs::read_to_string(down_dir.join("up/sub/note.txt"))?, "hello");
    core.sftp_rename(t, &format!("{base}/up/sub/note.txt"), &format!("{base}/up/sub/n2.txt")).await?;
    core.sftp_chmod(t, &format!("{base}/up/sub/n2.txt"), 0o600).await?;
    let (_, l2) = core.sftp_list(t, &format!("{base}/up/sub")).await?;
    assert_eq!((l2[0].name.as_str(), l2[0].mode), ("n2.txt", Some(0o600)));
    core.sftp_remove(t, std::slice::from_ref(&base)).await?;
    assert!(core.sftp_list(t, &base).await.is_err());
    println!("   ok: 3 MB up and down intact, rename, chmod, recursive delete");

    println!("4. duplicate tab reuses the login");
    let prompts_before = rec.events.lock().iter().filter(|e| matches!(e, Event::Prompt { .. })).count();
    let t2 = core.duplicate(t, size)?;
    rec.wait("dup ready", |r| r.ready(t2)).await;
    core.write(t2, b"echo DUP-OK\n")?;
    rec.wait("dup output", |r| r.text(t2).contains("DUP-OK")).await;
    assert_eq!(rec.events.lock().iter().filter(|e| matches!(e, Event::Prompt { .. })).count(), prompts_before);
    println!("   ok");

    println!("5. tunnels");
    let lport = tunnel::free_port()?;
    let tun = Tunnel {
        name: "to sshd".into(),
        session: session.id,
        forward: Forward { kind: ForwardKind::Local, bind: String::new(), port: lport, host: "127.0.0.1".into(), host_port: port },
        ..Default::default()
    };
    core.start_tunnel(tun.clone())?;
    rec.wait("tunnel up", |r| r.events.lock().iter().any(|e| matches!(e, Event::Tunnel { id, state: tunnel::TunnelState::Running { .. } } if *id == tun.id))).await;
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", lport)).await?;
    let mut banner = [0u8; 7];
    s.read_exact(&mut banner).await?;
    assert_eq!(&banner, b"SSH-2.0");
    core.stop_tunnel(tun.id);
    let dport = tunnel::free_port()?;
    let socks = Tunnel {
        name: "socks".into(),
        session: session.id,
        forward: Forward { kind: ForwardKind::Dynamic, bind: String::new(), port: dport, host: String::new(), host_port: 0 },
        ..Default::default()
    };
    core.start_tunnel(socks.clone())?;
    rec.wait("socks up", |r| r.events.lock().iter().any(|e| matches!(e, Event::Tunnel { id, state: tunnel::TunnelState::Running { .. } } if *id == socks.id))).await;
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", dport)).await?;
    s.write_all(&[5, 1, 0]).await?;
    let mut r = [0u8; 2];
    s.read_exact(&mut r).await?;
    assert_eq!(r, [5, 0]);
    let mut req = vec![5, 1, 0, 3, 9];
    req.extend_from_slice(b"localhost");
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;
    let mut rep = [0u8; 10];
    s.read_exact(&mut rep).await?;
    assert_eq!(rep[1], 0, "socks connect ok");
    s.read_exact(&mut banner).await?;
    assert_eq!(&banner, b"SSH-2.0");
    core.stop_tunnel(socks.id);
    println!("   ok: -L and SOCKS5 both reach the server");

    println!("6. stats");
    let (_, sample) = core.stats(t, None).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (st, _) = core.stats(t, Some(sample)).await?;
    assert!(st.cpus > 0 && st.mem_total > 0 && st.cpu.is_some());
    println!("   ok: {} cpus, {:.1}% busy, {} MB used", st.cpus, st.cpu.unwrap(), st.mem_used / 1_048_576);

    println!("7. VNC bridge (pointed at sshd: the banner should come through as a binary frame)");
    let vs = Session { protocol: Protocol::Vnc, host: host.clone(), port, ..Default::default() };
    let vt = core.open(vs, size)?;
    let bridge = core.vnc_bridge(vt).await?;
    let (mut ws, _) = tokio_tungstenite::connect_async(&bridge.url).await?;
    use futures::StreamExt;
    let msg = tokio::time::timeout(Duration::from_secs(5), ws.next()).await?.unwrap()?;
    assert!(msg.into_data().starts_with(b"SSH-2.0"));
    let bad = bridge.url.rsplit_once('/').unwrap().0.to_string() + "/wrong";
    assert!(tokio_tungstenite::connect_async(&bad).await.is_err(), "token checked");
    println!("   ok");

    println!("8. local terminal");
    let ls = Session { protocol: Protocol::Local, command: "sh -c 'echo LOCAL-$((2+2)); exit 3'".into(), ..Default::default() };
    let lt = core.open(ls, size)?;
    rec.wait("local output", |r| r.text(lt).contains("LOCAL-4")).await;
    rec.wait("local exit", |r| r.events.lock().iter().any(|e| matches!(e, Event::Exit { term, code: Some(3), .. } if *term == lt))).await;
    println!("   ok: output and exit code");

    println!("9. closing the tab ends the shell");
    core.close(t2).await;
    core.close(t).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let kh = std::fs::read_to_string(ssh::known_hosts_path())?;
    assert!(kh.contains(&format!("[{host}]:{port}")), "host key remembered");
    println!("   ok, host key remembered in {}", ssh::known_hosts_path().display());

    core.shutdown().await;
    std::fs::remove_dir_all(dir).ok();
    println!("\nall good");
    Ok(())
}

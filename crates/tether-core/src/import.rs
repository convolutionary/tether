//! Bring sessions in from elsewhere: ~/.ssh/config, MobaXterm (.mxtsessions / MobaXterm.ini),
//! and PuTTY (Windows registry, or ~/.putty/sessions on Linux).

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use uuid::Uuid;

use crate::model::{Forward, ForwardKind, Protocol, Session};
use crate::ssh::expand_home;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub sessions: Vec<Session>,
    /// entries we couldn't bring over, with why
    pub skipped: Vec<String>,
}

// ---------------------------------------------------------------- OpenSSH

pub fn ssh_config(path: &Path) -> Imported {
    let mut out = Imported::default();
    let Ok(text) = std::fs::read_to_string(path) else { return out };
    let mut blocks: Vec<(Vec<String>, Vec<(String, String)>)> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, val) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        match key.as_str() {
            "host" => blocks.push((val.split_whitespace().map(String::from).collect(), Vec::new())),
            "match" => blocks.push((Vec::new(), Vec::new())),
            _ => {
                if let Some(b) = blocks.last_mut() {
                    b.1.push((key, val));
                }
            }
        }
    }
    // values from "Host *" apply to every host that doesn't set its own
    let defaults: HashMap<String, String> = blocks
        .iter()
        .filter(|(names, _)| names.iter().any(|n| n == "*"))
        .flat_map(|(_, kv)| kv.iter().cloned())
        .collect();

    let mut by_name: HashMap<String, Uuid> = HashMap::new();
    let mut jumps: Vec<(Uuid, String)> = Vec::new();
    for (names, kv) in &blocks {
        for name in names {
            if name.contains(['*', '?', '!']) {
                continue;
            }
            let get = |k: &str| kv.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone()).or_else(|| defaults.get(k).cloned());
            let mut s = Session {
                name: name.clone(),
                folder: "SSH config".into(),
                protocol: Protocol::Ssh,
                host: get("hostname").unwrap_or_else(|| name.clone()),
                port: get("port").and_then(|p| p.parse().ok()).unwrap_or(22),
                user: get("user").unwrap_or_default(),
                identity: get("identityfile").map(|p| expand_home(&p).to_string_lossy().into_owned()).unwrap_or_default(),
                x11: get("forwardx11").is_some_and(|v| v.eq_ignore_ascii_case("yes")),
                agent_forward: get("forwardagent").is_some_and(|v| v.eq_ignore_ascii_case("yes")),
                compression: get("compression").is_some_and(|v| v.eq_ignore_ascii_case("yes")),
                keepalive_secs: get("serveraliveinterval").and_then(|v| v.parse().ok()).unwrap_or(30),
                ..Default::default()
            };
            for (k, v) in kv {
                if let Some(f) = parse_forward(k, v) {
                    s.forwards.push(f);
                }
            }
            if let Some(j) = get("proxyjump").filter(|j| !j.eq_ignore_ascii_case("none")) {
                jumps.push((s.id, j.split(',').next().unwrap_or("").to_string()));
            }
            if get("proxycommand").is_some() {
                out.skipped.push(format!("{name}: ProxyCommand isn't supported (ProxyJump is); imported without it"));
            }
            by_name.insert(name.clone(), s.id);
            out.sessions.push(s);
        }
    }
    // ProxyJump: a known Host alias, else a user@host[:port] we add as its own session
    for (id, j) in jumps {
        let target = match by_name.get(&j) {
            Some(t) => Some(*t),
            None => Session::parse_quick(&j).map(|mut js| {
                js.folder = "SSH config".into();
                js.name = j.clone();
                let jid = js.id;
                by_name.insert(j.clone(), jid);
                out.sessions.push(js);
                jid
            }),
        };
        if let Some(s) = out.sessions.iter_mut().find(|s| s.id == id) {
            s.jump = target;
        }
    }
    out
}

fn parse_forward(key: &str, val: &str) -> Option<Forward> {
    let kind = match key {
        "localforward" => ForwardKind::Local,
        "remoteforward" => ForwardKind::Remote,
        "dynamicforward" => ForwardKind::Dynamic,
        _ => return None,
    };
    let mut parts = val.split_whitespace();
    let listen = parts.next()?;
    let (bind, port) = match listen.rsplit_once(':') {
        Some((b, p)) => (b.trim_matches(['[', ']']).to_string(), p.parse().ok()?),
        None => (String::new(), listen.parse().ok()?),
    };
    let (host, host_port) = match parts.next() {
        Some(dest) => {
            let (h, p) = dest.rsplit_once(':')?;
            (h.trim_matches(['[', ']']).to_string(), p.parse().ok()?)
        }
        None => (String::new(), 0),
    };
    Some(Forward { kind, bind, port, host, host_port })
}

// ---------------------------------------------------------------- MobaXterm

/// MobaXterm's bookmark lines look like  `Name=#109#0%host%port%user%…#…`.
/// The number after the first # is the session type.
pub fn mobaxterm(path: &Path) -> Imported {
    let mut out = Imported::default();
    let Ok(bytes) = std::fs::read(path) else { return out };
    // MobaXterm writes these files in the Windows ANSI code page; latin-1 is a close-enough read
    let text: String = match String::from_utf8(bytes.clone()) {
        Ok(s) => s,
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    };
    let mut folder = String::new();
    let mut in_bookmarks = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_bookmarks = line.to_ascii_lowercase().starts_with("[bookmarks");
            folder.clear();
            continue;
        }
        if !in_bookmarks {
            continue;
        }
        let Some((key, val)) = line.split_once('=') else { continue };
        if key.eq_ignore_ascii_case("SubRep") {
            folder = val.replace('\\', "/");
            continue;
        }
        if key.eq_ignore_ascii_case("ImgNum") || !val.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = val.split('#').collect();
        let (Some(code), Some(fields)) = (parts.get(1), parts.get(2)) else { continue };
        let f: Vec<&str> = fields.split('%').collect();
        let get = |i: usize| f.get(i).map(|s| s.trim().to_string()).unwrap_or_default();
        let protocol = match *code {
            "109" => Protocol::Ssh,
            "140" => Protocol::Sftp,
            "98" => Protocol::Telnet,
            "91" => Protocol::Rdp,
            "128" => Protocol::Vnc,
            "131" => Protocol::Serial,
            "151" => Protocol::Mosh,
            other => {
                out.skipped.push(format!("{key}: MobaXterm session type {other} has no equivalent here"));
                continue;
            }
        };
        let mut s = Session { name: key.to_string(), folder: folder.clone(), protocol, ..Default::default() };
        if protocol == Protocol::Serial {
            // field 1 is the port ("COM3  (USB Serial Port)"), field 2 the speed
            s.device = get(1).split_whitespace().next().unwrap_or("").to_string();
            s.baud = get(2).parse().unwrap_or(115_200);
            s.port = 0;
        } else {
            s.host = get(1);
            s.port = get(2).parse().unwrap_or(protocol.default_port());
            s.user = get(3);
        }
        if protocol == Protocol::Ssh {
            // the private key is the field that looks like a path to one
            if let Some(k) = f.iter().find(|v| {
                let l = v.to_ascii_lowercase();
                (l.ends_with(".ppk") || l.ends_with(".pem") || l.contains("id_") || l.ends_with(".key")) && !l.starts_with('_')
            }) {
                s.identity = k.replace("_ProfileDir_", &dirs::home_dir().unwrap_or_default().to_string_lossy());
            }
        }
        if s.host.is_empty() && protocol != Protocol::Serial {
            out.skipped.push(format!("{key}: no host"));
            continue;
        }
        out.sessions.push(s);
    }
    out
}

// ---------------------------------------------------------------- PuTTY

fn putty_session(name: &str, get: impl Fn(&str) -> Option<String>) -> Option<Session> {
    let protocol = match get("Protocol").as_deref() {
        Some("ssh") | None => Protocol::Ssh,
        Some("telnet") => Protocol::Telnet,
        Some("serial") => Protocol::Serial,
        Some(_) => return None,
    };
    let mut s = Session { name: name.to_string(), folder: "PuTTY".into(), protocol, ..Default::default() };
    if protocol == Protocol::Serial {
        s.device = get("SerialLine").unwrap_or_default();
        s.baud = get("SerialSpeed").and_then(|v| v.parse().ok()).unwrap_or(9600);
        s.port = 0;
    } else {
        s.host = get("HostName").unwrap_or_default();
        s.port = get("PortNumber").and_then(|v| v.parse().ok()).unwrap_or(protocol.default_port());
        s.user = get("UserName").unwrap_or_default();
        s.identity = get("PublicKeyFile").unwrap_or_default();
        s.x11 = get("X11Forward").as_deref() == Some("1");
        s.agent_forward = get("AgentFwd").as_deref() == Some("1");
        s.compression = get("Compression").as_deref() == Some("1");
        if s.host.is_empty() {
            return None;
        }
    }
    Some(s)
}

fn putty_unescape(name: &str) -> String {
    // PuTTY %-encodes session names
    let b = name.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn putty() -> Imported {
    let mut out = Imported::default();
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;
        if let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\SimonTatham\PuTTY\Sessions") {
            for key in root.enum_keys().flatten() {
                let Ok(k) = root.open_subkey(&key) else { continue };
                let get = |v: &str| -> Option<String> {
                    k.get_value::<String, _>(v).ok().or_else(|| k.get_value::<u32, _>(v).ok().map(|n| n.to_string()))
                };
                let name = putty_unescape(&key);
                if name == "Default Settings" {
                    continue;
                }
                match putty_session(&name, get) {
                    Some(s) => out.sessions.push(s),
                    None => out.skipped.push(format!("{name}: not SSH, telnet or serial")),
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let dir = dirs::home_dir().unwrap_or_default().join(".putty/sessions");
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let name = putty_unescape(&e.file_name().to_string_lossy());
                if name == "Default Settings" {
                    continue;
                }
                let text = std::fs::read_to_string(e.path()).unwrap_or_default();
                let map: HashMap<&str, &str> = text.lines().filter_map(|l| l.split_once('=')).collect();
                match putty_session(&name, |k| map.get(k).map(|v| v.to_string())) {
                    Some(s) => out.sessions.push(s),
                    None => out.skipped.push(format!("{name}: not SSH, telnet or serial")),
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openssh() {
        let dir = std::env::temp_dir().join(format!("tether-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("config");
        std::fs::write(
            &p,
            "Host *\n  User fallback\n  ServerAliveInterval 15\n\nHost bastion\n  HostName 1.2.3.4\n  User admin\n\nHost web web2\n  HostName 10.0.0.5\n  Port 2222\n  ProxyJump bastion\n  LocalForward 8080 localhost:80\n  DynamicForward 1080\n\nHost far\n  ProxyJump ops@gw.example:2200\n",
        )
        .unwrap();
        let r = ssh_config(&p);
        let by = |n: &str| r.sessions.iter().find(|s| s.name == n).unwrap().clone();
        let b = by("bastion");
        assert_eq!((b.host.as_str(), b.user.as_str(), b.keepalive_secs), ("1.2.3.4", "admin", 15));
        let w = by("web2");
        assert_eq!((w.host.as_str(), w.port, w.user.as_str()), ("10.0.0.5", 2222, "fallback"));
        assert_eq!(w.jump, Some(b.id));
        assert_eq!(w.forwards.len(), 2);
        assert_eq!(w.forwards[0], Forward { kind: ForwardKind::Local, bind: String::new(), port: 8080, host: "localhost".into(), host_port: 80 });
        let g = by("ops@gw.example:2200");
        assert_eq!((g.host.as_str(), g.port), ("gw.example", 2200));
        assert_eq!(by("far").jump, Some(g.id));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn moba() {
        let dir = std::env::temp_dir().join(format!("tether-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("s.mxtsessions");
        std::fs::write(
            &p,
            "[Bookmarks]\nSubRep=\nImgNum=42\n[Bookmarks_1]\nSubRep=Work\\Lab\nImgNum=41\nrouter=#109#0%192.168.1.1%22%root%%-1%-1%%%22%%0%0%0%C:\\keys\\lab.ppk%%-1%0%0%0%%1080%%0%0%1#MobaFont%10#0# #-1\nwin=#91#4%10.0.0.9%3389%Administrator%0%-1#MobaFont#0# #-1\nftp=#130#6%ftp.example%21%anon#x#0# #-1\n",
        )
        .unwrap();
        let r = mobaxterm(&p);
        assert_eq!(r.sessions.len(), 2);
        assert_eq!(r.skipped.len(), 1);
        let s = &r.sessions[0];
        assert_eq!((s.name.as_str(), s.folder.as_str(), s.host.as_str(), s.user.as_str()), ("router", "Work/Lab", "192.168.1.1", "root"));
        assert_eq!(s.identity, "C:\\keys\\lab.ppk");
        assert_eq!(r.sessions[1].protocol, Protocol::Rdp);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn putty_names() {
        assert_eq!(putty_unescape("my%20box"), "my box");
    }
}

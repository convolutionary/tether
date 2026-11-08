//! Saved sessions, tunnels, snippets and settings, and where they live on disk.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Ssh,
    Sftp,
    Local,
    Telnet,
    Serial,
    Mosh,
    Rdp,
    Vnc,
}

impl Protocol {
    pub fn default_port(self) -> u16 {
        match self {
            Protocol::Ssh | Protocol::Sftp | Protocol::Mosh => 22,
            Protocol::Telnet => 23,
            Protocol::Rdp => 3389,
            Protocol::Vnc => 5900,
            Protocol::Local | Protocol::Serial => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForwardKind {
    /// -L: a port here reaches a host:port seen from the server
    Local,
    /// -R: a port on the server reaches a host:port seen from here
    Remote,
    /// -D: a SOCKS5 proxy here whose connections leave from the server
    Dynamic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Forward {
    pub kind: ForwardKind,
    /// address to listen on ("127.0.0.1" if empty)
    #[serde(default)]
    pub bind: String,
    pub port: u16,
    /// destination host (unused for Dynamic)
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub host_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Session {
    pub id: Uuid,
    pub name: String,
    /// folder path, "/"-separated ("" = top level)
    pub folder: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// private key file; empty = agent, then default keys, then password
    pub identity: String,
    /// another saved session to hop through (ProxyJump)
    pub jump: Option<Uuid>,
    /// whether a password is stored in the OS keyring for this session
    pub save_password: bool,
    pub x11: bool,
    pub agent_forward: bool,
    pub compression: bool,
    pub keepalive_secs: u32,
    /// run this instead of a login shell
    pub remote_command: String,
    /// SFTP panel follows the shell's working folder
    pub follow_cwd: bool,
    pub forwards: Vec<Forward>,
    /// local: program to run (empty = default shell); mosh: extra args
    pub command: String,
    pub cwd: String,
    /// serial
    pub device: String,
    pub baud: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    pub flow: String,
    /// rdp
    pub domain: String,
    pub rdp_args: String,
    /// environment variables for the remote/local shell
    pub env: Vec<(String, String)>,
    pub term_type: String,
    /// accent shown on the tab and in the tree (#rrggbb, empty = protocol colour)
    pub color: String,
    pub notes: String,
    /// write everything the session prints to a log file
    pub log: bool,
    pub created: i64,
    pub last_used: i64,
}

impl Default for Session {
    fn default() -> Self {
        Session {
            id: Uuid::new_v4(),
            name: String::new(),
            folder: String::new(),
            protocol: Protocol::Ssh,
            host: String::new(),
            port: 22,
            user: String::new(),
            identity: String::new(),
            jump: None,
            save_password: false,
            x11: false,
            agent_forward: false,
            compression: false,
            keepalive_secs: 30,
            remote_command: String::new(),
            follow_cwd: true,
            forwards: Vec::new(),
            command: String::new(),
            cwd: String::new(),
            device: String::new(),
            baud: 115_200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow: "none".into(),
            domain: String::new(),
            rdp_args: String::new(),
            env: Vec::new(),
            term_type: "xterm-256color".into(),
            color: String::new(),
            notes: String::new(),
            log: false,
            created: chrono::Utc::now().timestamp(),
            last_used: 0,
        }
    }
}

impl Session {
    pub fn port_or_default(&self) -> u16 {
        if self.port == 0 { self.protocol.default_port() } else { self.port }
    }

    /// "user@host:port" style label
    pub fn target(&self) -> String {
        match self.protocol {
            Protocol::Local => {
                if self.command.is_empty() { "local shell".into() } else { self.command.clone() }
            }
            Protocol::Serial => format!("{} @ {}", self.device, self.baud),
            _ => {
                let mut s = String::new();
                if !self.user.is_empty() {
                    s.push_str(&self.user);
                    s.push('@');
                }
                s.push_str(&self.host);
                if self.port != 0 && self.port != self.protocol.default_port() {
                    s.push_str(&format!(":{}", self.port));
                }
                s
            }
        }
    }

    /// Parse a quick-connect string:
    ///   user@host[:port]  ssh://  sftp://  telnet://  mosh://  rdp://  vnc://  serial:///dev/ttyUSB0[@baud]  COM3[@baud]
    pub fn parse_quick(input: &str) -> Option<Session> {
        let input = input.trim();
        if input.is_empty() {
            return None;
        }
        let (protocol, rest) = match input.split_once("://") {
            Some((scheme, rest)) => {
                let p = match scheme.to_ascii_lowercase().as_str() {
                    "ssh" => Protocol::Ssh,
                    "sftp" => Protocol::Sftp,
                    "telnet" => Protocol::Telnet,
                    "mosh" => Protocol::Mosh,
                    "rdp" => Protocol::Rdp,
                    "vnc" => Protocol::Vnc,
                    "serial" => Protocol::Serial,
                    _ => return None,
                };
                (p, rest)
            }
            None => {
                let upper = input.to_ascii_uppercase();
                if input.starts_with("/dev/") || (upper.starts_with("COM") && upper[3..].chars().take_while(|c| *c != '@').all(|c| c.is_ascii_digit())) {
                    (Protocol::Serial, input)
                } else {
                    (Protocol::Ssh, input)
                }
            }
        };
        let mut s = Session { protocol, port: protocol.default_port(), ..Default::default() };
        if protocol == Protocol::Serial {
            let (dev, baud) = rest.split_once('@').unwrap_or((rest, ""));
            s.device = dev.to_string();
            if let Ok(b) = baud.parse() {
                s.baud = b;
            }
            s.name = s.device.clone();
            return Some(s);
        }
        let rest = rest.trim_end_matches('/');
        let (user, hostport) = match rest.rsplit_once('@') {
            Some((u, h)) => (u.to_string(), h),
            None => (String::new(), rest),
        };
        // [v6]:port, host:port, or bare host / bare v6
        let (host, port) = if let Some(stripped) = hostport.strip_prefix('[') {
            let (h, after) = stripped.split_once(']')?;
            (h.to_string(), after.strip_prefix(':').and_then(|p| p.parse().ok()))
        } else if hostport.matches(':').count() == 1 {
            let (h, p) = hostport.split_once(':')?;
            (h.to_string(), p.parse().ok())
        } else {
            (hostport.to_string(), None)
        };
        if host.is_empty() {
            return None;
        }
        s.user = user;
        s.host = host;
        if let Some(p) = port {
            s.port = p;
        }
        s.name = s.target();
        Some(s)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Tunnel {
    pub id: Uuid,
    pub name: String,
    /// the SSH session that carries it
    pub session: Uuid,
    pub forward: Forward,
    /// start when Tether starts
    pub autostart: bool,
    /// reconnect when the connection drops
    pub keep_alive: bool,
}

impl Default for Tunnel {
    fn default() -> Self {
        Tunnel {
            id: Uuid::new_v4(),
            name: String::new(),
            session: Uuid::nil(),
            forward: Forward { kind: ForwardKind::Local, bind: String::new(), port: 0, host: "localhost".into(), host_port: 0 },
            autostart: false,
            keep_alive: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Snippet {
    pub id: Uuid,
    pub name: String,
    pub text: String,
    /// press Enter after pasting
    pub run: bool,
}

impl Default for Snippet {
    fn default() -> Self {
        Snippet { id: Uuid::new_v4(), name: String::new(), text: String::new(), run: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// "system" | "dark" | "light"
    pub appearance: String,
    pub accent: String,
    /// terminal colour scheme id, or "system" to follow the desktop (HyDE/wallbash on phiOS)
    pub terminal_theme: String,
    pub font_family: String,
    pub font_size: f32,
    pub line_height: f32,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub scrollback: u32,
    pub copy_on_select: bool,
    pub right_click_paste: bool,
    pub confirm_close: bool,
    pub bell: String,
    /// shell for new local tabs (empty = detected default)
    pub default_shell: String,
    pub sftp_show_hidden: bool,
    /// where downloads go (empty = the Downloads folder)
    pub download_dir: String,
    pub restore_tabs: bool,
    pub stats_bar: bool,
    pub sidebar_width: u32,
    pub sidebar_open: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            appearance: "system".into(),
            accent: "#7aa2f7".into(),
            terminal_theme: "system".into(),
            font_family: "JetBrains Mono".into(),
            font_size: 13.0,
            line_height: 1.15,
            cursor_style: "bar".into(),
            cursor_blink: true,
            scrollback: 20_000,
            copy_on_select: true,
            right_click_paste: false,
            confirm_close: true,
            bell: "visual".into(),
            default_shell: String::new(),
            sftp_show_hidden: false,
            download_dir: String::new(),
            restore_tabs: false,
            stats_bar: true,
            sidebar_width: 300,
            sidebar_open: true,
        }
    }
}

/// Everything persisted, one JSON file each, in the app's config folder.
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> std::io::Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Store { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn load<T: for<'de> Deserialize<'de> + Default>(&self, name: &str) -> T {
        let path = self.dir.join(name);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                // keep the unreadable file instead of overwriting it on the next save
                let _ = std::fs::rename(&path, path.with_extension("json.broken"));
                tracing::warn!("{name} unreadable ({e}); starting fresh");
                T::default()
            }),
            Err(_) => T::default(),
        }
    }

    fn save<T: Serialize>(&self, name: &str, value: &T) -> std::io::Result<()> {
        let path = self.dir.join(name);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
        std::fs::rename(tmp, path)
    }

    pub fn sessions(&self) -> Vec<Session> {
        self.load("sessions.json")
    }
    pub fn save_sessions(&self, v: &[Session]) -> std::io::Result<()> {
        self.save("sessions.json", &v)
    }
    pub fn tunnels(&self) -> Vec<Tunnel> {
        self.load("tunnels.json")
    }
    pub fn save_tunnels(&self, v: &[Tunnel]) -> std::io::Result<()> {
        self.save("tunnels.json", &v)
    }
    pub fn snippets(&self) -> Vec<Snippet> {
        self.load("snippets.json")
    }
    pub fn save_snippets(&self, v: &[Snippet]) -> std::io::Result<()> {
        self.save("snippets.json", &v)
    }
    pub fn settings(&self) -> Settings {
        self.load("settings.json")
    }
    pub fn save_settings(&self, v: &Settings) -> std::io::Result<()> {
        self.save("settings.json", v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quick_connect() {
        let s = Session::parse_quick("root@10.0.0.1:2222").unwrap();
        assert_eq!((s.protocol, s.user.as_str(), s.host.as_str(), s.port), (Protocol::Ssh, "root", "10.0.0.1", 2222));
        let s = Session::parse_quick("example.com").unwrap();
        assert_eq!((s.host.as_str(), s.port, s.user.as_str()), ("example.com", 22, ""));
        let s = Session::parse_quick("rdp://admin@win-box").unwrap();
        assert_eq!((s.protocol, s.port), (Protocol::Rdp, 3389));
        let s = Session::parse_quick("[fe80::1]:23").unwrap();
        assert_eq!((s.host.as_str(), s.port), ("fe80::1", 23));
        let s = Session::parse_quick("fe80::1").unwrap();
        assert_eq!(s.host, "fe80::1");
        let s = Session::parse_quick("/dev/ttyUSB0@9600").unwrap();
        assert_eq!((s.protocol, s.device.as_str(), s.baud), (Protocol::Serial, "/dev/ttyUSB0", 9600));
        let s = Session::parse_quick("COM3").unwrap();
        assert_eq!(s.protocol, Protocol::Serial);
        assert!(Session::parse_quick("").is_none());
        assert!(Session::parse_quick("gopher://x").is_none());
    }
}

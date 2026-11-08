//! Local terminals: your shell, WSL, PowerShell, or a program like mosh, in a pseudo-terminal.

use std::io::{Read, Write};
use std::sync::Arc;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::model::{Protocol, Session};
use crate::shells;
use crate::term::Size;

pub struct Pty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

impl Pty {
    pub fn spawn(
        session: &Session,
        size: Size,
        default_shell: &str,
        on_output: impl Fn(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<Pty> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: size.rows, cols: size.cols, pixel_width: 0, pixel_height: 0 })
            .context("couldn't create a terminal")?;

        let argv: Vec<String> = match session.protocol {
            Protocol::Mosh => {
                let mut v = vec!["mosh".to_string()];
                if session.port != 0 && session.port != 22 {
                    v.push(format!("--ssh=ssh -p {}", session.port));
                }
                v.extend(shell_words(&session.command));
                let target = if session.user.is_empty() { session.host.clone() } else { format!("{}@{}", session.user, session.host) };
                v.push(target);
                v
            }
            _ if !session.command.trim().is_empty() => shell_words(&session.command),
            _ => shells::default_shell(default_shell),
        };
        let mut cmd = CommandBuilder::new(&argv[0]);
        cmd.args(&argv[1..]);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Tether");
        for (k, v) in &session.env {
            cmd.env(k, v);
        }
        let cwd = if session.cwd.trim().is_empty() { dirs::home_dir() } else { Some(crate::ssh::expand_home(session.cwd.trim())) };
        if let Some(cwd) = cwd.filter(|p| p.is_dir()) {
            cmd.cwd(cwd);
        }

        let mut child = pair.slave.spawn_command(cmd).with_context(|| format!("couldn't start {}", argv[0]))?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        std::thread::Builder::new().name("pty-read".into()).spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_output(&buf[..n]),
                }
            }
        })?;
        let on_exit = Arc::new(Mutex::new(Some(on_exit)));
        std::thread::Builder::new().name("pty-wait".into()).spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            if let Some(f) = on_exit.lock().take() {
                f(code);
            }
        })?;

        Ok(Pty { master: Mutex::new(pair.master), writer: Mutex::new(writer), killer: Mutex::new(killer) })
    }

    pub fn write(&self, data: &[u8]) {
        let mut w = self.writer.lock();
        let _ = w.write_all(data);
        let _ = w.flush();
    }

    pub fn resize(&self, size: Size) {
        let _ = self.master.lock().resize(PtySize { rows: size.rows, cols: size.cols, pixel_width: 0, pixel_height: 0 });
    }

    pub fn kill(&self) {
        let _ = self.killer.lock().kill();
    }
}

/// Split a command line like a shell would (quotes and backslashes), no expansion.
pub fn shell_words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') if matches!(chars.peek(), Some('"') | Some('\\')) => cur.push(chars.next().unwrap()),
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                has = true;
            }
            (None, '\\') if !cfg!(windows) => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    has = true;
                }
            }
            (None, c) if c.is_whitespace() => {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::shell_words;

    #[test]
    fn words() {
        assert_eq!(shell_words(r#"wsl.exe -d "Ubuntu 24.04" -- echo 'a b'"#), vec!["wsl.exe", "-d", "Ubuntu 24.04", "--", "echo", "a b"]);
        assert_eq!(shell_words("  zsh   -l "), vec!["zsh", "-l"]);
        assert_eq!(shell_words(r#"x "" y"#), vec!["x", "", "y"]);
    }
}

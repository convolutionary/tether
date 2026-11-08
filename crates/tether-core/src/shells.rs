//! Which local shells there are, for the "new local terminal" menu.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shell {
    pub name: String,
    /// command line to run
    pub command: String,
    /// "shell" | "wsl" | "powershell" | "cmd"
    pub kind: String,
}

/// argv for the user's default shell (or the configured one).
pub fn default_shell(configured: &str) -> Vec<String> {
    if !configured.trim().is_empty() {
        return crate::pty::shell_words(configured);
    }
    #[cfg(windows)]
    {
        for c in ["pwsh.exe", "powershell.exe"] {
            if in_path(c) {
                return vec![c.into(), "-NoLogo".into()];
            }
        }
        vec![std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())]
    }
    #[cfg(not(windows))]
    {
        let sh = std::env::var("SHELL").ok().filter(|s| std::path::Path::new(s).exists()).unwrap_or_else(|| "/bin/sh".into());
        vec![sh, "-l".into()]
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn in_path(bin: &str) -> bool {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file())).unwrap_or(false)
}

pub fn list() -> Vec<Shell> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
        if in_path("pwsh.exe") || std::path::Path::new(&format!(r"{pf}\PowerShell\7\pwsh.exe")).exists() {
            out.push(Shell { name: "PowerShell 7".into(), command: "pwsh.exe -NoLogo".into(), kind: "powershell".into() });
        }
        out.push(Shell { name: "Windows PowerShell".into(), command: "powershell.exe -NoLogo".into(), kind: "powershell".into() });
        out.push(Shell { name: "Command Prompt".into(), command: "cmd.exe".into(), kind: "cmd".into() });
        let git_bash = format!(r"{pf}\Git\bin\bash.exe");
        if std::path::Path::new(&git_bash).exists() {
            out.push(Shell { name: "Git Bash".into(), command: format!("\"{git_bash}\" --login -i"), kind: "shell".into() });
        }
        // WSL distributions (wsl -l -q prints UTF-16)
        use std::os::windows::process::CommandExt;
        if let Ok(o) = std::process::Command::new("wsl.exe").args(["-l", "-q"]).creation_flags(0x0800_0000).output() {
            let units: Vec<u16> = o.stdout.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            for name in String::from_utf16_lossy(&units).lines().map(|l| l.trim().trim_matches('\0')).filter(|l| !l.is_empty()) {
                out.push(Shell { name: format!("WSL · {name}"), command: format!("wsl.exe -d \"{name}\" --cd ~"), kind: "wsl".into() });
            }
        }
    }
    #[cfg(not(windows))]
    {
        let mut seen = std::collections::HashSet::new();
        let default = std::env::var("SHELL").unwrap_or_default();
        let mut paths: Vec<String> = std::fs::read_to_string("/etc/shells")
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with('/'))
            .map(String::from)
            .collect();
        if !default.is_empty() {
            paths.insert(0, default.clone());
        }
        for p in paths {
            let name = p.rsplit('/').next().unwrap_or(&p).to_string();
            if matches!(name.as_str(), "rbash" | "git-shell" | "nologin" | "false" | "screen" | "tmux") || !std::path::Path::new(&p).exists() || !seen.insert(name.clone()) {
                continue;
            }
            let label = if p == default { format!("{name} (default)") } else { name.clone() };
            out.push(Shell { name: label, command: format!("{p} -l"), kind: "shell".into() });
        }
    }
    out
}

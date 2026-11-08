//! On phiOS (HyDE), terminal colours follow the desktop theme: HyDE writes them for kitty on every
//! theme switch, and Tether reads the same file.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::{Core, Event};

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTheme {
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub cursor: Option<String>,
    pub selection_background: Option<String>,
    pub selection_foreground: Option<String>,
    /// color0..color15
    pub palette: Vec<Option<String>>,
}

fn kitty_theme_path() -> Option<PathBuf> {
    let base = dirs::config_dir()?;
    ["kitty/theme.conf", "kitty/current-theme.conf"].iter().map(|p| base.join(p)).find(|p| p.exists())
}

pub fn system_theme() -> Option<TerminalTheme> {
    let text = std::fs::read_to_string(kitty_theme_path()?).ok()?;
    let mut t = TerminalTheme { palette: vec![None; 16], ..Default::default() };
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(k), Some(v)) = (it.next(), it.next()) else { continue };
        if !v.starts_with('#') {
            continue;
        }
        let v = Some(v.to_string());
        match k {
            "foreground" => t.foreground = v,
            "background" => t.background = v,
            "cursor" => t.cursor = v,
            "selection_background" => t.selection_background = v,
            "selection_foreground" => t.selection_foreground = v,
            _ => {
                if let Some(n) = k.strip_prefix("color").and_then(|n| n.parse::<usize>().ok())
                    && n < 16
                {
                    t.palette[n] = v;
                }
            }
        }
    }
    (t.background.is_some() || t.foreground.is_some()).then_some(t)
}

impl Core {
    /// Watch the desktop theme and tell the UI when it changes.
    pub fn watch_system_theme(self: &Arc<Self>) {
        let core = self.clone();
        tokio::spawn(async move {
            let stamp = || kitty_theme_path().and_then(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
            let mut last: Option<SystemTime> = stamp();
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let now = stamp();
                if now != last {
                    last = now;
                    if let Some(theme) = system_theme() {
                        core.emit(Event::ThemeChanged { theme });
                    }
                }
            }
        });
    }
}

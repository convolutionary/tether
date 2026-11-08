//! Tether's engine: terminals (local, SSH, telnet, serial, mosh), SFTP, tunnels, VNC bridging,
//! RDP launching, imports. UI-agnostic: output and events go to a [`Sink`], questions for the
//! user (host keys, passwords, 2FA) go out as [`Event::Prompt`] and come back via [`Core::answer`].

pub mod import;
pub mod model;
pub mod prompt;
pub mod pty;
pub mod rdp;
pub mod secrets;
pub mod serial;
pub mod sftp;
pub mod shells;
pub mod ssh;
pub mod stats;
pub mod telnet;
pub mod term;
pub mod theme;
pub mod tunnel;
pub mod vnc;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use serde::Serialize;
use uuid::Uuid;

pub use model::*;
pub use prompt::{Answer, PromptKind, Prompter};

pub type TermId = u64;

/// Where the engine's output goes. Implemented by the UI layer.
pub trait Sink: Send + Sync + 'static {
    /// Bytes a terminal printed.
    fn output(&self, term: TermId, data: &[u8]);
    /// Everything else.
    fn event(&self, event: Event);
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    /// connection progress for a tab ("Connecting to …", "Authenticating …")
    #[serde(rename_all = "camelCase")]
    Status { term: TermId, text: String },
    /// the terminal's connection is up (ssh: SFTP and stats available)
    #[serde(rename_all = "camelCase")]
    Ready { term: TermId, remote: Option<RemoteInfo> },
    #[serde(rename_all = "camelCase")]
    Exit { term: TermId, code: Option<i32>, reason: String },
    /// a question for the user; answer with Core::answer(id, …)
    #[serde(rename_all = "camelCase")]
    Prompt { id: u64, term: Option<TermId>, prompt: PromptKind },
    #[serde(rename_all = "camelCase")]
    PromptDone { id: u64 },
    #[serde(rename_all = "camelCase")]
    Tunnel { id: Uuid, state: tunnel::TunnelState },
    #[serde(rename_all = "camelCase")]
    Transfer(sftp::TransferEvent),
    /// a file opened for editing was saved and uploaded again
    #[serde(rename_all = "camelCase")]
    EditSynced { term: TermId, path: String, error: Option<String> },
    /// the desktop's terminal colours changed (phiOS/HyDE theme switch)
    ThemeChanged { theme: theme::TerminalTheme },
    /// an external viewer (RDP) closed
    #[serde(rename_all = "camelCase")]
    ViewerExit { term: TermId, code: Option<i32> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub os: String,
    pub home: Option<String>,
    pub user: String,
    pub host: String,
}

pub struct Core {
    pub(crate) sink: Arc<dyn Sink>,
    pub prompter: Arc<Prompter>,
    pub store: Store,
    pub(crate) terms: Mutex<HashMap<TermId, Arc<term::Term>>>,
    pub(crate) tunnels: tunnel::Tunnels,
    pub(crate) transfers: sftp::Transfers,
    next_id: AtomicU64,
}

impl Core {
    pub fn new(sink: Arc<dyn Sink>, store: Store) -> Arc<Core> {
        let prompter = Arc::new(Prompter::new(sink.clone()));
        Arc::new(Core {
            sink,
            prompter,
            store,
            terms: Mutex::new(HashMap::new()),
            tunnels: tunnel::Tunnels::default(),
            transfers: sftp::Transfers::default(),
            next_id: AtomicU64::new(1),
        })
    }

    pub(crate) fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn emit(&self, e: Event) {
        self.sink.event(e);
    }

    /// Answer a prompt the UI was shown. `None` = cancelled.
    pub fn answer(&self, id: u64, answer: Option<Answer>) {
        self.prompter.answer(id, answer);
    }

    /// A saved session by id.
    pub fn session(&self, id: Uuid) -> Option<Session> {
        self.store.sessions().into_iter().find(|s| s.id == id)
    }

    pub(crate) fn term(&self, id: TermId) -> anyhow::Result<Arc<term::Term>> {
        self.terms.lock().get(&id).cloned().ok_or_else(|| anyhow::anyhow!("that tab is closed"))
    }

    /// Mark a session as just used (sorting "recent").
    pub fn touch(&self, id: Uuid) {
        let mut all = self.store.sessions();
        if let Some(s) = all.iter_mut().find(|s| s.id == id) {
            s.last_used = chrono::Utc::now().timestamp();
            let _ = self.store.save_sessions(&all);
        }
    }

    /// Close everything (app exit).
    pub async fn shutdown(&self) {
        let terms: Vec<_> = self.terms.lock().drain().map(|(_, t)| t).collect();
        for t in terms {
            t.close().await;
        }
        self.tunnels.stop_all().await;
    }
}

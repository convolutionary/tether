//! Questions for the user, asked through the UI and awaited by the engine.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::{Event, Sink, TermId};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PromptKind {
    /// unknown or changed server key
    #[serde(rename_all = "camelCase")]
    HostKey { host: String, port: u16, algorithm: String, fingerprint: String, changed: bool },
    /// login name (session saved without one)
    #[serde(rename_all = "camelCase")]
    Username { host: String },
    /// password; `remember` offers saving it in the OS keyring
    #[serde(rename_all = "camelCase")]
    Password { user: String, host: String, retry: bool, remember: bool },
    /// passphrase for a private key file
    #[serde(rename_all = "camelCase")]
    Passphrase { path: String, retry: bool },
    /// keyboard-interactive: one or more server prompts (OTP codes, Duo, …)
    #[serde(rename_all = "camelCase")]
    Interactive { host: String, name: String, instructions: String, fields: Vec<Field> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub label: String,
    pub echo: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    #[serde(default)]
    pub values: Vec<String>,
    /// save the password in the keyring / trust the host key permanently
    #[serde(default)]
    pub remember: bool,
}

impl Answer {
    pub fn first(&self) -> String {
        self.values.first().cloned().unwrap_or_default()
    }
}

pub struct Prompter {
    sink: Arc<dyn Sink>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Option<Answer>>>>,
    next: AtomicU64,
}

impl Prompter {
    pub(crate) fn new(sink: Arc<dyn Sink>) -> Self {
        Prompter { sink, pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) }
    }

    /// Ask and wait. `None` when the user cancels (or the UI goes away).
    pub async fn ask(&self, term: Option<TermId>, prompt: PromptKind) -> Option<Answer> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        self.sink.event(Event::Prompt { id, term, prompt });
        let answer = rx.await.ok().flatten();
        self.pending.lock().remove(&id);
        self.sink.event(Event::PromptDone { id });
        answer
    }

    pub(crate) fn answer(&self, id: u64, answer: Option<Answer>) {
        if let Some(tx) = self.pending.lock().remove(&id) {
            let _ = tx.send(answer);
        }
    }

    /// Cancel every open question of a tab (closed while asking).
    pub fn cancel_all(&self) {
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(None);
        }
    }
}

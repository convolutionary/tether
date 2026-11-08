//! Passwords live in the OS keyring (Secret Service on Linux, Credential Manager on Windows),
//! never in Tether's own files.

use uuid::Uuid;

const SERVICE: &str = "Tether";

fn entry(id: Uuid) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, &format!("session:{id}")).ok()
}

pub fn get(id: Uuid) -> Option<String> {
    entry(id)?.get_password().ok()
}

pub fn set(id: Uuid, secret: &str) -> anyhow::Result<()> {
    entry(id)
        .ok_or_else(|| anyhow::anyhow!("no keyring available"))?
        .set_password(secret)
        .map_err(|e| anyhow::anyhow!("couldn't save to the keyring: {e}"))
}

pub fn delete(id: Uuid) {
    if let Some(e) = entry(id) {
        let _ = e.delete_credential();
    }
}

/// Key passphrases, by key file path.
pub fn get_passphrase(path: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, &format!("key:{path}")).ok()?.get_password().ok()
}

pub fn set_passphrase(path: &str, secret: &str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, &format!("key:{path}")) {
        let _ = e.set_password(secret);
    }
}

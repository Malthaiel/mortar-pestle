//! Shared test utilities for integration tests.
//!
//! `AGENTIC_VAULT_ROOT` is process-wide global state; concurrent tests that
//! point it at different vaults race. Hold `env_lock()` while setting the var
//! and exercising vault-rooted code.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Take the global env lock. Holds for the test scope; released on drop.
pub fn env_lock() -> MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// Point `AGENTIC_VAULT_ROOT` at the given fixture path.
pub fn set_vault_root(path: &PathBuf) {
    std::env::set_var("AGENTIC_VAULT_ROOT", path.display().to_string());
}

/// Resolve a path under the crate's `tests/fixtures/` directory.
pub fn fixture_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(rel)
}

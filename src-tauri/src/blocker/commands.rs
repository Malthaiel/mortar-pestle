//! Shield blocker — Tauri commands (Sub-feature 1).
//!
//! `blocker_get_state` is the chrome's readout (toggle position + rule count);
//! `blocker_set_enabled` is the master switch. The chrome persists the flag in
//! its settings bag and replays it here on start, so backend state can stay
//! in-memory.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockerState {
    pub enabled: bool,
    pub host_rules: usize,
    pub scriptlet_rules: usize,
    pub allowlist: Vec<String>,
    /// Unix-seconds mtime of the last successful list refresh; None = vendored seed.
    pub lists_updated_at: Option<u64>,
}

#[tauri::command]
pub fn blocker_get_state() -> BlockerState {
    BlockerState {
        enabled: super::enabled(),
        host_rules: super::host_rule_count(),
        scriptlet_rules: super::scriptlets::rule_count(),
        allowlist: super::allowed_sites(),
        lists_updated_at: super::lists::cached_at(),
    }
}

#[tauri::command]
pub fn blocker_set_enabled(enabled: bool) {
    super::set_enabled(enabled);
    log::info!("blocker: enabled = {enabled}");
}

/// Add/remove a host from the per-site allow-list. The chrome persists its own
/// copy and replays these on start; reloading the tab re-applies the layers.
#[tauri::command]
pub fn blocker_set_site_allowed(host: String, allowed: bool) {
    super::set_site_allowed(&host, allowed);
    log::info!("blocker: site {host} allowed = {allowed}");
}

/// Refresh the host + cosmetic lists from the network (EasyList/EasyPrivacy),
/// hot-swap them, and return the updated state. Errs on fetch/parse failure,
/// leaving the current (cached or seed) lists intact.
#[tauri::command]
pub async fn blocker_refresh_lists() -> Result<BlockerState, String> {
    super::lists::refresh().await?;
    Ok(blocker_get_state())
}

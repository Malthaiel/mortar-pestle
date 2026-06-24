//! Sub-feature 3 — Vault-state reference endpoints (Update Queue, Log).

use serde::Serialize;

use crate::parsers::log::{get_log_entries, LogPage};
use crate::render;

#[derive(Serialize)]
pub struct UpdateQueueOut {
    pub html: String,
    pub mtime: f64,
}

#[tauri::command]
pub fn reference_get_vault_log(page: Option<u32>, size: Option<u32>) -> LogPage {
    let page = page.unwrap_or(1);
    let size = size.unwrap_or(50);
    get_log_entries(page, size)
}

#[tauri::command]
pub fn reference_render_update_queue() -> UpdateQueueOut {
    match render::render_path("Infrastructure/Vault State/Update Queue") {
        Ok(r) => UpdateQueueOut {
            html: r.html,
            mtime: r.mtime,
        },
        Err(_) => UpdateQueueOut {
            html: "<p><em>Update Queue.md not found</em></p>".to_string(),
            mtime: 0.0,
        },
    }
}

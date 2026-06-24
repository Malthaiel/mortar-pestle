//! Shared, persisted download-history store for the global Downloads popup.
//!
//! Both engines (`music_download`, `anime_download`) call `record(app, rec)` when
//! a job reaches a terminal state (done / error / cancelled). Records append to a
//! single JSON array at `<app_config>/downloads-history.json`, deduped by job id,
//! newest-first, hard-capped at `HARD_CAP` as a backstop. The popup loads it via
//! `downloads_history_load(cap, expiry_days)` — which prunes by the user's
//! retention settings — and trims rows via `downloads_history_clear(ids)`.
//!
//! "Clear" removes history ROWS only — it never touches downloaded media.
//!
//! Best-effort: a history-write failure is logged and swallowed — it must never
//! break a download. Mirrors `sidebar.rs`'s single-JSON + `WRITE_LOCK` pattern.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::sidebar::app_config_root;
use crate::commands::vault::{atomic_write, VaultError};

/// Serializes load→mutate→persist across the two engines' near-simultaneous
/// terminal events (a music + an anime job can finish at the same instant).
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Backstop so the file can't grow without bound even if the user sets a huge cap.
const HARD_CAP: usize = 1000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: String,
    /// "music" | "video"
    pub source: String,
    pub title: String,
    pub subtitle: String,
    /// "done" | "error" | "cancelled"
    pub state: String,
    #[serde(default)]
    pub cover: Option<String>,
    /// Epoch milliseconds.
    pub finished_at: i64,
    /// Vault-relative page path for "Open in library" navigation.
    #[serde(default)]
    pub open_path: Option<String>,
    /// Absolute folder path for "Reveal in files" (anime folder; music audio dir).
    #[serde(default)]
    pub reveal_path: Option<String>,
    /// Final total bytes on disk — the Downloads Manager SIZE column.
    #[serde(default)]
    pub size_bytes: Option<i64>,
    /// Destination folder — the Downloads Manager SAVE TO column.
    #[serde(default)]
    pub save_path: Option<String>,
    #[serde(default)]
    pub failed_count: i64,
    #[serde(default)]
    pub error: Option<String>,
    /// Full original enqueue-args blob, used to re-enqueue on Retry. Captured in
    /// Rust so the `#[serde(skip)]` engine fields (music `onlyMissing`, anime
    /// `downloadSource`) survive — they never reach JS via the live job.
    #[serde(default)]
    pub args: Value,
}

fn history_file(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(app_config_root(app)?.join("downloads-history.json"))
}

fn load_all(path: &Path) -> Vec<HistoryRecord> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<HistoryRecord>>(&text) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("downloads-history.json parse failed ({e}) — treating as empty");
            Vec::new()
        }
    }
}

fn persist(path: &Path, recs: &[HistoryRecord]) -> Result<(), VaultError> {
    let mut text = serde_json::to_string_pretty(recs)
        .map_err(|e| VaultError::Io(format!("serialize downloads-history.json: {e}")))?;
    text.push('\n');
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| VaultError::Io(format!("mkdir {parent:?}: {e}")))?;
    }
    atomic_write(path, text.as_bytes())
}

/// Epoch milliseconds. Shared with both engines so they don't each import
/// `SystemTime`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Engine-facing: append (or replace) a terminal job's record. Best-effort — any
/// failure is logged and swallowed.
pub fn record(app: &AppHandle, rec: HistoryRecord) {
    let _guard = WRITE_LOCK.lock().unwrap();
    let path = match history_file(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("downloads history: no path ({e:?})");
            return;
        }
    };
    let mut recs = load_all(&path);
    recs.retain(|r| r.id != rec.id); // dedupe by id (a retry reuses no ids; this guards re-finalize)
    recs.push(rec);
    recs.sort_by(|a, b| b.finished_at.cmp(&a.finished_at)); // newest first
    recs.truncate(HARD_CAP);
    if let Err(e) = persist(&path, &recs) {
        log::warn!("downloads history: write failed ({e:?})");
    }
}

/// Load history, pruning by the user's retention policy (cap + age). `expiry_days
/// == 0` keeps everything regardless of age. Persists the pruned set back only
/// when pruning actually removed something, so a plain read is usually write-free.
#[tauri::command]
pub fn downloads_history_load(
    app: AppHandle,
    cap: usize,
    expiry_days: u32,
) -> Result<Vec<HistoryRecord>, VaultError> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let path = history_file(&app)?;
    let mut recs = load_all(&path);
    let before = recs.len();
    if expiry_days > 0 {
        let cutoff = now_ms() - (expiry_days as i64) * 86_400_000;
        recs.retain(|r| r.finished_at >= cutoff);
    }
    recs.sort_by(|a, b| b.finished_at.cmp(&a.finished_at));
    recs.truncate(cap.clamp(1, HARD_CAP));
    if recs.len() != before {
        let _ = persist(&path, &recs);
    }
    Ok(recs)
}

/// Remove specific rows by id (or every row when `ids` is None). Removes history
/// entries only — never deletes downloaded media.
#[tauri::command]
pub fn downloads_history_clear(app: AppHandle, ids: Option<Vec<String>>) -> Result<(), VaultError> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let path = history_file(&app)?;
    match ids {
        None => persist(&path, &[]),
        Some(ids) => {
            let mut recs = load_all(&path);
            recs.retain(|r| !ids.contains(&r.id));
            persist(&path, &recs)
        }
    }
}

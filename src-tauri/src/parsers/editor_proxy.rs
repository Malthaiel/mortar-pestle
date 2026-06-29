//! Editor remux lane (Video Editor — Host Extensions § Editor remux lane).
//!
//! The player lane (`video_transcode.rs`) is built for ONE active playback:
//! kill-prior semantics + a 3-file/5 GB LRU + exit-wipe. All three break
//! multi-clip editing, so the editor gets its own lane:
//!
//! - **No active slot, no kill-prior** — imports remux sequentially (the JS
//!   import queue serializes), and nothing SIGTERMs a prior child.
//! - **No LRU, no exit-wipe** — proxies live in
//!   `~/.cache/mortar-pestle/editor-proxies/` (sibling of the player cache) and
//!   survive app restarts; reopening a project re-pins instantly off disk.
//! - **Pinning + byte budget, Phase 1 shape** — hashes referenced by the open
//!   project are pinned (never evicted); a const 20 GB budget is ACCOUNTED
//!   and surfaced (`accounted_bytes`), warning only. Unpinned-LRU eviction is
//!   deferred until multi-project usage — no eviction pass here.
//! - **Crash-safe files** — ffmpeg writes `<hash>.mp4.part`; the supervisor
//!   renames to `<hash>.mp4` only on exit 0. The restart fast-path can
//!   therefore trust any final-named file (the player lane instead relies on
//!   its exit-wipe to avoid trusting truncated files).
//!
//! Same hash key as the player lane (`compute_hash`: sha1-16 of
//! `abs|audio|mtime_ms`) so project JSON can reference hashes stably.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use super::video_transcode::{spawn_ffmpeg_to_file, EntryStatus, ProxyScale};
use crate::commands::vault::VaultError;

/// Accounting budget (warning surface only — nothing is evicted in Phase 1).
pub const BYTE_BUDGET: u64 = 20 * 1024 * 1024 * 1024;

struct ProxyEntry {
    path: PathBuf,
    started_at: Instant,
    status: EntryStatus,
    pinned: bool,
}

fn registry() -> &'static Mutex<HashMap<String, ProxyEntry>> {
    static CELL: OnceLock<Mutex<HashMap<String, ProxyEntry>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, ProxyEntry>> {
    registry().lock().unwrap_or_else(|p| p.into_inner())
}

pub fn cache_root() -> Result<PathBuf, VaultError> {
    let base = dirs::cache_dir().ok_or_else(|| VaultError::Io("cache_dir() unavailable".into()))?;
    Ok(base.join("mortar-pestle/editor-proxies"))
}

pub fn proxy_path(hash: &str) -> Result<PathBuf, VaultError> {
    let dir = cache_root()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| VaultError::Io(format!("mkdir editor-proxies: {e}")))?;
    Ok(dir.join(format!("{hash}.mp4")))
}

/// Start a remux for `hash`, or reuse: a Done entry, an in-flight Running
/// entry (the command's await loop picks it up), or a completed file already
/// on disk from a prior app run (restart re-pin without re-remux).
/// `proxy: Some` is the >1080p preview re-encode recipe (Color Grading SF2);
/// the hash key already encodes the recipe, so reuse stays correct.
pub fn start_or_reuse(
    hash: String,
    abs: String,
    audio: Option<i64>,
    copy_audio: bool,
    proxy: Option<ProxyScale>,
) -> Result<(), VaultError> {
    let final_path = proxy_path(&hash)?;
    {
        let r = lock();
        if let Some(e) = r.get(&hash) {
            match e.status {
                EntryStatus::Done if e.path.exists() => return Ok(()),
                EntryStatus::Running => return Ok(()), // in flight — caller awaits
                _ => {} // Failed or Done-with-missing-file → respawn below
            }
        }
    }
    if final_path.exists() {
        let mut r = lock();
        r.insert(
            hash,
            ProxyEntry {
                path: final_path,
                started_at: Instant::now(),
                status: EntryStatus::Done,
                pinned: false,
            },
        );
        return Ok(());
    }

    let part = final_path.with_extension("mp4.part");
    let _ = std::fs::remove_file(&part);
    let child = spawn_ffmpeg_to_file(&abs, audio, &part, copy_audio, proxy.as_ref())?;
    let started_at = Instant::now();
    {
        let mut r = lock();
        r.insert(
            hash.clone(),
            ProxyEntry {
                path: final_path.clone(),
                started_at,
                status: EntryStatus::Running,
                pinned: false,
            },
        );
    }
    tauri::async_runtime::spawn(async move {
        let output = child.wait_with_output().await;
        let (exit_code, stderr_tail) = match output {
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                let tail: String = stderr
                    .chars()
                    .rev()
                    .take(400)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
                (o.status.code(), tail)
            }
            Err(e) => (None, format!("wait error: {e}")),
        };
        let new_status = if exit_code == Some(0) {
            match std::fs::rename(&part, &final_path) {
                Ok(()) => EntryStatus::Done,
                Err(e) => {
                    let _ = std::fs::remove_file(&part);
                    EntryStatus::Failed {
                        exit_code: Some(0),
                        stderr_tail: format!("rename part→final: {e}"),
                    }
                }
            }
        } else {
            let _ = std::fs::remove_file(&part);
            EntryStatus::Failed {
                exit_code,
                stderr_tail,
            }
        };
        let mut r = lock();
        // Stale-write guard (same pattern as the player lane's supervisor).
        if let Some(entry) = r.get_mut(&hash) {
            if entry.started_at == started_at {
                entry.status = new_status;
            }
        }
    });
    Ok(())
}

pub fn status_of(hash: &str) -> Option<EntryStatus> {
    lock().get(hash).map(|e| e.status.clone())
}

/// Path + status snapshot for the media-server route. No last-served
/// bookkeeping — there is no LRU in this lane.
pub fn snapshot_for_serve(hash: &str) -> Option<(PathBuf, EntryStatus)> {
    lock().get(hash).map(|e| (e.path.clone(), e.status.clone()))
}

pub fn pin(hash: &str) {
    if let Some(e) = lock().get_mut(hash) {
        e.pinned = true;
    }
}

pub fn release(hashes: &[String]) {
    let mut r = lock();
    for h in hashes {
        if let Some(e) = r.get_mut(h) {
            e.pinned = false;
        }
    }
}

/// Disk-truth byte accounting for the budget warning (registry entries may
/// not cover files from prior runs).
pub fn accounted_bytes() -> u64 {
    let Ok(dir) = cache_root() else { return 0 };
    let Ok(rd) = std::fs::read_dir(&dir) else { return 0 };
    rd.flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

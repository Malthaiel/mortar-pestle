//! In-app updater (Stage 2 of Iskariel/Decisions/2026-05-23 In-App Update Mechanism).
//!
//! Caches the SHA-256 of the running binary at startup, then a 30s
//! background task hashes the on-disk binary and emits `update-available`
//! when the disk content diverges from the cached value. Companion
//! `app_self_apply_update` restarts into the new binary; `app_self_revert`
//! atomically swaps `iskariel.prev` back into place and restarts.
//!
//! Rotation of `iskariel` -> `.prev` -> `.prev2` happens in the
//! pre-build hook at `scripts/rotate-binary.mjs`, chained into
//! `tauri.conf.json::beforeBuildCommand`.

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

const DEFAULT_POLL_INTERVAL_SECS: u64 = 30;
const MIN_POLL_INTERVAL_SECS: u64 = 10;
const MAX_POLL_INTERVAL_SECS: u64 = 3600;
const FOCUS_SKIP_THRESHOLD_SECS: u64 = 300;
const HASH_PREFIX_LEN: usize = 16;

static CURRENT_SHA: OnceLock<String> = OnceLock::new();
static BINARY_PATH: OnceLock<PathBuf> = OnceLock::new();
static LAST_AVAILABLE: AtomicBool = AtomicBool::new(false);
static FOCUSED: AtomicBool = AtomicBool::new(true);
static LAST_FOCUS_CHANGE_SECS: AtomicU64 = AtomicU64::new(0);
static POLL_INTERVAL_SECS: AtomicU64 = AtomicU64::new(DEFAULT_POLL_INTERVAL_SECS);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SelfUpdateStatus {
    pub available: bool,
    pub current_sha256_prefix: String,
    pub disk_sha256_prefix: String,
    pub disk_size: u64,
    pub disk_mtime_secs: Option<u64>,
    pub prev_exists: bool,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hash_file(path: &PathBuf) -> std::io::Result<(String, u64)> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    let mut total: u64 = 0;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn prefix(s: &str) -> String {
    s.chars().take(HASH_PREFIX_LEN).collect()
}

/// Cache the running binary path + SHA-256. Call once at startup.
/// If this fails, the check command returns Err and the poll loop logs and
/// continues — the rest of the app keeps working.
pub fn init_cache() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("self_update::init_cache: current_exe failed: {e}");
            return;
        }
    };
    let canonical = fs::canonicalize(&exe).unwrap_or(exe);
    match hash_file(&canonical) {
        Ok((digest, _size)) => {
            let _ = BINARY_PATH.set(canonical);
            let _ = CURRENT_SHA.set(digest);
        }
        Err(e) => {
            eprintln!("self_update::init_cache: hash failed: {e}");
        }
    }
}

fn check_inner() -> Result<SelfUpdateStatus, String> {
    let path = BINARY_PATH
        .get()
        .ok_or_else(|| "binary path not initialized".to_string())?;
    let current_hash = CURRENT_SHA
        .get()
        .ok_or_else(|| "current hash not initialized".to_string())?;

    let (disk_hash, disk_size) = hash_file(path).map_err(|e| format!("hash disk: {e}"))?;
    let mtime_secs = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let prev_exists = path
        .parent()
        .map(|p| p.join("iskariel.prev").exists())
        .unwrap_or(false);

    Ok(SelfUpdateStatus {
        available: disk_hash != *current_hash,
        current_sha256_prefix: prefix(current_hash),
        disk_sha256_prefix: prefix(&disk_hash),
        disk_size,
        disk_mtime_secs: mtime_secs,
        prev_exists,
    })
}

#[tauri::command]
pub fn app_self_check_update() -> Result<SelfUpdateStatus, String> {
    check_inner()
}

#[tauri::command]
pub fn app_self_apply_update(
    app: AppHandle,
    expected_sha256_prefix: String,
) -> Result<(), String> {
    let status = check_inner()?;
    if !status.available {
        return Err("no update available".into());
    }
    if status.disk_sha256_prefix != expected_sha256_prefix {
        return Err(format!(
            "binary changed since notification (expected {}, got {})",
            expected_sha256_prefix, status.disk_sha256_prefix
        ));
    }
    app.restart();
}

/// Unconditional restart into the on-disk binary. Used by the network updater
/// (`plugin-updater`) after it has downloaded + installed a newer signed
/// release, to relaunch into it — mirrors the `app.restart()` path that
/// `app_self_apply_update` uses for the local dev-build flow (no extra
/// dependency vs. tauri-plugin-process).
#[tauri::command]
pub fn app_relaunch(app: AppHandle) -> Result<(), String> {
    app.restart();
}

/// Updates the background poll cadence. Validates `secs` against the
/// [`MIN_POLL_INTERVAL_SECS`]..=[`MAX_POLL_INTERVAL_SECS`] window so a
/// runaway setting can't peg the CPU or silently disable update checks.
/// The poll loop re-reads the atomic each iteration, so the new cadence
/// takes effect on the next tick (worst case: one full prior-cadence wait).
#[tauri::command]
pub fn app_self_set_poll_interval(secs: u64) -> Result<(), String> {
    if secs < MIN_POLL_INTERVAL_SECS || secs > MAX_POLL_INTERVAL_SECS {
        return Err(format!(
            "poll interval must be {MIN_POLL_INTERVAL_SECS}..={MAX_POLL_INTERVAL_SECS} seconds, got {secs}"
        ));
    }
    POLL_INTERVAL_SECS.store(secs, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn app_self_revert(app: AppHandle) -> Result<(), String> {
    let current = BINARY_PATH
        .get()
        .ok_or_else(|| "binary path not initialized".to_string())?
        .clone();
    let dir = current
        .parent()
        .ok_or_else(|| "no parent dir".to_string())?
        .to_path_buf();
    let prev = dir.join("iskariel.prev");
    if !prev.exists() {
        return Err("no previous binary to revert to".into());
    }
    let tmp = dir.join("iskariel.tmp_revert");

    // 3-rename atomic swap. Each rename is atomic on the same filesystem;
    // partial failure rolls back best-effort and surfaces the original error.
    if let Err(e) = fs::rename(&current, &tmp) {
        return Err(format!("revert step 1 (current -> tmp): {e}"));
    }
    if let Err(e) = fs::rename(&prev, &current) {
        let _ = fs::rename(&tmp, &current);
        return Err(format!("revert step 2 (prev -> current): {e}"));
    }
    if let Err(e) = fs::rename(&tmp, &prev) {
        let _ = fs::rename(&current, &prev);
        let _ = fs::rename(&tmp, &current);
        return Err(format!("revert step 3 (tmp -> prev): {e}"));
    }
    app.restart();
}

/// Called from the on_window_event handler so the poll loop can skip work
/// when the user has backgrounded the window for >5 min.
pub fn record_focus_change(focused: bool) {
    FOCUSED.store(focused, Ordering::Relaxed);
    LAST_FOCUS_CHANGE_SECS.store(now_secs(), Ordering::Relaxed);
}

fn should_skip_poll() -> bool {
    if FOCUSED.load(Ordering::Relaxed) {
        return false;
    }
    let last = LAST_FOCUS_CHANGE_SECS.load(Ordering::Relaxed);
    if last == 0 {
        return false;
    }
    now_secs().saturating_sub(last) > FOCUS_SKIP_THRESHOLD_SECS
}

/// Spawn the background poll task. Call from `setup` after `init_cache`.
pub fn spawn_poll(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Ok(s) = check_inner() {
            LAST_AVAILABLE.store(s.available, Ordering::Relaxed);
        }
        loop {
            let secs = POLL_INTERVAL_SECS.load(Ordering::Relaxed);
            tokio::time::sleep(Duration::from_secs(secs)).await;
            if should_skip_poll() {
                continue;
            }
            let status = match check_inner() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("self_update poll: {e}");
                    continue;
                }
            };
            let was = LAST_AVAILABLE.swap(status.available, Ordering::Relaxed);
            if status.available && !was {
                if let Err(e) = app.emit("update-available", &status) {
                    eprintln!("self_update emit: {e}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn hash_file_distinct_for_different_content() {
        let mut a = NamedTempFile::new().unwrap();
        a.write_all(b"hello world").unwrap();
        a.flush().unwrap();
        let mut b = NamedTempFile::new().unwrap();
        b.write_all(b"hello mars ").unwrap();
        b.flush().unwrap();
        let (ha, _) = hash_file(&a.path().to_path_buf()).unwrap();
        let (hb, _) = hash_file(&b.path().to_path_buf()).unwrap();
        assert_ne!(ha, hb);
    }

    #[test]
    fn hash_file_stable_for_same_content() {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(b"deterministic content").unwrap();
        f.flush().unwrap();
        let (h1, s1) = hash_file(&f.path().to_path_buf()).unwrap();
        let (h2, s2) = hash_file(&f.path().to_path_buf()).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(s1, s2);
        assert_eq!(s1, 21);
    }

    #[test]
    fn prefix_handles_short_hash() {
        assert_eq!(prefix("abc"), "abc");
        assert_eq!(prefix("0123456789abcdef0123"), "0123456789abcdef");
    }
}

//! 5-SF4d — the Game Capture Tauri command surface.
//!
//! The **Step-4 set (7 commands)**: `get_capture_state`, `capture_start`,
//! `capture_stop`, `capture_list_clips`, `capture_rebind_hotkeys`,
//! `capture_open_kde_settings`, `set_capture_config`. Phase 2 adds the ring ops
//! (`capture_arm` / `capture_disarm` / `capture_save_replay`) and clip delete
//! (`capture_clip_delete`, 3-SF3 — routes a clip into the global Recycle Bin).
//! The one still-deferred command is `capture_clip_meta` (3-SF4, clip
//! poster/metadata) — it lands when that engine sub-feature does, re-touching all
//! four registration sites.
//!
//! Every command routes mutating ops through the supervisor's single shared
//! [`CaptureClient`] via the generic `request(op, args)` (the client exposes no
//! typed `start_clip`/`stop_clip`/`set_config` wrapper). A
//! [`CaptureError`](crate::capture::client::CaptureError) is mapped to the house
//! [`VaultError`] at the boundary. `get_capture_state`/`capture_list_clips`
//! degrade gracefully when the engine is down (the UI shows an empty/idle state
//! rather than throwing) — gate `(5b)`.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::capture::client::{CaptureConfig, CaptureError, StateSnapshot};
use crate::capture::{supervisor, CONFIG_FILE};
use crate::commands::sidebar::app_config_root;
use crate::commands::vault::{atomic_write, library_vault_root, VaultError};

/// Map a [`CaptureError`] to the house [`VaultError`]. `Disconnected` →
/// `NotFound` (the engine isn't up); everything else → `Io` with the message.
fn map_err(e: CaptureError) -> VaultError {
    match e {
        CaptureError::Disconnected => {
            VaultError::NotFound("capture engine not running".into())
        }
        other => VaultError::Io(other.to_string()),
    }
}

/// The shared client, or `Disconnected`→`NotFound` when the supervisor never
/// started (stable tier / engine absent).
fn require_client() -> Result<crate::capture::client::CaptureClient, VaultError> {
    supervisor::client().ok_or_else(|| VaultError::NotFound("capture engine not running".into()))
}

/// `get_capture_state` — the authoritative [`StateSnapshot`] (sole UI truth).
/// Returns `Ok(None)` when the engine is unavailable so the frontend renders an
/// idle/empty state instead of treating engine-down as an error (gate `(5b)`).
#[tauri::command]
pub async fn get_capture_state() -> Result<Option<StateSnapshot>, VaultError> {
    let Some(client) = supervisor::client() else {
        return Ok(None);
    };
    match client.get_state().await {
        Ok(snap) => Ok(Some(snap)),
        // Engine down / not yet up — not an error to the UI; show empty state.
        Err(CaptureError::Disconnected) | Err(CaptureError::Timeout) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// `capture_start` — begin a clip (socket op `start_clip`). Returns the fresh
/// [`StateSnapshot`] the engine echoes (the mutation's snapshot is UI truth).
#[tauri::command]
pub async fn capture_start() -> Result<Option<StateSnapshot>, VaultError> {
    let client = require_client()?;
    let data = client.request("start_clip", Value::Null).await.map_err(map_err)?;
    Ok(decode_optional_snapshot(data))
}

/// `capture_stop` — finalize the active clip (socket op `stop_clip`). Returns
/// the echoed [`StateSnapshot`].
#[tauri::command]
pub async fn capture_stop() -> Result<Option<StateSnapshot>, VaultError> {
    let client = require_client()?;
    let data = client.request("stop_clip", Value::Null).await.map_err(map_err)?;
    Ok(decode_optional_snapshot(data))
}

/// `capture_arm` — start the instant-replay ring (socket op `arm`): the engine
/// begins encoding into the in-RAM ring (no file written). Returns the echoed
/// [`StateSnapshot`] (`armed: true`).
#[tauri::command]
pub async fn capture_arm() -> Result<Option<StateSnapshot>, VaultError> {
    let client = require_client()?;
    let data = client.request("arm", Value::Null).await.map_err(map_err)?;
    Ok(decode_optional_snapshot(data))
}

/// `capture_disarm` — stop + free the replay ring (socket op `disarm`).
#[tauri::command]
pub async fn capture_disarm() -> Result<Option<StateSnapshot>, VaultError> {
    let client = require_client()?;
    let data = client.request("disarm", Value::Null).await.map_err(map_err)?;
    Ok(decode_optional_snapshot(data))
}

/// `capture_save_replay` — save the armed ring (socket op `save_replay`).
/// `window_secs` `None` → the whole window; `Some(30)` → a last-30s quick-save.
/// The clip arrives via the `capture-saved` event (the save runs off-thread).
#[tauri::command]
pub async fn capture_save_replay(window_secs: Option<u32>) -> Result<Option<StateSnapshot>, VaultError> {
    let client = require_client()?;
    let args = match window_secs {
        Some(n) => json!({ "windowSecs": n }),
        None => Value::Null,
    };
    let data = client.request("save_replay", args).await.map_err(map_err)?;
    Ok(decode_optional_snapshot(data))
}

/// `capture_screenshot` — grab a full-screen screenshot (socket op `screenshot`).
/// Returns the echoed [`StateSnapshot`] ack; the saved PNG path arrives via the
/// `capture-screenshot-saved` Tauri event (the portal grab runs off-thread, like
/// the `save_replay` → `capture-saved` path). The overlay reads the path to offer
/// scoreboard auto-fill during a live scrim.
#[tauri::command]
pub async fn capture_screenshot() -> Result<Option<StateSnapshot>, VaultError> {
    let client = require_client()?;
    let data = client.request("screenshot", Value::Null).await.map_err(map_err)?;
    Ok(decode_optional_snapshot(data))
}

/// One clip delete's result — the bin tombstone id powers the undo Toast's Restore.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipDeleteOut {
    pub ok: bool,
    pub bin_id: String,
}

/// `capture_clip_delete` — soft-delete a clip into the global Recycle Bin (3-SF3).
/// `path` is the clip's absolute path (from `capture_list_clips`) and must resolve
/// under the Library mount. Returns the bin id so the Capture page can offer an
/// in-Toast Restore. Routes through `recycle_bin::trash_clip` (instant `fs::rename`
/// on the shared `/home` filesystem — even multi-GB clips move for free).
#[tauri::command]
pub fn capture_clip_delete(app: AppHandle, path: String) -> Result<ClipDeleteOut, VaultError> {
    let lib = std::fs::canonicalize(library_vault_root())
        .unwrap_or_else(|_| PathBuf::from(library_vault_root()));
    let abs = std::fs::canonicalize(&path)
        .map_err(|_| VaultError::NotFound(format!("clip not found: {path}")))?;
    let rel = abs
        .strip_prefix(&lib)
        .map_err(|_| VaultError::Invalid("clip is not under the Library".into()))?
        .to_string_lossy()
        .replace('\\', "/");
    let bin_id =
        crate::commands::recycle_bin::trash_clip(&app, Some("library".into()), &rel, &abs)?;
    Ok(ClipDeleteOut { ok: true, bin_id })
}

/// `capture_rebind_hotkeys` — ask the engine to re-run its GlobalShortcuts bind
/// (socket op `rebind_hotkeys`). Returns the echoed [`StateSnapshot`] (its
/// `hotkeys` block reflects the rebind). The engine owns the portal handshake;
/// this is a thin pass-through. Full verification is the Step-8 `(5-SF4)` gate.
#[tauri::command]
pub async fn capture_rebind_hotkeys() -> Result<Option<StateSnapshot>, VaultError> {
    let client = require_client()?;
    let data = client.request("rebind_hotkeys", Value::Null).await.map_err(map_err)?;
    Ok(decode_optional_snapshot(data))
}

/// Best-effort decode of a mutation's response `data` into a [`StateSnapshot`].
/// The mutations echo a snapshot, but a decode miss is non-fatal — the frontend
/// re-fetches via `get_capture_state` / the `capture-state` event, so a `None`
/// here just means "no inline snapshot" rather than an error.
fn decode_optional_snapshot(data: Option<Value>) -> Option<StateSnapshot> {
    data.and_then(|v| serde_json::from_value(v).ok())
}

/// `set_capture_config` — persist the engine config + best-effort push it.
///
/// **File is persistence-of-record** (config contract): `atomic_write` the
/// camelCase JSON to `app_config_root(app)/iskariel-capture.json` (precedent
/// `vault.rs::atomic_write` + `sidebar.rs::app_config_root`). Then a best-effort
/// `set_config` socket push so a running engine picks it up live — a failed push
/// is logged, never surfaced (the file already holds the truth; the supervisor
/// also re-pushes on its next (re)connect).
#[tauri::command]
pub async fn set_capture_config(app: AppHandle, config: Value) -> Result<(), VaultError> {
    // Validate the shape before persisting: the config must deserialize into the
    // engine's camelCase `CaptureConfig`. A malformed / partial / snake_case
    // object is rejected to the caller — a bad config must NOT silently become
    // the record-of-truth and then `bad_request` on every engine push.
    serde_json::from_value::<CaptureConfig>(config.clone())
        .map_err(|e| VaultError::Io(format!("invalid capture config: {e}")))?;

    // Persist first (the record of truth).
    let path = config_file(&app)?;
    let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|e| VaultError::Io(format!("encode capture config: {e}")))?;
    atomic_write(&path, &bytes)?;

    // Best-effort live push (engine may be down — that's fine, file persisted).
    if let Some(client) = supervisor::client() {
        match client.request("set_config", config).await {
            Ok(_) => {}
            Err(e) => log::debug!("capture: set_config live push skipped ({e})"),
        }
    }
    Ok(())
}

/// The persisted-config path: `app_config_root(app)/iskariel-capture.json`. Shared
/// shape with the supervisor's reader (`capture::CONFIG_FILE`).
fn config_file(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(app_config_root(app)?.join(CONFIG_FILE))
}

/// `capture_open_kde_settings` — open KDE System Settings at the global-shortcuts
/// KCM (`kcm_keys`) so the user can rebind the capture hotkeys.
///
/// The opener plugin (`open_url`/`open_path`) can't pass a KCM module argument,
/// so this launches the KDE settings shell directly via `std::process::Command`
/// (no new dependency, NOT `tauri-plugin-shell`). KDE 6 → 5 fallback chain;
/// best-effort. The Step-4 gate `(5d)` only requires the command to invoke
/// without not-allowed/not-found — full "opens the KCM" verification is the
/// Step-8 `(5-SF4)` gate.
#[tauri::command]
pub fn capture_open_kde_settings() -> Result<(), VaultError> {
    // First launcher that spawns wins. `kcm_keys` is the global-shortcuts KCM.
    const CANDIDATES: &[(&str, &[&str])] = &[
        ("systemsettings", &["kcm_keys"]),
        ("systemsettings5", &["kcm_keys"]),
        ("kcmshell6", &["kcm_keys"]),
        ("kcmshell5", &["kcm_keys"]),
    ];
    for (bin, args) in CANDIDATES {
        match std::process::Command::new(bin).args(*args).spawn() {
            Ok(_) => return Ok(()),
            Err(_) => continue, // not installed under this name — try the next
        }
    }
    Err(VaultError::NotFound(
        "KDE System Settings not found (tried systemsettings/kcmshell)".into(),
    ))
}

/// One clip in the metadata-only listing (`capture_list_clips`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMeta {
    /// Absolute path to the clip file.
    pub path: String,
    /// Basename (e.g. `Deadlock 2026-06-15 21-03-11.mp4`).
    pub name: String,
    /// File size in bytes.
    pub size_bytes: u64,
    /// Modified time in epoch milliseconds (newest-first sort key).
    pub mtime: u64,
    /// Sibling poster `.jpg` (same stem) if the engine extracted one; `None`
    /// leaves the placeholder box (3-SF4).
    pub poster: Option<String>,
}

/// `capture_list_clips` — metadata-only scan of `ISKARIEL_CAPTURES_DIR`
/// (`library_vault_root()/Captures`) for video files, newest-first. App-UI-owned
/// (the Library has no watcher; the live clip-list signal is `capture-saved`).
/// Recurses one level into per-game subfolders (the engine groups clips by game).
/// Never throws on a missing dir — returns an empty list (gate `(5b)`). No probe
/// here: duration/poster are the Step-8 `capture_clip_meta` (3-SF4) job.
#[tauri::command]
pub fn capture_list_clips() -> Result<Vec<ClipMeta>, VaultError> {
    let root = PathBuf::from(library_vault_root()).join("Captures");
    let mut clips = Vec::new();
    collect_clips(&root, &mut clips);
    // Recurse one level into subdirectories (per-game folders).
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                collect_clips(&p, &mut clips);
            }
        }
    }
    // Newest-first.
    clips.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(clips)
}

/// Push every video file directly under `dir` into `out` as [`ClipMeta`].
/// Missing dir / unreadable entries are skipped silently.
fn collect_clips(dir: &std::path::Path, out: &mut Vec<ClipMeta>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_video_file(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let size_bytes = meta.len();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        // Sibling poster `<stem>.jpg` the engine extracted at save (3-SF4).
        let poster = {
            let jpg = path.with_extension("jpg");
            jpg.is_file().then(|| jpg.to_string_lossy().into_owned())
        };
        out.push(ClipMeta {
            path: path.to_string_lossy().into_owned(),
            name,
            size_bytes,
            mtime,
            poster,
        });
    }
}

/// A capture clip file: `.mp4` (final) or `.h264` (SF1-interim ES). Mirrors the
/// `saved` payload's tolerance — an interim `.h264` is still a listable clip.
fn is_video_file(path: &std::path::Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("mp4") | Some("h264")
    )
}

/// Derive the `capture-saved` Tauri payload from the engine's `saved` event
/// `data` (the bridge in `lib.rs` calls this). The wire payload omits
/// `name`/`sizeBytes`/`mtime`; this enriches it with those, derived from the
/// (possibly not-yet-existing) `path` — the only live clip-list signal the
/// Library surface gets. Returns the engine `data` unchanged plus the three
/// derived fields merged in; a non-object `data` passes through untouched.
pub fn enrich_saved(mut data: Value) -> Value {
    let Some(obj) = data.as_object_mut() else {
        return data;
    };
    if let Some(path) = obj.get("path").and_then(|v| v.as_str()).map(PathBuf::from) {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        // `path` may not exist yet at emit time on some interim builds — derive
        // size/mtime when the file is present, default to 0 otherwise.
        let (size_bytes, mtime) = std::fs::metadata(&path)
            .ok()
            .map(|m| {
                let size = m.len();
                let mt = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                (size, mt)
            })
            .unwrap_or((0, 0));
        obj.insert("name".into(), json!(name));
        obj.insert("sizeBytes".into(), json!(size_bytes));
        obj.insert("mtime".into(), json!(mtime));
    }
    data
}

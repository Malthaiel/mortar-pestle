//! Broadcast SP2 — the Tauri command surface over the Broadcast engine.
//!
//! Faithful clone of `commands/capture.rs` shapes: `map_err` + `require_client`
//! headers, graceful-degrade reads (`Ok(None)` on a down engine — never an
//! error to the UI), thin `client.request(op, args)` mutations. The display
//! trio composes `broadcast::display_host` (app-owned child HWND) with the
//! engine's ephemeral display verbs; JS sends rounded LOGICAL px and the host
//! module owns the ×scale_factor conversion.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::broadcast::client::{BroadcastClient, BroadcastError, StateSnapshot};
use crate::broadcast::supervisor;
use crate::commands::vault::VaultError;

/// Map a [`BroadcastError`] to the house [`VaultError`]. `Disconnected` →
/// `NotFound` (the engine isn't up); everything else → `Io` with the message.
fn map_err(e: BroadcastError) -> VaultError {
    match e {
        BroadcastError::Disconnected => VaultError::NotFound("broadcast engine not running".into()),
        other => VaultError::Io(other.to_string()),
    }
}

/// The shared client, or `Disconnected`→`NotFound` when the supervisor never
/// started (stable tier / engine absent).
fn require_client() -> Result<BroadcastClient, VaultError> {
    supervisor::client().ok_or_else(|| VaultError::NotFound("broadcast engine not running".into()))
}

/// `broadcast_get_state` — the authoritative [`StateSnapshot`] (sole UI truth).
/// `Ok(None)` when the engine is unavailable so the frontend renders a calm
/// down state instead of treating engine-down as an error.
#[tauri::command]
pub async fn broadcast_get_state() -> Result<Option<StateSnapshot>, VaultError> {
    let Some(client) = supervisor::client() else {
        return Ok(None);
    };
    match client.get_state().await {
        Ok(snap) => Ok(Some(snap)),
        Err(BroadcastError::Disconnected) | Err(BroadcastError::Timeout) => Ok(None),
        Err(e) => Err(map_err(e)),
    }
}

/// `broadcast_request` — SP3 passthrough: forwards ANY engine op verbatim
/// (`{op, args}` → NDJSON request → reply data). The engine is our own local
/// sidecar behind our own webview, so per-verb Tauri commands added zero
/// safety at ~5 registration edits each; every SP3+ scene-graph/query verb
/// rides this instead. Display/record/restart stay bespoke — they compose
/// display_host / the supervisor, not just the pipe.
#[tauri::command]
pub async fn broadcast_request(op: String, args: Option<Value>) -> Result<Option<Value>, VaultError> {
    let client = require_client()?;
    client.request(&op, args.unwrap_or(Value::Null)).await.map_err(map_err)
}

/// `broadcast_start_record` — engine op `start_record`. Data is `{path}`, not
/// a snapshot; UI truth arrives via the `broadcast-state` event push.
#[tauri::command]
pub async fn broadcast_start_record() -> Result<Option<Value>, VaultError> {
    let client = require_client()?;
    client.request("start_record", Value::Null).await.map_err(map_err)
}

/// `broadcast_stop_record` — engine op `stop_record`. Data is `{path}`; the
/// saved file also lands via the `broadcast-saved` event.
#[tauri::command]
pub async fn broadcast_stop_record() -> Result<Option<Value>, VaultError> {
    let client = require_client()?;
    client.request("stop_record", Value::Null).await.map_err(map_err)
}

/// `broadcast_display_create` — create a fresh child HWND host, then bind an
/// engine display to it. LOGICAL px in. On an engine-side failure the host is
/// torn down again so no dead region floats.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn broadcast_display_create(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), VaultError> {
    let client = require_client()?;
    let (hwnd, pw, ph) = crate::broadcast::display_host::ensure(&app, &id, x, y, width, height)
        .await
        .map_err(VaultError::Io)?;
    let args = json!({ "id": id, "hwnd": hwnd, "width": pw, "height": ph });
    if let Err(e) = client.request("display_create", args).await {
        let _ = crate::broadcast::display_host::destroy(&app, &id).await;
        return Err(map_err(e));
    }
    Ok(())
}

/// `broadcast_display_bounds` — reposition the host (app-side SetWindowPos)
/// and resize the engine swapchain. Position never crosses the pipe.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn broadcast_display_bounds(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), VaultError> {
    let client = require_client()?;
    let (pw, ph) = crate::broadcast::display_host::set_bounds(&app, &id, x, y, width, height)
        .await
        .map_err(VaultError::Io)?;
    client
        .request("display_resize", json!({ "id": id, "width": pw, "height": ph }))
        .await
        .map_err(map_err)?;
    Ok(())
}

/// `broadcast_display_destroy` — engine destroy is BEST-EFFORT (the engine may
/// be dead — that is the point of the cleanup path), then tear the host down
/// (window destroyed, never reused — see display_host module header).
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn broadcast_display_destroy(app: AppHandle, id: String) -> Result<(), VaultError> {
    if let Some(client) = supervisor::client() {
        if let Err(e) = client.request("display_destroy", json!({ "id": id })).await {
            log::debug!("broadcast: display_destroy('{id}') best-effort failed: {e}");
        }
    }
    crate::broadcast::display_host::destroy(&app, &id).await.map_err(VaultError::Io)
}

/// `broadcast_restart_engine` — kill-and-respawn a live engine, or revive a
/// crash-loop-latched supervisor (SP2 settings + crash-loop CTA).
#[tauri::command]
pub async fn broadcast_restart_engine(app: AppHandle) -> Result<(), VaultError> {
    supervisor::restart(app);
    Ok(())
}

/// `broadcast_open_log` — open the engine's log file with the OS default app.
/// Direct opener use: `media::open_path` is root-contained by design and
/// rejects `%LOCALAPPDATA%` paths.
#[tauri::command]
pub async fn broadcast_open_log(app: AppHandle) -> Result<(), VaultError> {
    let path = crate::broadcast::engine_log_path()
        .ok_or_else(|| VaultError::NotFound("log path unresolvable".into()))?;
    if !path.exists() {
        return Err(VaultError::NotFound("engine log does not exist yet".into()));
    }
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| VaultError::Io(e.to_string()))
}

/// Path readouts for the settings tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastPaths {
    pub log_path: Option<String>,
    pub collection_path: String,
}

/// `broadcast_paths` — pure path compute. The collection path mirrors the
/// engine's `app_config_dir()` (`%APPDATA%\<bundle-id>\broadcast\…`) — string
/// coupling only, no pipe round-trip; both sides derive from the same OS dir.
#[tauri::command]
pub async fn broadcast_paths(app: AppHandle) -> Result<BroadcastPaths, VaultError> {
    use tauri::Manager;
    let collection = app
        .path()
        .app_data_dir()
        .map_err(|e| VaultError::Io(e.to_string()))?
        .join("broadcast")
        .join("scenes")
        .join("default.json");
    Ok(BroadcastPaths {
        log_path: crate::broadcast::engine_log_path().map(|p| p.to_string_lossy().into_owned()),
        collection_path: collection.to_string_lossy().into_owned(),
    })
}

// ── SP4 S4 — host-side post-save pipeline ─────────────────────────────────────
//
// A record `saved` or replay `replay_saved` engine event is handed to [`on_saved`]
// (spawned off the lib.rs bridge so the event loop keeps draining). It mirrors the
// capture bridge for Broadcast files: extract a sibling poster, enrich the payload,
// and emit `capture-saved` so the shared Captures UI (tiles, posters, bin,
// Send-to-editor) live-refreshes with zero Broadcast-specific frontend. Then, if the
// engine flagged auto-remux on an `.mkv`, remux it to `.mp4` (ALL tracks) and bin
// the source. The Broadcast-specific `broadcast-saved` / `broadcast-replay-saved`
// events stay in the bridge; this handler owns only the shared Captures surface.

/// Extract a `<stem>.jpg` poster beside `path` via a single-frame ffmpeg grab
/// (mirrors the video-editor frame-grab). Best-effort: a failure is logged and the
/// clip just lists without a thumbnail until the next Captures scan.
async fn extract_poster(path: &str) {
    let jpg = std::path::PathBuf::from(path).with_extension("jpg");
    let out = tokio::process::Command::new(crate::tool_path::resolve("ffmpeg"))
        .args(["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-i"])
        .arg(crate::tool_path::native_str(path))
        .args(["-frames:v", "1", "-q:v", "4", "-f", "image2", "-update", "1"])
        .arg(crate::tool_path::native_path(&jpg))
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {}
        Ok(o) => log::warn!(
            "broadcast: poster extract for {path} exited non-zero: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => log::warn!("broadcast: poster ffmpeg spawn failed: {e}"),
    }
}

/// Shared record/replay post-save handler (see module note above). `data` is the
/// engine event body (`{path, auto_remux?, …}`).
pub async fn on_saved(app: AppHandle, data: Value) {
    let path = data.get("path").and_then(|v| v.as_str()).map(String::from);
    let auto_remux = data
        .get("auto_remux")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(ref p) = path {
        extract_poster(p).await;
    }
    // enrich_saved (capture reuse) adds name/sizeBytes/mtime; emit the shared
    // Captures live-refresh event so the existing UI picks the clip up.
    let enriched = crate::commands::capture::enrich_saved(data);
    {
        use tauri::Emitter;
        if let Err(e) = app.emit("capture-saved", &enriched) {
            log::warn!("broadcast: emit capture-saved failed: {e}");
        }
    }

    // Auto-remux: engine flagged it AND the file is an mkv → mp4 (keep all tracks).
    if auto_remux {
        if let Some(p) = path {
            if p.to_ascii_lowercase().ends_with(".mkv") {
                if let Err(e) = auto_remux_mkv(&app, &p).await {
                    log::warn!("broadcast: auto-remux failed for {p}: {e}");
                }
            }
        }
    }
}

/// Remux `mkv_path` (ALL tracks) → sibling `.mp4`, bin the source mkv, and emit a
/// fresh `capture-saved` (with poster) for the mp4. Writes through a `.partial` so a
/// crash never leaves a truncated `.mp4` masquerading as complete.
async fn auto_remux_mkv(app: &AppHandle, mkv_path: &str) -> Result<(), String> {
    let src = std::path::PathBuf::from(mkv_path);
    let out_mp4 = src.with_extension("mp4");
    let partial = src.with_extension("mp4.partial");

    let args = crate::parsers::video_transcode::build_remux_argv(mkv_path, &partial);
    let out = tokio::process::Command::new(crate::tool_path::resolve("ffmpeg"))
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("ffmpeg spawn: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(format!(
            "ffmpeg remux exited non-zero: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    std::fs::rename(&partial, &out_mp4).map_err(|e| format!("rename partial→mp4: {e}"))?;

    // Bin the source mkv (root `captures`, restorable) — mirrors capture_clip_delete.
    let root = std::fs::canonicalize(crate::commands::vault::captures_dir())
        .unwrap_or_else(|_| std::path::PathBuf::from(crate::commands::vault::captures_dir()));
    match std::fs::canonicalize(&src) {
        Ok(abs) => match abs.strip_prefix(&root) {
            Ok(rel) => {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if let Err(e) = crate::commands::recycle_bin::trash_clip(
                    app,
                    Some("captures".into()),
                    &rel,
                    &abs,
                ) {
                    log::warn!("broadcast: bin source mkv failed: {e:?}");
                }
            }
            Err(_) => {
                log::warn!("broadcast: source mkv not under captures dir, leaving on disk")
            }
        },
        Err(e) => log::warn!("broadcast: canonicalize source mkv failed: {e}"),
    }

    // Poster + live-refresh for the new mp4.
    let mp4_str = out_mp4.to_string_lossy().into_owned();
    extract_poster(&mp4_str).await;
    let enriched = crate::commands::capture::enrich_saved(json!({ "path": mp4_str }));
    {
        use tauri::Emitter;
        if let Err(e) = app.emit("capture-saved", &enriched) {
            log::warn!("broadcast: emit capture-saved (remux) failed: {e}");
        }
    }
    Ok(())
}

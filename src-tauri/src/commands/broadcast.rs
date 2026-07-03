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

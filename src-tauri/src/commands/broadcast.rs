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

/// Stream-copy remux `input` → `out_mp4` through a sibling `.partial`, renamed on
/// success so a crash never leaves a truncated `.mp4` masquerading as complete.
/// Keeps EVERY track (`build_remux_argv` = `-map 0 -c copy`). Shared by the S4
/// auto-remux runner and the S6 `broadcast_remux_start` command.
async fn remux_to_partial(input: &str, out_mp4: &std::path::Path) -> Result<(), String> {
    let partial = out_mp4.with_extension("mp4.partial");
    let args = crate::parsers::video_transcode::build_remux_argv(input, &partial);
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
    std::fs::rename(&partial, out_mp4).map_err(|e| format!("rename partial→mp4: {e}"))?;
    Ok(())
}

/// Remux `mkv_path` (ALL tracks) → sibling `.mp4`, bin the source mkv, and emit a
/// fresh `capture-saved` (with poster) for the mp4.
async fn auto_remux_mkv(app: &AppHandle, mkv_path: &str) -> Result<(), String> {
    let src = std::path::PathBuf::from(mkv_path);
    let out_mp4 = src.with_extension("mp4");
    remux_to_partial(mkv_path, &out_mp4).await?;

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

// ── SP4 S6 — remux utility command ────────────────────────────────────────────

/// `broadcast_remux_start` — SP4 S6 remux utility (the RemuxWindow's backend).
/// Stream-copy remux `input` (any container) → an MP4 keeping every audio track,
/// through a `.partial` renamed on success. `output` defaults to the sibling
/// `.mp4` when omitted (the RemuxWindow always passes a concrete, distinct-from-
/// input path). Awaits completion — a `-c copy` remux is near-instant, so the
/// window shows a plain running→done state with no progress stream. Host-composing
/// (owns ffmpeg + the shared argv builder), not an engine passthrough — the engine
/// has no part in an offline file remux.
#[tauri::command]
pub async fn broadcast_remux_start(input: String, output: Option<String>) -> Result<(), VaultError> {
    let out = output
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(&input).with_extension("mp4"));
    remux_to_partial(&input, &out).await.map_err(VaultError::Io)
}

// ── SP5 SF7 — Twitch public ingest list ───────────────────────────────────────

/// One Twitch ingest, as the settings picker wants it: a display name and the
/// server URL with the `/{stream_key}` placeholder stripped, matching the shape
/// the bundled OBS catalog stores (`rtmp://host/app`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestServer {
    pub name: String,
    pub url: String,
    pub url_secure: String,
}

#[derive(serde::Deserialize)]
struct TwitchIngest {
    #[serde(rename = "_id")]
    id: i64,
    name: String,
    availability: f64,
    url_template: String,
    url_template_secure: String,
}

#[derive(serde::Deserialize)]
struct TwitchIngests {
    ingests: Vec<TwitchIngest>,
}

/// `broadcast_twitch_ingests` — fetch Twitch's ingest list (public, no auth).
///
/// This exists because the bundled OBS `rtmp-services` catalog carries **no
/// auto/nearest entry** for Twitch, and its `servers[0]` is merely ALPHABETICAL
/// ("Asia: Hong Kong") — which is why the picker refuses to guess a server.
/// Twitch's own list opens with `_id: 0` "Default", the `global-contribute` host
/// that geo-routes server-side, so asking Twitch beats any client-side latency
/// probe: no measuring, and above all no test broadcast (the `?bandwidthtest=true`
/// no-burn mechanism this sub-feature was originally specced around is dead —
/// every Twitch stream is a real public broadcast).
///
/// `default: true` is set on NO entry — id 0 is the only marker for the auto
/// host, so that is what this matches on. `availability` is a float (`1.0`).
/// Every entry also publishes an `rtmps://` template, which the plain catalog
/// never offered.
#[tauri::command]
pub async fn broadcast_twitch_ingests() -> Result<Vec<IngestServer>, VaultError> {
    let res: TwitchIngests = reqwest::get("https://ingest.twitch.tv/ingests")
        .await
        .map_err(|e| VaultError::Io(format!("twitch ingests: {e}")))?
        .json()
        .await
        .map_err(|e| VaultError::Invalid(format!("twitch ingests parse: {e}")))?;
    let mut out: Vec<IngestServer> = res
        .ingests
        .into_iter()
        .filter(|i| i.availability > 0.0)
        .map(|i| IngestServer {
            name: if i.id == 0 { "Auto (nearest)".to_string() } else { i.name },
            url: i.url_template.replace("/{stream_key}", ""),
            url_secure: i.url_template_secure.replace("/{stream_key}", ""),
        })
        .collect();
    // Twitch already returns id 0 first; sorting it there anyway keeps the auto
    // entry pinned without trusting the response order.
    out.sort_by_key(|s| s.name != "Auto (nearest)");
    Ok(out)
}

// ── SP5 SF7 — Twitch sign-in (Device Code Flow) ───────────────────────────────

/// The app's registered Twitch client-id. PUBLIC by design — it is not a secret
/// and Twitch expects it in plain requests; the app is registered as a public
/// client precisely so no secret has to be shipped. Device Code Flow was chosen
/// over the war-game's specced loopback-redirect flow because it needs **no
/// redirect URI, no listening port, and no client secret** (the registered
/// redirect `https://localhost` is never used — Twitch's console merely demands
/// one, and rejects `http://`).
const TWITCH_CLIENT_ID: &str = "i9zycrzoekkq6jii1iimqtn9rjhfad";
const TWITCH_SCOPES: &str = "channel:read:stream_key";
/// How long to keep polling before giving up. Twitch's own `expires_in` is 1800s,
/// which would leave this future hanging for half an hour if the user simply
/// walked away — the browser opens with the code pre-filled, so anyone actually
/// present is done inside a minute.
const TWITCH_POLL_CAP_SECS: u64 = 300;

/// What the settings tab gets back: whose account it came from, and the key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwitchKey {
    pub login: String,
    pub stream_key: String,
}

#[derive(serde::Deserialize)]
struct DeviceStart {
    device_code: String,
    verification_uri: String,
    interval: u64,
}

#[derive(serde::Deserialize)]
struct TokenOk {
    access_token: String,
}

#[derive(serde::Deserialize)]
struct HelixUser {
    id: String,
    login: String,
}

#[derive(serde::Deserialize)]
struct HelixStreamKey {
    stream_key: String,
}

#[derive(serde::Deserialize)]
struct HelixData<T> {
    data: Vec<T>,
}

/// `broadcast_twitch_fetch_key` — sign in to Twitch and return the stream key.
///
/// Deliberately **stateless: no token is stored anywhere.** The access token is
/// used for exactly two Helix calls and then dropped; the stream key it fetches
/// lands in `service.json` where OBS already keeps it, so there is nothing at
/// rest that did not exist before. That is why this needs no keyring entry
/// despite the war-game's M8.1/L5 fuss — Twitch remembers the authorisation, so
/// re-running this is two clicks with no re-login, which is cheaper than owning
/// a one-time-use refresh token and the "lost the rotation, silently signed out"
/// failure mode that comes with it. Add persistence only when a feature actually
/// needs a standing token (chat, title changes, going live over the API).
///
/// Flow: POST `/oauth2/device` → open the returned `verification_uri` (the code
/// arrives pre-filled in that URL) → poll `/oauth2/token` every `interval` until
/// it stops answering `authorization_pending` → Helix `/users` for the id and
/// login → Helix `/streams/key` for the key.
#[tauri::command]
pub async fn broadcast_twitch_fetch_key(app: AppHandle) -> Result<TwitchKey, VaultError> {
    let http = reqwest::Client::new();
    let net = |e: reqwest::Error| VaultError::Io(format!("twitch: {e}"));

    let start: DeviceStart = http
        .post("https://id.twitch.tv/oauth2/device")
        .form(&[("client_id", TWITCH_CLIENT_ID), ("scopes", TWITCH_SCOPES)])
        .send()
        .await
        .map_err(net)?
        .error_for_status()
        .map_err(net)?
        .json()
        .await
        .map_err(|e| VaultError::Invalid(format!("twitch device start: {e}")))?;

    app.opener()
        .open_url(&start.verification_uri, None::<&str>)
        .map_err(|e| VaultError::Io(format!("twitch: could not open browser: {e}")))?;

    // Poll. A 4xx here is the documented `authorization_pending` case far more
    // often than a real fault, so only a 2xx is treated as an answer — anything
    // else just means "not yet" until the cap runs out.
    let interval = std::time::Duration::from_secs(start.interval.max(1));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(TWITCH_POLL_CAP_SECS);
    let token = loop {
        tokio::time::sleep(interval).await;
        let res = http
            .post("https://id.twitch.tv/oauth2/token")
            .form(&[
                ("client_id", TWITCH_CLIENT_ID),
                ("scopes", TWITCH_SCOPES),
                ("device_code", start.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(net)?;
        if res.status().is_success() {
            let ok: TokenOk = res
                .json()
                .await
                .map_err(|e| VaultError::Invalid(format!("twitch token: {e}")))?;
            break ok.access_token;
        }
        if std::time::Instant::now() >= deadline {
            return Err(VaultError::Io(
                "Twitch sign-in timed out — the Authorize button was never pressed.".into(),
            ));
        }
    };

    let helix = |url: String| {
        http.get(url)
            .bearer_auth(&token)
            .header("Client-Id", TWITCH_CLIENT_ID)
            .send()
    };

    let user: HelixData<HelixUser> = helix("https://api.twitch.tv/helix/users".to_string())
        .await
        .map_err(net)?
        .error_for_status()
        .map_err(net)?
        .json()
        .await
        .map_err(|e| VaultError::Invalid(format!("twitch users: {e}")))?;
    let user = user
        .data
        .into_iter()
        .next()
        .ok_or_else(|| VaultError::NotFound("twitch returned no user".into()))?;

    let key: HelixData<HelixStreamKey> = helix(format!(
        "https://api.twitch.tv/helix/streams/key?broadcaster_id={}",
        user.id
    ))
    .await
    .map_err(net)?
    .error_for_status()
    .map_err(net)?
    .json()
    .await
    .map_err(|e| VaultError::Invalid(format!("twitch stream key: {e}")))?;
    let stream_key = key
        .data
        .into_iter()
        .next()
        .ok_or_else(|| VaultError::NotFound("twitch returned no stream key".into()))?
        .stream_key;

    Ok(TwitchKey { login: user.login, stream_key })
}

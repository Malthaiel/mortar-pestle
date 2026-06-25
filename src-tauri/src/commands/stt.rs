//! STT command surface — the Tauri front door to the `iskariel-stt` sidecar.
//!
//! Seven commands forward to the supervisor's single shared [`SttClient`]
//! (`crate::stt::client`) via its generic `request(op, args)` (the client exposes
//! no typed per-verb wrapper), mapping every [`SttError`](crate::stt::client::SttError)
//! to `Result<_, String>` at the boundary (`.map_err(|e| e.to_string())`).
//!
//! The three **streaming** commands (`stt_load_model`, `stt_transcribe_file`,
//! `stt_start_dictation`) relay
//! the engine's unsolicited events to the frontend over a per-call
//! `Channel<SttEvent>`, mirroring `commands::claude`'s `Channel<ClaudeEvent>`
//! pattern EXACTLY: an internally-tagged (`tag = "kind"`, `snake_case`) one-way
//! wire enum, fire-and-forget `let _ = on_event.send(...)`, the Channel as the
//! last argument by value, and a terminal `Done`/`Error`+`Done` pair so the
//! frontend knows the stream is over. Their event *source*, however, is the
//! client's `tokio::sync::broadcast` bus (`SttClient::subscribe`), not a child
//! process stdout — so the relay loop is structurally the capture bridge's
//! `recv()`/`Lagged`/`Closed` handling.
//!
//! The four **non-streaming** commands (`stt_cancel`, `stt_stop_dictation`,
//! `stt_unload`, `stt_status`) are plain capture.rs-style request wrappers.
//! `stt_status` degrades gracefully (engine-down → `Ok(None)`), mirroring
//! `get_capture_state`.
//!
//! Daemon reality (SF2 + SF3, both gated green): `load_model {name}` resolves the
//! name through the SHA256-verified model registry (fetch-on-demand) and holds a
//! resident `whisper-rs` context; `transcribe_file {path}` streams `segment` /
//! `progress` then a terminal `final`; `cancel` is finish-then-discard; `unload`
//! drops the model. So these commands are LIVE in file mode now — the relay below
//! carries real engine events. Mic-driven dictation is LIVE too: `start_dictation`
//! loads the speech model + streams `vu` + transcribed `segment`s; `stop_dictation`
//! emits a terminal `final` with the full transcript.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

use crate::commands::downloads_history::{now_ms, record as record_history, HistoryRecord};
use crate::stt::client::{
    CachedModelInfo, Final, HotkeysSnapshot, ModelLoaded, Progress, ProtoError, Segment, SttClient,
    SttError, Vu,
};
use crate::stt::supervisor;

// ── Wire events (one Channel per streaming call) ─────────────────────────────
//
// Internally-tagged, snake_case variant tags — identical mechanism to
// `commands::claude::ClaudeEvent`. One-way wire type (no `Deserialize`).
// Multi-word fields get explicit camelCase renames (the enum-level `rename_all`
// only renames the *variant* tags, not their fields), exactly as claude.rs
// renames `session_id`→`sessionId`.

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SttEvent {
    /// `model_loaded` engine event — a model finished loading.
    ModelLoaded {
        name: String,
        sha: String,
        backend: String,
    },
    /// `segment` engine event — one transcribed span.
    Segment {
        text: String,
        #[serde(rename = "t0Ms")]
        t0_ms: u64,
        #[serde(rename = "t1Ms")]
        t1_ms: u64,
    },
    /// `final` engine event — the completed transcript text.
    Final { text: String },
    /// `progress` engine event — 0.0..=100.0.
    Progress { pct: f64 },
    /// `vu` engine event — input RMS level during dictation (Phase 2 SF1), ~20–30 Hz.
    Vu { rms: f64 },
    /// An engine `error` event OR a turn-level relay error.
    Error { code: String, message: String },
    /// Relay terminator — always the last event for a streaming command (the
    /// claude.rs `Done` analog). `ok = false` when ended by an error / disconnect.
    Done { ok: bool },
}

// ── Helpers (capture.rs idiom) ───────────────────────────────────────────────

/// The shared client, or a `String` error when the supervisor never started
/// (stable tier / engine absent). Mirrors `capture::commands::require_client`,
/// but stringifies at the boundary per this module's `Result<_, String>` rule.
fn require_client() -> Result<SttClient, String> {
    supervisor::client().ok_or_else(|| "stt engine not running".to_string())
}

// ── Streaming commands (Channel<SttEvent>) ───────────────────────────────────

/// `stt_load_model` — ask the engine to load `name`, relaying the eventual
/// `model_loaded` (or `error`) over `on_event`. Subscribes BEFORE the request so
/// a fast `model_loaded` can't be missed, then relays until that terminal event.
#[tauri::command]
pub async fn stt_load_model(
    name: String,
    use_gpu: Option<bool>,
    on_event: Channel<SttEvent>,
) -> Result<(), String> {
    use tokio::sync::broadcast::error::RecvError;

    let client = require_client()?;

    // Subscribe BEFORE issuing the request so an early `model_loaded` isn't lost.
    let mut rx = client.subscribe();

    // `use_gpu` (Phase 5 Force-CPU): None = auto, Some(false) = force CPU.
    let args = serde_json::json!({ "name": name, "use_gpu": use_gpu });
    client
        .request("load_model", args)
        .await
        .map_err(|e| e.to_string())?;

    // Relay engine events until `model_loaded` / `error`, mirroring the capture
    // bridge's recv()/Lagged/Closed handling + claude.rs's send loop.
    loop {
        match rx.recv().await {
            Ok(ev) => match ev.event.as_str() {
                "model_loaded" => {
                    if let Ok(m) = serde_json::from_value::<ModelLoaded>(ev.data) {
                        let _ = on_event.send(SttEvent::ModelLoaded {
                            name: m.name,
                            sha: m.sha,
                            backend: m.backend,
                        });
                    }
                    let _ = on_event.send(SttEvent::Done { ok: true });
                    break;
                }
                "progress" => {
                    if let Ok(p) = serde_json::from_value::<Progress>(ev.data) {
                        let _ = on_event.send(SttEvent::Progress { pct: p.pct });
                    }
                }
                "error" => {
                    let (code, message) = serde_json::from_value::<ProtoError>(ev.data)
                        .map(|e| (e.code, e.message))
                        .unwrap_or_else(|_| ("internal".into(), "stt engine error".into()));
                    let _ = on_event.send(SttEvent::Error { code, message });
                    let _ = on_event.send(SttEvent::Done { ok: false });
                    break;
                }
                // echo / segment / final / unknown — not relevant to a load; ignore
                // (mirrors claude.rs's `_ => {}` default arm).
                _ => {}
            },
            // Fell behind the bus — drop the gap and keep listening.
            Err(RecvError::Lagged(_n)) => {}
            // Client torn down mid-stream.
            Err(RecvError::Closed) => {
                let _ = on_event.send(SttEvent::Error {
                    code: "disconnected".into(),
                    message: "stt engine disconnected".into(),
                });
                let _ = on_event.send(SttEvent::Done { ok: false });
                break;
            }
        }
    }
    Ok(())
}

/// `stt_transcribe_file` — transcribe the audio at `path`, streaming `segment` /
/// `progress` over `on_event` until the terminal `final` (or `error`). Subscribes
/// BEFORE the kickoff request so no early event is missed.
#[tauri::command]
pub async fn stt_transcribe_file(path: String, on_event: Channel<SttEvent>) -> Result<(), String> {
    use tokio::sync::broadcast::error::RecvError;

    let client = require_client()?;

    // Subscribe BEFORE the request so no early segment/progress is missed.
    let mut rx = client.subscribe();

    let args = serde_json::json!({ "path": path });
    client
        .request("transcribe_file", args)
        .await
        .map_err(|e| e.to_string())?;

    // Relay engine events until `final` / `error`, mirroring the capture bridge's
    // recv()/Lagged/Closed handling + claude.rs's send loop.
    loop {
        match rx.recv().await {
            Ok(ev) => match ev.event.as_str() {
                "segment" => {
                    if let Ok(s) = serde_json::from_value::<Segment>(ev.data) {
                        let _ = on_event.send(SttEvent::Segment {
                            text: s.text,
                            t0_ms: s.t0_ms,
                            t1_ms: s.t1_ms,
                        });
                    }
                }
                "progress" => {
                    if let Ok(p) = serde_json::from_value::<Progress>(ev.data) {
                        let _ = on_event.send(SttEvent::Progress { pct: p.pct });
                    }
                }
                "model_loaded" => {
                    if let Ok(m) = serde_json::from_value::<ModelLoaded>(ev.data) {
                        let _ = on_event.send(SttEvent::ModelLoaded {
                            name: m.name,
                            sha: m.sha,
                            backend: m.backend,
                        });
                    }
                }
                "final" => {
                    if let Ok(f) = serde_json::from_value::<Final>(ev.data) {
                        let _ = on_event.send(SttEvent::Final { text: f.text });
                    }
                    let _ = on_event.send(SttEvent::Done { ok: true });
                    break;
                }
                "error" => {
                    let (code, message) = serde_json::from_value::<ProtoError>(ev.data)
                        .map(|e| (e.code, e.message))
                        .unwrap_or_else(|_| ("internal".into(), "stt engine error".into()));
                    let _ = on_event.send(SttEvent::Error { code, message });
                    let _ = on_event.send(SttEvent::Done { ok: false });
                    break;
                }
                // echo / unknown — ignore (mirrors claude.rs's `_ => {}` default arm).
                _ => {}
            },
            // Fell behind the bus — drop the gap and keep listening.
            Err(RecvError::Lagged(_n)) => {}
            // Client torn down mid-stream.
            Err(RecvError::Closed) => {
                let _ = on_event.send(SttEvent::Error {
                    code: "disconnected".into(),
                    message: "stt engine disconnected".into(),
                });
                let _ = on_event.send(SttEvent::Done { ok: false });
                break;
            }
        }
    }
    Ok(())
}

/// `stt_start_dictation` — open the mic and stream live input level (`vu`) + transcribed
/// VAD `segment`s over `on_event`. NON-BLOCKING & OPEN-ENDED: the engine acks
/// immediately, opens the mic on its own (cpal) thread, loads the speech `model`, and
/// streams `vu` at ~20–30 Hz + a `segment {text, t0Ms, t1Ms}` per finalized utterance via
/// the event bus — it does NOT occupy the blocking whisper worker. The relay runs until
/// the terminal `final` (the full transcript) that `stt_stop_dictation` triggers, exactly
/// mirroring `stt_transcribe_file`'s terminator. `vad_threshold`/`hangover_ms` tune VAD.
#[tauri::command]
pub async fn stt_start_dictation(
    model: String,
    vad_threshold: Option<f32>,
    hangover_ms: Option<u32>,
    use_gpu: Option<bool>,
    on_event: Channel<SttEvent>,
) -> Result<(), String> {
    use tokio::sync::broadcast::error::RecvError;

    let client = require_client()?;

    // Subscribe BEFORE the request so no early `vu` (or open-failure `error`) is missed.
    let mut rx = client.subscribe();

    // Forward all args; `use_gpu` (Phase 5 Force-CPU) picks the speech backend.
    let args = serde_json::json!({
        "model": model,
        "vad_threshold": vad_threshold,
        "hangover_ms": hangover_ms,
        "use_gpu": use_gpu,
    });
    client
        .request("start_dictation", args)
        .await
        .map_err(|e| e.to_string())?;

    // Relay engine events until `final` / `error`, mirroring `stt_transcribe_file`.
    loop {
        match rx.recv().await {
            Ok(ev) => match ev.event.as_str() {
                "vu" => {
                    if let Ok(v) = serde_json::from_value::<Vu>(ev.data) {
                        let _ = on_event.send(SttEvent::Vu { rms: v.rms });
                    }
                }
                // Live transcribed VAD segments (SF3): `segment {text, t0_ms, t1_ms}`
                // per finalized utterance while dictating.
                "segment" => {
                    if let Ok(s) = serde_json::from_value::<Segment>(ev.data) {
                        let _ = on_event.send(SttEvent::Segment {
                            text: s.text,
                            t0_ms: s.t0_ms,
                            t1_ms: s.t1_ms,
                        });
                    }
                }
                "final" => {
                    if let Ok(f) = serde_json::from_value::<Final>(ev.data) {
                        let _ = on_event.send(SttEvent::Final { text: f.text });
                    }
                    let _ = on_event.send(SttEvent::Done { ok: true });
                    break;
                }
                "error" => {
                    let (code, message) = serde_json::from_value::<ProtoError>(ev.data)
                        .map(|e| (e.code, e.message))
                        .unwrap_or_else(|_| ("internal".into(), "stt engine error".into()));
                    let _ = on_event.send(SttEvent::Error { code, message });
                    let _ = on_event.send(SttEvent::Done { ok: false });
                    break;
                }
                // echo / model_loaded / progress / unknown — not relevant to
                // dictation; ignore (mirrors claude.rs's `_ => {}` default arm).
                _ => {}
            },
            // Fell behind the bus — drop the gap and keep listening.
            Err(RecvError::Lagged(_n)) => {}
            // Client torn down mid-stream.
            Err(RecvError::Closed) => {
                let _ = on_event.send(SttEvent::Error {
                    code: "disconnected".into(),
                    message: "stt engine disconnected".into(),
                });
                let _ = on_event.send(SttEvent::Done { ok: false });
                break;
            }
        }
    }
    Ok(())
}

/// `stt_download_model` — Phase 5 download-only fetch. Caches + SHA256-verifies the
/// model `name` WITHOUT loading it (download ≠ activate), relaying `progress` over
/// `on_event` until the terminal `download_complete` (or `error`). Mirrors
/// `stt_load_model`'s relay shape; `stt_cancel` aborts an in-flight download.
///
/// In addition to the per-call Channel (which drives the Settings model-row bar), the
/// relay also emits the GLOBAL `stt-download-progress` / `stt-download-done` Tauri
/// events so the Downloads popup + dock badge mirror the run from any route, and
/// records a `HistoryRecord` on every terminal state — matching `music_download` /
/// `anime_download`. The global path survives a Settings-page unmount (the Rust task
/// outlives the JS Channel); the per-call Channel does not.
#[tauri::command]
pub async fn stt_download_model(
    app: AppHandle,
    name: String,
    on_event: Channel<SttEvent>,
) -> Result<(), String> {
    use tokio::sync::broadcast::error::RecvError;

    let client = require_client()?;

    // Subscribe BEFORE the request so an early `progress` isn't lost.
    let mut rx = client.subscribe();

    // Seed the popup instantly (mirrors music/anime `queued`) — before the engine
    // even acks, so the dock badge lights on click, not on first progress byte.
    let _ = app.emit("stt-download-progress", serde_json::json!({ "name": name, "pct": 0 }));

    let args = serde_json::json!({ "name": name.clone() });
    client
        .request("download_model", args)
        .await
        .map_err(|e| e.to_string())?;

    // Relay `progress` until the terminal `download_complete` / `error`, mirroring the
    // capture bridge's recv()/Lagged/Closed handling.
    loop {
        match rx.recv().await {
            Ok(ev) => match ev.event.as_str() {
                "progress" => {
                    if let Ok(p) = serde_json::from_value::<Progress>(ev.data) {
                        let _ = on_event.send(SttEvent::Progress { pct: p.pct });
                        let _ = app.emit(
                            "stt-download-progress",
                            serde_json::json!({ "name": name, "pct": p.pct }),
                        );
                    }
                }
                "download_complete" => {
                    let _ = on_event.send(SttEvent::Done { ok: true });
                    stt_finalize(&app, &name, true, "", None);
                    break;
                }
                "error" => {
                    let (code, message) = serde_json::from_value::<ProtoError>(ev.data)
                        .map(|e| (e.code, e.message))
                        .unwrap_or_else(|_| ("internal".into(), "stt engine error".into()));
                    let _ = on_event.send(SttEvent::Error {
                        code: code.clone(),
                        message: message.clone(),
                    });
                    let _ = on_event.send(SttEvent::Done { ok: false });
                    stt_finalize(&app, &name, false, &code, Some(&message));
                    break;
                }
                // model_loaded / vu / segment / final / unknown — not relevant to a
                // download-only fetch; ignore.
                _ => {}
            },
            Err(RecvError::Lagged(_n)) => {}
            Err(RecvError::Closed) => {
                let _ = on_event.send(SttEvent::Error {
                    code: "disconnected".into(),
                    message: "stt engine disconnected".into(),
                });
                let _ = on_event.send(SttEvent::Done { ok: false });
                stt_finalize(&app, &name, false, "disconnected", Some("stt engine disconnected"));
                break;
            }
        }
    }
    Ok(())
}

/// Emit the terminal `stt-download-done` Tauri event AND append a `HistoryRecord`, so
/// the Downloads popup's Recent list + the persisted history both reflect the outcome.
/// `code == "cancelled"` (a user `stt_cancel`) maps to the `cancelled` state, not
/// `error` — matching music/anime's terminal-state mapping. Best-effort: a history
/// write failure is swallowed by `record` itself, never breaking the download.
fn stt_finalize(app: &AppHandle, name: &str, ok: bool, code: &str, message: Option<&str>) {
    let reveal = model_cache_path(name).to_string_lossy().into_owned();
    let _ = app.emit(
        "stt-download-done",
        serde_json::json!({
            "name": name,
            "ok": ok,
            "code": code,
            "error": message,
            "revealPath": if ok { Some(&reveal) } else { None },
        }),
    );
    let state = if ok {
        "done"
    } else if code == "cancelled" {
        "cancelled"
    } else {
        "error"
    };
    record_history(
        app,
        HistoryRecord {
            id: format!("stt:{name}"),
            source: "stt".into(),
            title: name.into(),
            subtitle: "Speech model".into(),
            state: state.into(),
            cover: None,
            finished_at: now_ms(),
            open_path: None,
            reveal_path: if ok { Some(reveal) } else { None },
            size_bytes: None,
            save_path: None,
            failed_count: 0,
            error: if state == "error" { message.map(Into::into) } else { None },
            args: serde_json::json!({ "kind": "stt", "name": name }),
        },
    );
}

// ── Non-streaming commands (capture.rs request wrappers) ─────────────────────

/// `stt_cancel` — abort the in-flight transcription (socket op `cancel`, no args).
#[tauri::command]
pub async fn stt_cancel() -> Result<(), String> {
    let client = require_client()?;
    client
        .request("cancel", Value::Null)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `stt_stop_dictation` — stop the mic (socket op `stop_dictation`, no args). The
/// engine flushes + transcribes the trailing segment and emits a terminal `final` with
/// the full transcript (SF3), which ends the `stt_start_dictation` relay loop. Plain
/// request wrapper (mirrors `stt_cancel`); the `final` is observed on the streaming
/// command's Channel.
#[tauri::command]
pub async fn stt_stop_dictation() -> Result<(), String> {
    let client = require_client()?;
    client
        .request("stop_dictation", Value::Null)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `stt_unload` — release the loaded model (socket op `unload`, no args).
#[tauri::command]
pub async fn stt_unload() -> Result<(), String> {
    let client = require_client()?;
    client
        .request("unload", Value::Null)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `stt_status` — the engine's opaque liveness/state `Value` (no typed snapshot
/// yet — SF2/SF3 add one). Degrades gracefully: engine-down → `Ok(None)` so the
/// UI renders an idle state rather than throwing (mirrors `get_capture_state`).
#[tauri::command]
pub async fn stt_status() -> Result<Option<Value>, String> {
    let Some(client) = supervisor::client() else {
        return Ok(None);
    };
    match client.get_state().await {
        Ok(v) => Ok(Some(v)),
        // Engine down / not yet up — not an error to the UI; show empty state.
        Err(SttError::Disconnected) | Err(SttError::Timeout) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// `stt_list_models` — Phase 5 Settings picker source. Returns every user-selectable
/// speech model with its cache status (`list_models` sync verb → `data.models`).
#[tauri::command]
pub async fn stt_list_models() -> Result<Vec<CachedModelInfo>, String> {
    let client = require_client()?;
    let data = client
        .request("list_models", Value::Null)
        .await
        .map_err(|e| e.to_string())?;
    let models = data
        .as_ref()
        .and_then(|v| v.get("models").cloned())
        .unwrap_or_else(|| Value::Array(vec![]));
    serde_json::from_value(models).map_err(|e| format!("decode models: {e}"))
}

/// `stt_delete_model` — Phase 5 Settings "Delete". Removes the cached model file
/// (`delete_model` sync verb). Idempotent on the engine side; no recycle bin.
#[tauri::command]
pub async fn stt_delete_model(name: String) -> Result<(), String> {
    let client = require_client()?;
    client
        .request("delete_model", serde_json::json!({ "name": name }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Phase 5 push-to-talk (SF5) ───────────────────────────────────────────────

/// `stt_rebind_hotkeys` — ask the engine to open KDE's ConfigureShortcuts and re-run
/// its GlobalShortcuts bind (socket op `rebind_hotkeys`). Returns the echoed
/// [`HotkeysSnapshot`] (`data.hotkeys`); the post-rebind triggers arrive later as a
/// `hotkeys` event. Thin pass-through (mirrors `capture_rebind_hotkeys`); a decode
/// miss is non-fatal (`None`) — the frontend re-syncs via `stt_status` / `stt-hotkeys`.
#[tauri::command]
pub async fn stt_rebind_hotkeys() -> Result<Option<HotkeysSnapshot>, String> {
    let client = require_client()?;
    let data = client
        .request("rebind_hotkeys", Value::Null)
        .await
        .map_err(|e| e.to_string())?;
    Ok(data
        .as_ref()
        .and_then(|v| v.get("hotkeys").cloned())
        .and_then(|h| serde_json::from_value::<HotkeysSnapshot>(h).ok()))
}

/// `stt_open_kde_settings` — open the global-shortcuts rebind UI. Linux opens KDE
/// System Settings at the global-shortcuts KCM (`kcm_keys`); Windows/other have no
/// system rebind UI (push-to-talk is a fixed WH_KEYBOARD_LL trigger in v1), so the
/// command is a silent no-op (the button is hidden there). The per-OS body lives in
/// cfg'd helpers so the command itself stays a clean tail expression.
#[tauri::command]
pub fn stt_open_kde_settings() -> Result<(), String> {
    open_global_shortcuts_settings()
}

/// Linux: launch the KDE settings shell directly via `std::process::Command` (no new
/// dependency, NOT `tauri-plugin-shell`); KDE 6 → 5 fallback chain; best-effort.
#[cfg(target_os = "linux")]
fn open_global_shortcuts_settings() -> Result<(), String> {
    // First launcher that spawns wins. `kcm_keys` is the global-shortcuts KCM.
    const CANDIDATES: &[(&str, &[&str])] = &[
        ("systemsettings", &["kcm_keys"]),
        ("systemsettings5", &["kcm_keys"]),
        ("kcmshell6", &["kcm_keys"]),
        ("kcmshell5", &["kcm_keys"]),
    ];
    for (bin, args) in CANDIDATES {
        if std::process::Command::new(bin).args(*args).spawn().is_ok() {
            return Ok(());
        }
    }
    Err("KDE System Settings not found (tried systemsettings/kcmshell)".to_string())
}

/// Windows/other: no system rebind UI (the trigger is fixed in v1). Silent no-op.
#[cfg(not(target_os = "linux"))]
fn open_global_shortcuts_settings() -> Result<(), String> {
    Ok(())
}

// ── Model cache path (host-side mirror) ───────────────────────────────────────
//
// ponytail: duplicates `iskariel-stt::models::model_cache_dir` / `resolve_model_path`.
// The STT engine is a separate sidecar binary (not a crate dep of src-tauri), so the
// cache dir it owns isn't reachable from here — mirroring the resolver is the
// shortest path. The daemon is the source of truth; if it ever relocates the cache,
// these two fns must follow. Used to populate `reveal_path` on a completed download
// and to resolve the target of `stt_reveal_model`.

/// Windows: `%LOCALAPPDATA%\iskariel\models\whisper` (non-roaming — models are multi-GB).
#[cfg(target_os = "windows")]
fn model_cache_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("iskariel")
        .join("models")
        .join("whisper")
}

/// Linux/other: prefer a non-empty `$XDG_DATA_HOME`, else `$HOME/.local/share`.
#[cfg(not(target_os = "windows"))]
fn model_cache_dir() -> PathBuf {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local")
                .join("share")
        });
    data.join("iskariel").join("models").join("whisper")
}

/// Resolve a registry model `name` (e.g. `small.en`) to its cached file path
/// `<cache>/<name>.bin` — the location the engine downloads + verifies into.
fn model_cache_path(name: &str) -> PathBuf {
    model_cache_dir().join(format!("{name}.bin"))
}

/// `stt_reveal_model` — open the OS file manager with the cached model file
/// highlighted (the "Reveal in files" action on a completed STT download row in the
/// Downloads popup). `reveal_in_files` can't be reused: it's vault-containment-gated
/// (`is_under_allowed_root`) and the model cache lives under `%LOCALAPPDATA%`, not a
/// vault root — so this dedicated command reveals an app-owned cache file directly.
/// A missing file (e.g. deleted since the row was recorded) is a clean error.
#[tauri::command]
pub fn stt_reveal_model(app: AppHandle, name: String) -> Result<(), String> {
    let path = model_cache_path(&name);
    if !path.exists() {
        return Err(format!("Model not cached: {name}"));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

use tauri::{Manager, RunEvent, WindowEvent};

pub mod asset_protocol;
// Shield blocker — host/cosmetic/scriptlet layers, all pure Rust. Network
// blocking rides the forward proxy; cosmetics ride WebView2 JS injection. The
// WebKit content-filter FFI went with Linux (2026-08-06, Linux Removal).
pub mod blocker;
pub mod broadcast;
pub mod capture;
pub mod commands;
pub mod media_server;
pub mod overlay;
pub mod parsers;
// SPIKE (Native Video Player): child-HWND picture surface for mpv, parked
// BEHIND the webview so the existing controls composite over it.
#[cfg(target_os = "windows")]
pub mod player_host;
// Loopback-refusing forward proxy = the browser's network boundary. Pure Rust
// (std::net + tokio); ported to Windows alongside the WebView2 content views.
pub mod proxy;
pub mod render;
// STT is ported to Windows (named-pipe IPC, SF1+); Linux uses the Unix socket.
pub mod stt;
pub mod tool_path;
/// Push-to-talk sink: type a dictated transcript into the focused window via
/// `SendInput`. Windows-only (the `windows` crate is a cfg(windows) dep).
#[cfg(windows)]
pub mod typing;
/// Win32 Job Object die-with-app safety net (KILL_ON_JOB_CLOSE). Windows-only;
/// compiled out on Linux (the `windows` crate is a cfg(windows) dep).
#[cfg(windows)]
pub mod winjob;
pub mod watcher;

#[derive(serde::Serialize)]
struct MediaServerInfo {
    port: u16,
    token: String,
}

#[tauri::command]
fn media_server_port() -> Option<MediaServerInfo> {
    match (media_server::port(), media_server::token()) {
        (Some(port), Some(token)) => Some(MediaServerInfo { port, token }),
        _ => None,
    }
}

/// Hide the in-game overlay-host window. Called by the overlay frontend AFTER its
/// CSS scale+fade-out completes, so the close animation plays before the window
/// actually disappears — the `overlay` hotkey handler now only emits
/// `overlay-host-visible=false` and defers the real hide to this command, giving
/// open and close matching easing. No-op if the window is already gone.
#[tauri::command]
fn hide_overlay_host(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("overlay-host") {
        let _ = win.hide();
        // DEV: refresh the webview NOW, while hidden — Vite HMR doesn't reach the
        // occluded overlay webview, so the reload keeps its code fresh for the next
        // show. Was a reload (+ devtools auto-open) on every SHOW, which made every
        // open eat a full webview boot. Edits made while the overlay sits hidden
        // miss this pass — toggle it (Shift+C twice) to pick them up.
        #[cfg(debug_assertions)]
        let _ = win.eval("location.reload()");
    }
    // Safety net: never strand a reparented browser tab inside the hidden
    // window (a crashed/hung host webview can't run its own detach). Spawned,
    // never inline — this command runs sync on the main thread and the detach
    // reparent blocks on the event loop.
    {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = commands::browser::overlay_detach_impl(&app2);
        });
    }
}

/// Sub-feature 6 — one-shot byte-faithful migration of legacy sidebar order
/// from the vault cache to Tauri AppConfig. Idempotent: gated on dest-exists.
/// Errors are logged and swallowed; sidebar persistence is non-critical and
/// a fresh install will silently start empty. Runs in `setup` *before*
/// `watcher::spawn` so deleting the legacy file does not emit a spurious
/// manifest event into the freshly-started watcher.
fn migrate_sidebar_to_app_config(app: &tauri::AppHandle) {
    use crate::commands::sidebar::{migrate_inner, sidebar_file};
    use crate::commands::vault::vault_root;
    use std::path::PathBuf;

    let dest = match sidebar_file(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("sidebar migration: resolve dest: {e:?}");
            return;
        }
    };
    let src = PathBuf::from(vault_root()).join("Infrastructure/.cache/sidebar_order.json");
    match migrate_inner(&src, &dest) {
        Ok(true) => eprintln!("sidebar migration: copied bytes to AppConfig"),
        Ok(false) => {}
        Err(e) => eprintln!("sidebar migration: {e:?}"),
    }
}

/// Mortar & Pestle rebrand — one-shot migration of app-data from any legacy
/// identifier (`dev.judeau.agentic-os` original, `dev.malthaiel.lodestar` first
/// rebrand, `dev.malthaiel.iskariel` second rebrand) to the current
/// `dev.malthaiel.mortar-pestle`. Tauri derives the data / config / cache dirs
/// from `tauri.conf.json::identifier`, so changing it would otherwise orphan the
/// user's vaults, config, and cache. Strategy: atomic same-volume `rename` of
/// each app-data dir (instant even for multi-GB Library data), then rewrite the
/// absolute legacy-id paths baked into the top-level `*.json` configs — chiefly
/// `vaults.json`, whose App/Pulse/Library/GameWiki mounts are stored as absolute
/// paths. Gated on the destination not existing, so it runs exactly once on the
/// first post-rebrand launch and is a no-op on a fresh install. Best-effort: every
/// error is logged and swallowed (a failed migrate degrades to a fresh-looking
/// app, never a crash; the legacy dir is left intact for manual recovery). MUST
/// run first in `setup`, before the log plugin or any app-data read.
fn migrate_legacy_identity_data(app: &tauri::AppHandle) {
    // Newest legacy id first so a chained install (judeau -> lodestar -> iskariel
    // -> mortar-pestle) migrates from its most recent identity.
    const LEGACY_IDS: [&str; 3] = ["dev.malthaiel.iskariel", "dev.malthaiel.lodestar", "dev.judeau.agentic-os"];
    const NEW_ID: &str = "dev.malthaiel.mortar-pestle";

    // 1. Move each per-OS app-data dir (data / local / config) old -> new. On
    //    Windows data==config (Roaming) and local is Local; on Linux data==local
    //    (~/.local/share) and config is ~/.config. Dedup is implicit: once moved,
    //    the dest exists, so a later resolver pointing at the same dir is skipped.
    let resolver = app.path();
    for dir_res in [
        resolver.app_data_dir(),
        resolver.app_local_data_dir(),
        resolver.app_config_dir(),
    ] {
        let new_dir = match dir_res {
            Ok(d) => d,
            Err(_) => continue,
        };
        let Some(parent) = new_dir.parent() else {
            continue;
        };
        if new_dir.exists() {
            continue;
        }
        for legacy_id in LEGACY_IDS {
            let old_dir = parent.join(legacy_id);
            if !old_dir.exists() {
                continue;
            }
            match std::fs::rename(&old_dir, &new_dir) {
                Ok(_) => eprintln!(
                    "identity migration: moved {} -> {}",
                    old_dir.display(),
                    new_dir.display()
                ),
                Err(e) => eprintln!(
                    "identity migration: rename failed ({e}); legacy left at {}",
                    old_dir.display()
                ),
            }
            break;
        }
    }

    // 2. Repoint absolute legacy-id paths in the top-level *.json configs
    //    (non-recursive — vault content is left untouched). vaults.json's
    //    App/Pulse/Library/GameWiki mounts are absolute and must be repointed.
    if let Ok(cfg_dir) = resolver.app_config_dir() {
        if let Ok(entries) = std::fs::read_dir(&cfg_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(s) = std::fs::read_to_string(&p) else {
                    continue;
                };
                if !LEGACY_IDS.iter().any(|id| s.contains(id)) {
                    continue;
                }
                let mut updated = s;
                for legacy_id in LEGACY_IDS {
                    updated = updated.replace(legacy_id, NEW_ID);
                }
                match std::fs::write(&p, updated) {
                    Ok(_) => eprintln!("identity migration: repointed paths in {}", p.display()),
                    Err(e) => eprintln!("identity migration: rewrite {} failed: {e}", p.display()),
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(commands::vod_timer::plugin())
        .register_uri_scheme_protocol("mortar-pestle-asset", |ctx, req| asset_protocol::handle(ctx, req))
        .setup(|app| {
            // Mortar & Pestle rebrand — migrate legacy app-data
            // (dev.judeau.agentic-os, dev.malthaiel.lodestar, or
            // dev.malthaiel.iskariel) to dev.malthaiel.mortar-pestle BEFORE the
            // log plugin or any app-data read (the log plugin would otherwise
            // create the new log dir first and block the atomic cache-dir move).
            migrate_legacy_identity_data(app.handle());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Sub-feature 6 — migrate legacy vault-cached sidebar order to
            // AppConfig before the watcher starts (avoids spurious manifest
            // event when the old file is deleted).
            migrate_sidebar_to_app_config(app.handle());

            // Planner Overhaul — one-time pomodoro→planner persisted-id shim
            // for sidebar.json (widgets:order). Runs after the sidebar file
            // migration above and before the watcher + frontend read it.
            {
                use crate::commands::sidebar::{migrate_planner_rename, sidebar_file};
                if let Ok(p) = sidebar_file(app.handle()) {
                    match migrate_planner_rename(&p) {
                        Ok(true) => eprintln!("planner rename migration: sidebar.json updated"),
                        Ok(false) => {}
                        Err(e) => eprintln!("planner rename migration: {e:?}"),
                    }
                }
            }

            // Multi-Vault — load the vault registry (seed Citadel on first
            // run), set the active vault + its app-data manifest path, and
            // build that manifest. MUST precede watcher::spawn so the watcher
            // attaches to the correct root.
            commands::vaults::init_active_vault(app.handle());

            // D5: one-shot sessions migration — pulse root is resolved (above) and
            // the watcher isn't up yet, so the strips won't storm events. Idempotent
            // (no-op once sessions.json exists); a count-mismatch aborts losslessly.
            if let Err(e) = commands::sessions::migrate_from_markdown(app.handle()) {
                log::error!("sessions migration failed (daily logs left intact): {e:?}");
            }

            // Sub-feature 5 — notify watcher emits Tauri events 1:1 with
            // the Fastify SSE event names. Vault-root-missing is non-fatal:
            // log and continue in degraded mode (no live updates, app
            // otherwise works fine).
            if let Err(e) = watcher::spawn(app.handle().clone()) {
                eprintln!("watcher::spawn failed: {e} — live updates disabled");
            }

            // In-app updater (Stage 2) — cache running binary SHA-256 and
            // spawn the 30s poll loop emitting `update-available` events.
            commands::self_update::init_cache();
            commands::self_update::spawn_poll(app.handle().clone());

            // Feedback Board — 60s in-app notification poll (signed-in + focused only).
            commands::feedback::spawn_poll(app.handle().clone());

            // Anime Browse — capture the per-app cache dir for the AniList
            // response cache (in-memory LRU + on-disk JSON). Best-effort.
            commands::anime_search::init_cache_dir(app.handle());

            // Sub-feature 8 — one-shot prune of skill-run logs older than 7
            // days. Mirrors Node's `server/src/skills/retention.js::startRetention`.
            // Best-effort; log-and-continue on dir-missing or per-file errors.
            let report = parsers::skills::prune_old_logs();
            if report.removed > 0 {
                eprintln!(
                    "skill-run retention: removed {}/{} old logs",
                    report.removed, report.scanned
                );
            }

            // Global Recycling Bin — retention sweep at start (age + count read
            // from RecycleBin/retention.json, defaults 30d/200). Best-effort.
            let rb = commands::recycle_bin::startup_purge(app.handle());
            if rb.removed > 0 {
                eprintln!("recycle bin retention: purged {} expired item(s)", rb.removed);
            }

            // Adopt the previous session's transcodes instead of wiping them:
            // complete files are re-registered (so the existing LRU caps bound
            // the dir again) and a hard-killed run's `.partial` staging files
            // are removed. A re-encoded episode costs ~80 s of GPU work, which
            // the old wipe-on-startup + wipe-on-exit pair charged every launch.

            // SF12 follow-up — loopback HTTP server for media bytes. WebKitGTK
            // rejects custom URI schemes in HTMLMediaElement, so audio/video
            // can't load from `mortar-pestle-asset://`. Spawn an axum router on a
            // kernel-assigned 127.0.0.1 port that re-exposes the existing
            // asset-protocol helpers over plain HTTP (which WebKit accepts).
            tauri::async_runtime::spawn(async {
                if let Err(e) = media_server::run().await {
                    eprintln!("media_server::run failed: {e}");
                }
            });

            // Shield blocker + forward proxy — the in-app browser's network
            // boundary, ported to Windows (the proxy + host/cosmetic blocker are
            // pure Rust; only the WebKit content-filter FFI stays Linux-only).
            {
            // In-app browser ad/tracker blocker (Shield) — load the vendored
            // host blocklist before the proxy starts consulting it on CONNECT.
            blocker::init();

            // Shield (SF4b) — capture the cache dir, load any fresher cached
            // lists over the vendored seed, and kick a background refresh when
            // the cache is missing or >7 days old.
            blocker::lists::init_cache_dir(app.handle());
            blocker::lists::spawn_startup_refresh();

            // In-app browser network boundary — a loopback-refusing forward
            // proxy that the sandboxed content WebView routes all traffic
            // through. Started here so its port is ready before the browser is
            // lazily embedded on first navigation.
            tauri::async_runtime::spawn(async {
                if let Err(e) = proxy::run().await {
                    eprintln!("proxy::run failed: {e}");
                }
            });
            }

            // Game Capture (5-SF2b/c/e) — studio-artifact-only carriage. The
            // supervisor owns the whole engine lifecycle: adopt-first (probe the
            // control socket; adopt a live daemon rather than duplicate it),
            // spawn-second (resolve the binary + `[bin, "daemon"]`), respawn with
            // bounded backoff, crash-loop terminal, and the `RunEvent::Exit` reap
            // below. A missing binary = the stable tier ⇒ inert (the supervisor
            // logs the one "disabling" line). The Step-2 dev smoke probe is gone
            // — `get_capture_state` is the real path now.
            // STT + Game Capture supervisors + engine→Tauri event bridges run on
            // Linux (Unix-socket IPC) AND Windows (named-pipe IPC).
            {
            // Die-with-app safety net: assign the host to a KILL_ON_JOB_CLOSE
            // job BEFORE the first sidecar spawns, so the OS reaps all 3
            // daemons if the host is killed (Task-Manager / crash) before the
            // explicit shutdown() path runs. Windows-only; on Linux this line
            // compiles out and the explicit shutdown path is the sole net.
            #[cfg(windows)]
            winjob::init();

            // WI-2: load the persisted recordings-folder override into the
            // captures_dir() cache BEFORE the engine spawns, so the daemon binds
            // MORTAR_PESTLE_CAPTURES_DIR to the user's chosen dir on first launch.
            commands::capture::init_captures_override(app.handle());

            capture::supervisor::start(app.handle().clone());

            // STT (speech-to-text) — supervisor owns the model/worker lifecycle,
            // mirroring capture's adopt/spawn/respawn + RunEvent::Exit reap.
            stt::supervisor::start(app.handle().clone());

            // Broadcast (SP1 SF5) — third instance of the supervision pattern.
            // The engine is the GPL mortar-pestle-broadcast sidecar (libobs);
            // supervisor emits `broadcast-engine-status`, and the bridge below
            // re-emits engine events as `broadcast-state` / `broadcast-saved` /
            // `broadcast-error` for the SP2 module UI to listen() to.
            broadcast::supervisor::start(app.handle().clone());
            if let Some(client) = broadcast::supervisor::client() {
                let bridge_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri::Emitter;
                    use tokio::sync::broadcast::error::RecvError;
                    let mut rx = client.subscribe();
                    loop {
                        match rx.recv().await {
                            Ok(ev) => match ev.event.as_str() {
                                // StateSnapshot — the sole UI truth.
                                "state_changed" => {
                                    let _ = bridge_app.emit("broadcast-state", &ev.data);
                                }
                                // SP6 audio meters: its OWN channel, deliberately
                                // not folded into broadcast-state. This arrives at
                                // 30 Hz while the mixer is open, and the strip
                                // paints it through refs + rAF; routing it through
                                // the snapshot channel would re-render the whole
                                // module on every frame.
                                "meters" => {
                                    let _ = bridge_app.emit("broadcast-meters", &ev.data);
                                }
                                "saved" => {
                                    // Broadcast-specific signal (unchanged), then run the
                                    // shared Captures pipeline off-thread so the bridge keeps
                                    // draining while poster extract + auto-remux await ffmpeg.
                                    let _ = bridge_app.emit("broadcast-saved", &ev.data);
                                    let app2 = bridge_app.clone();
                                    let data = ev.data.clone();
                                    tauri::async_runtime::spawn(async move {
                                        commands::broadcast::on_saved(app2, data).await;
                                    });
                                }
                                "replay_saved" => {
                                    // Replay clip saved: fire the chime/toast signal, then the
                                    // same shared Captures pipeline (poster + capture-saved +
                                    // auto-remux) as a record `saved`.
                                    let _ = bridge_app.emit("broadcast-replay-saved", &ev.data);
                                    let app2 = bridge_app.clone();
                                    let data = ev.data.clone();
                                    tauri::async_runtime::spawn(async move {
                                        commands::broadcast::on_saved(app2, data).await;
                                    });
                                }
                                "error" => {
                                    let _ = bridge_app.emit("broadcast-error", &ev.data);
                                }
                                other => {
                                    log::debug!("broadcast bridge: unrouted event '{other}'");
                                }
                            },
                            // Lagged: drop the gap, keep going (snapshot events are
                            // self-contained — the next one supersedes the missed).
                            Err(RecvError::Lagged(n)) => {
                                log::debug!("broadcast bridge lagged {n} events");
                            }
                            Err(RecvError::Closed) => break,
                        }
                    }
                });
            }

            // STT engine → Tauri event bridge (Phase 5 SF5 relay). UI-driven
            // dictation uses a per-call Channel, but a GLOBAL push-to-talk session
            // (started while the app is unfocused) has none — so this always-on relay
            // re-emits the engine's unsolicited events as the `stt-*` Tauri events the
            // frontend `listen()`s, and routes a HOTKEY transcript to today's daily
            // log. The frontend reflects a hotkey session off these globals, guarded
            // so a UI session (which owns its per-call Channel) doesn't double-handle.
            // Detached + reconnect-surviving (the bus outlives any single socket
            // connection); a lagged receiver drops the gap and keeps going.
            if let Some(client) = stt::supervisor::client() {
                let bridge_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri::Emitter;
                    use tokio::sync::broadcast::error::RecvError;
                    let mut rx = client.subscribe();
                    loop {
                        match rx.recv().await {
                            Ok(ev) => match ev.event.as_str() {
                                // Live dictation telemetry — forwarded verbatim.
                                "vu" => {
                                    let _ = bridge_app.emit("stt-vu", &ev.data);
                                }
                                "segment" => {
                                    let _ = bridge_app.emit("stt-segment", &ev.data);
                                }
                                "final" => {
                                    let _ = bridge_app.emit("stt-final", &ev.data);
                                }
                                "model_loaded" => {
                                    let _ = bridge_app.emit("stt-model-loaded", &ev.data);
                                }
                                "dictation_started" => {
                                    let _ = bridge_app.emit("stt-dictation-started", &ev.data);
                                }
                                // An engine error with NO per-call Channel to carry it
                                // (a hotkey dictation) — surface it globally so the panel
                                // can clear a stuck recording + toast. UI ops ignore this
                                // (their Channel owns the error); the frontend guards it
                                // behind an active hotkey session.
                                "error" => {
                                    let _ = bridge_app.emit("stt-error", &ev.data);
                                }
                                // Live hotkey snapshot (initial bind / ShortcutsChanged
                                // / rebind) → the Settings Push-to-talk band reflects it.
                                "hotkeys" => {
                                    let _ = bridge_app.emit("stt-hotkeys", &ev.data);
                                }
                                // The daily-log SINK: a hotkey dictation's terminal
                                // transcript. Append it to today's `## Quick Notes`
                                // host-side (the daemon can't write the vault), then
                                // tell the frontend to toast. The watcher emits
                                // `day`/`today` after the write → the UI self-refreshes.
                                "dictation_committed" => {
                                    let text = ev
                                        .data
                                        .get("text")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    // Live-scrim reroute (overlay B): when a scrim is
                                    // live (set via the ScrimViewer's Go Live button),
                                    // the hotkey transcript becomes a timestamped
                                    // coached-team note in the scrim overlay instead of
                                    // appending to today's Quick Notes. Otherwise the
                                    // existing daily-log sink path is unchanged.
                                    // Route on the SOURCE (which key was held), not on
                                    // whether a scrim is live: the scrim bind makes a
                                    // scrim note, the dictate bind (F8) always types.
                                    // An older daemon sends no `source` — that decodes
                                    // to "" and takes the type-into-focus path.
                                    let source = ev
                                        .data
                                        .get("source")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    log::info!(
                                        "stt: dictation_committed len={} source={source:?}",
                                        text.len()
                                    );
                                    let live = crate::overlay::state::current_live_target();
                                    // A scrim note with NO live scrim has nowhere to go —
                                    // fall through to typing rather than dropping it.
                                    if let (true, Some(t)) = (source == "hotkey_scrim", live) {
                                        let _ = bridge_app.emit(
                                            "overlay-dictation-committed",
                                            serde_json::json!({
                                                "text": text,
                                                "scrimPath": t.scrim_path,
                                                "matchN": t.match_n,
                                                "coachedTeam": t.coached_team,
                                            }),
                                        );
                                    } else {
                                        // Focused-window SINK: type the transcript into
                                        // whatever box has keyboard focus (terminal,
                                        // browser field, the M&P app itself — no special
                                        // case). Replaces the former daily-log append.
                                        // A trailing space so back-to-back dictations
                                        // don't glue together.
                                        let typed = format!("{} ", text.trim());
                                        let sent = crate::typing::type_text(&typed);
                                        let want = typed.encode_utf16().count() * 2;
                                        let ok = sent == want;
                                        log::info!("stt: focus sink sent {sent}/{want} events");
                                        if !ok {
                                            log::warn!(
                                                "stt: focus sink REJECTED \
                                                 (foreground window likely elevated)"
                                            );
                                        }
                                        let _ = bridge_app.emit(
                                            "stt-dictation-typed",
                                            serde_json::json!({
                                                "ok": ok, "text": text,
                                                "error": if ok { None } else {
                                                    Some("focused window rejected the input")
                                                },
                                            }),
                                        );
                                    }
                                }
                                other => {
                                    log::debug!("stt bridge: ignoring engine event {other}");
                                }
                            },
                            Err(RecvError::Lagged(n)) => {
                                log::debug!("stt bridge: lagged {n} events");
                            }
                            Err(RecvError::Closed) => {
                                log::debug!("stt bridge: event bus closed — ending");
                                break;
                            }
                        }
                    }
                });
            }

            // Engine → Tauri event bridge (5-SF2e-bridge / 5-SF5c). Subscribe to
            // the supervisor's shared client event bus and re-emit each engine
            // event as the Tauri event whose name equals the frontend `listen()`
            // name. `error` folds into `capture-state` (no separate
            // `capture-error`). The supervisor emits `capture-engine-status`
            // itself. Detached + reconnect-surviving (the bus outlives any single
            // socket connection); a lagged receiver just resubscribes.
            if let Some(client) = capture::supervisor::client() {
                let bridge_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri::Emitter;
                    use tokio::sync::broadcast::error::RecvError;
                    let mut rx = client.subscribe();
                    loop {
                        match rx.recv().await {
                            Ok(ev) => match ev.event.as_str() {
                                // state_changed + folded error → capture-state.
                                "state_changed" => {
                                    if let Err(e) = bridge_app.emit("capture-state", &ev.data) {
                                        log::warn!("emit capture-state failed: {e}");
                                    }
                                }
                                "error" => {
                                    // A failed screenshot must restore the overlay's
                                    // per-shot capture affinity (set by
                                    // capture_screenshot's include-overlay toggle).
                                    if ev.data.get("code").and_then(|v| v.as_str())
                                        == Some("screenshot_failed")
                                    {
                                        overlay::state::reset_overlay_shot_affinity(&bridge_app);
                                    }
                                    // Fold the engine error into the state channel
                                    // (no separate capture-error event). The
                                    // payload is the `{code,message,fatal}` body;
                                    // the frontend reads it off the same listener.
                                    if let Err(e) = bridge_app.emit("capture-state", &ev.data) {
                                        log::warn!("emit capture-state (error fold) failed: {e}");
                                    }
                                }
                                // saved → capture-saved, enriched with
                                // name/sizeBytes/mtime (omitted on the wire).
                                "saved" => {
                                    let enriched =
                                        commands::capture::enrich_saved(ev.data.clone());
                                    if let Err(e) = bridge_app.emit("capture-saved", &enriched) {
                                        log::warn!("emit capture-saved failed: {e}");
                                    }
                                }
                                // Screenshot saved → forward the PNG path to the
                                // overlay (which offers the scoreboard auto-fill).
                                "screenshot_saved" => {
                                    // Shot done — restore the overlay's per-shot
                                    // capture affinity to the build default.
                                    overlay::state::reset_overlay_shot_affinity(&bridge_app);
                                    if let Err(e) = bridge_app.emit("capture-screenshot-saved", &ev.data) {
                                        log::warn!("emit capture-screenshot-saved failed: {e}");
                                    }
                                }
                                // In-game capture overlay show/hide (Phase A). The
                                // capture daemon's Shift+C hold emits this wire event
                                // (press → show, release → hide); toggle the always-
                                // on-top overlay-host window host-side (instant,
                                // even if its webview is idle) + mirror the visibility
                                // to the overlay's own UI via `overlay-host-visible`.
                                "overlay" => {
                                    let show = ev.data.get("show").and_then(|v| v.as_bool()).unwrap_or(false);
                                    // Track the resulting visibility so the overlay UI can fade in on
                                    // show / out on hide (open was previously instant — no entry anim,
                                    // while close rode Windows' own DWM window-hide fade).
                                    let mut now_visible: Option<bool> = None;
                                    if let Some(win) = bridge_app.get_webview_window("overlay-host") {
                                        // Tap-to-toggle: the daemon emits show=true on Shift+C DOWN and
                                        // show=false on release. Toggle on the DOWN edge and ignore the
                                        // release so a quick TAP latches the overlay open (so it can be
                                        // screenshotted / inspected); tap again to dismiss. Was hold-to-show.
                                        if show {
                                            if win.is_visible().unwrap_or(false) {
                                                // Defer the actual hide to the frontend so the CSS
                                                // scale+fade-out plays first; it invokes
                                                // `hide_overlay_host` once the ~180ms transition ends,
                                                // so close uses the same easing as open (was: Windows'
                                                // DWM window-hide fade, which never matched).
                                                // ponytail: a second Shift+C tap mid-fade reads
                                                // is_visible=true and re-emits false (idempotent)
                                                // rather than re-opening — fine for a tap toggle.
                                                now_visible = Some(false);
                                            } else {
                                                // Harden + monitor-size + (DEV) devtools/reload + show —
                                                // factored into overlay::state so Shift+C and the scrim
                                                // Go-Live (overlay_go_live) surface the host identically.
                                                overlay::state::show_overlay_host(&win);
                                                now_visible = Some(true);
                                            }
                                        }
                                        // show=false (Shift+C release) is ignored — see tap-to-toggle above.
                                    }
                                    // Emit the REAL resulting visibility (a bool), not the raw hotkey edge,
                                    // so the overlay root can fade in on show / out on hide. No-op if the
                                    // release edge (show=false) toggled nothing.
                                    if let Some(v) = now_visible {
                                        let _ = bridge_app.emit("overlay-host-visible", v);
                                    }
                                }
                                other => {
                                    log::debug!("capture bridge: ignoring engine event {other}");
                                }
                            },
                            // Lagged: dropped some events; the next get_state /
                            // state_changed re-syncs. Keep listening.
                            Err(RecvError::Lagged(n)) => {
                                log::debug!("capture bridge: lagged {n} events");
                            }
                            // The sender (client) is gone — client torn down.
                            Err(RecvError::Closed) => {
                                log::debug!("capture bridge: event bus closed — ending");
                                break;
                            }
                        }
                    }
                });
            };
            } // end STT + Game Capture supervisor/bridge block

            // Sub-feature 11 — Tauri loads the frontend directly via devUrl
            // (Vite at 5173 in dev) or the bundled `web/dist/` (asset:// scheme
            // in prod). No port-probe wait, no Node-sidecar handoff — show
            // the window immediately.
            if let Some(window) = app.get_webview_window("main") {
                // Per-worktree dev windows: mortar-pestle_wt.py injects a distinct
                // MORTAR_PESTLE_WT_TITLE so each worktree's app window is tellable apart
                // in the taskbar/Alt-Tab. Absent (normal `tauri dev`, installed app) →
                // the tauri.conf.json title "Mortar & Pestle" stands.
                if let Ok(title) = std::env::var("MORTAR_PESTLE_WT_TITLE") {
                    let _ = window.set_title(&title);
                }
                if let Err(e) = window.show() {
                    eprintln!("window.show failed: {e}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            media_server_port,
            hide_overlay_host,
            commands::video_editor::vedit_project_list,
            commands::video_editor::vedit_project_read,
            commands::video_editor::vedit_project_save,
            commands::video_editor::vedit_project_delete,
            commands::video_editor::vedit_probe,
            commands::video_editor::vedit_remux_start,
            commands::video_editor::vedit_remux_release,
            commands::video_editor::vedit_export_start,
            commands::video_editor::vedit_export_cancel,
            commands::video_editor::vedit_export_status,
            commands::video_editor::vedit_encoder_probe,
            commands::video_editor::vedit_encode_smoke,
            commands::video_editor::vedit_parity_render,
            commands::video_editor::vedit_audio_parity,
            commands::video_editor::vedit_composite_parity,
            commands::video_editor::vedit_lut_import,
            commands::video_editor::vedit_lut_read,
            commands::devtools::open_devtools,
            commands::claude_usage::claude_token_stats,
            commands::browser::browser_navigate,
            commands::browser::browser_back,
            commands::browser::browser_forward,
            commands::browser::browser_reload,
            commands::browser::browser_stop,
            commands::browser::browser_set_bounds,
            commands::browser::browser_set_visible,
            commands::browser::browser_new_tab,
            commands::browser::browser_close_tab,
            commands::browser::browser_switch_tab,
            commands::browser::browser_clear_data,
            commands::browser::browser_clear_cache,
            commands::browser::browser_clear_cookies,
            commands::browser::browser_cache_size,
            commands::browser::browser_cookie_sites,
            commands::browser::browser_overlay_attach,
            commands::browser::browser_overlay_detach,
            commands::browser::browser_overlay_attached,
            blocker::commands::blocker_get_state,
            blocker::commands::blocker_set_enabled,
            blocker::commands::blocker_set_site_allowed,
            blocker::commands::blocker_refresh_lists,
            commands::vault::vault_read_file,
            commands::vault::vault_write_file,
            commands::vault::vault_delete_file,
            commands::vault::vault_toggle_task,
            commands::vault::vault_render_reference,
            commands::vault::vault_resolve_link,
            commands::vaults::vaults_list,
            commands::vaults::vaults_add,
            commands::vaults::vaults_remove,
            commands::vaults::set_active_vault,
            commands::vaults::validate_vault,
            commands::vaults::generate_manifest,
            commands::vaults::scaffold_vault,
            commands::vaults::vault_list_top_folders,
            commands::vaults::set_vault_mapping,
            commands::domain::scaffold_domain,
            commands::domain::read_domain_config,
            commands::release::release_publish,
            commands::daily::daily_get_today,
            commands::daily::daily_get_routine,
            commands::daily::daily_get_recent_notes,
            commands::daily::daily_list_projects,
            commands::daily::daily_get_unorganized,
            commands::daily::daily_toggle_task,
            commands::daily::daily_toggle_routine,
            commands::daily::daily_update_plan_block,
            commands::sessions::sessions_get_range,
            commands::sessions::sessions_append,
            commands::sessions::sessions_update,
            commands::sessions::sessions_delete,
            commands::sessions::sessions_update_note,
            commands::daily::daily_append_freeform_note,
            commands::daily::pulse_note_delete,
            commands::reference::reference_get_vault_log,
            commands::reference::reference_render_update_queue,
            commands::knowledge::knowledge_list_domains,
            commands::knowledge::knowledge_search,
            commands::knowledge::search_pages,
            commands::knowledge::manifest_counts,
            commands::folder::pulse_get_folder,
            commands::folder::vault_get_folder,
            commands::folder::vault_create_folder,
            commands::folder::vault_rename_path,
            commands::folder::vault_delete_folder,
            commands::folder::vault_list_folder_raw,
            commands::food::usda_food_search,
            commands::food::usda_food,
            commands::health::daily_health_op,
            commands::health::health_list_dir,
            commands::recycle_bin::recycle_bin_list,
            commands::recycle_bin::recycle_bin_read,
            commands::recycle_bin::recycle_bin_restore,
            commands::recycle_bin::recycle_bin_delete,
            commands::recycle_bin::recycle_bin_empty,
            commands::recycle_bin::recycle_bin_purge,
            commands::recycle_bin::recycle_bin_set_retention,
            commands::recycle_bin::recycle_bin_snapshot,
            commands::sidebar::sidebar_get_order,
            commands::sidebar::sidebar_set_order,
            commands::media::music_list_albums,
            commands::media::music_read_album,
            commands::media::music_search_tracks,
            commands::media::music_mark_status,
            commands::media::music_mark_rating,
            commands::media::music_set_notes,
            commands::media::music_delete_album,
            commands::media::video_list_series,
            commands::media::video_read_series,
            commands::media::video_probe,
            commands::media::video_mark_episode_watched,
            commands::media::video_mark_series_status,
            commands::media::video_mark_series_rating,
            commands::media::reveal_in_files,
            commands::media::open_path,
            commands::coaching::coaching_reveal_path,
            commands::coaching::coaching_extract_audio,
            commands::coaching::coaching_media_duration,
            commands::coaching::coaching_audio_track_count,
            commands::coaching::deadlock_fetch_match,
            commands::coaching::coaching_classify_match,
            commands::coaching::coaching_cancel,
            commands::coach_job::coach_job_start,
            commands::coach_job::coach_job_status,
            commands::coach_job::coach_job_clear,
            commands::coach_job::coach_job_cancel,
            commands::comms_job::comms_job_start,
            commands::comms_job::comms_job_status,
            commands::comms_job::comms_job_take,
            commands::comms_job::comms_job_clear,
            commands::comms_job::comms_job_cancel,
            commands::music_listen::music_record_listen,
            commands::music_listen::music_listen_minutes_for_month,
            commands::music_search::music_search_releasegroups,
            commands::music_search::music_search_artists,
            commands::music_search::music_search_recordings,
            commands::music_search::music_artist_releasegroups,
            commands::music_search::music_releasegroup_detail,
            commands::music_search::music_release_personnel,
            commands::anime_search::anime_search,
            commands::anime_search::anime_top,
            commands::anime_search::anime_season_now,
            commands::anime_search::anime_detail,
            commands::anime_search::anime_discover,
            commands::anime_search::anime_episodes,
            commands::anime_search::anime_characters,
            commands::anime_search::anime_staff,
            commands::anime_search::anime_relations,
            commands::anime_search::anime_statistics,
            commands::anime_search::anime_recommendations,
            commands::anime_search::character_full,
            commands::anime_search::person_full,
            commands::torrent::torrent_add,
            commands::torrent::torrent_state,
            commands::torrent::torrent_delete,
            commands::anime_download::anime_move_videos,
            commands::video_config::video_get_config,
            commands::video_config::video_set_config,
            commands::anime_download::anime_download_enqueue,
            commands::anime_download::anime_download_status,
            commands::anime_download::anime_download_cancel,
            commands::anime_download::anime_torrent_search,
            commands::anime_download::anime_uninstall,
            commands::music_download::music_download_enqueue,
            commands::music_download::music_download_status,
            commands::music_download::music_download_cancel,
            commands::music_download::music_stream_resolve,
            commands::music_download::music_search_youtube,
            commands::library_import::library_import_enqueue,
            commands::library_import::library_import_status,
            commands::library_import::library_import_cancel,
            commands::downloads_history::downloads_history_load,
            commands::downloads_history::downloads_history_clear,
            commands::music_playlist::music_list_playlists,
            commands::music_playlist::music_read_playlist,
            commands::music_playlist::music_write_playlist,
            commands::music_playlist::music_save_playlist_cover,
            commands::music_playlist::music_delete_playlist,
            commands::skills::skills_list,
            commands::skills::skills_get,
            commands::skills::skills_list_runs,
            commands::skills::skills_run,
            commands::skills::skills_subscribe_run,
            commands::skills::skills_cancel_run,
            commands::skills::skills_resize_run,
            commands::pty::pty_open,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_close,
            commands::self_update::app_self_check_update,
            commands::self_update::app_self_apply_update,
            commands::self_update::app_self_revert,
            commands::self_update::app_self_set_poll_interval,
            commands::self_update::app_relaunch,
            commands::docs::docs_get_manifest,
            commands::design::agent_chat,
            commands::design::agent_chat_cli,
            commands::design::design_cli_auth_status,
            commands::design::design_set_api_key,
            commands::design::design_get_api_key,
            commands::build::build_app_start,
            commands::build::build_app_status,
            commands::build::build_app_cancel,
            commands::credentials::creds_status,
            commands::credentials::creds_init_master,
            commands::credentials::creds_unlock,
            commands::credentials::creds_unlock_via_keyring,
            commands::credentials::creds_lock,
            commands::credentials::creds_touch,
            commands::credentials::creds_list,
            commands::credentials::creds_get,
            commands::credentials::creds_match_host,
            commands::credentials::creds_upsert,
            commands::credentials::creds_delete,
            commands::credentials::creds_folders_set,
            commands::credentials::creds_generate_password,
            commands::credentials::creds_export,
            commands::credentials::creds_import,
            commands::credentials::creds_import_file,
            commands::credentials::creds_delete_import_file,
            commands::credentials::creds_change_master,
            commands::credentials::creds_set_keyring_unlock,
            commands::credentials::creds_settings_set,
            commands::credentials::creds_suppress_blur_lock,
            commands::feedback::feedback_otp_send,
            commands::feedback::feedback_otp_verify,
            commands::feedback::feedback_get_session,
            commands::feedback::feedback_sign_out,
            commands::feedback::feedback_profile_get,
            commands::feedback::feedback_profile_upsert,
            commands::feedback::feedback_posts_list,
            commands::feedback::feedback_post_get,
            commands::feedback::feedback_post_create,
            commands::feedback::feedback_post_delete_own,
            commands::feedback::feedback_vote_toggle,
            commands::feedback::feedback_comments_list,
            commands::feedback::feedback_comment_create,
            commands::feedback::feedback_comment_delete_own,
            commands::feedback::feedback_my_interactions,
            commands::feedback::feedback_follow_toggle,
            commands::feedback::feedback_notifications_poll,
            commands::feedback::feedback_notifications_mark_read,
            commands::feedback::feedback_post_set_status,
            commands::feedback::feedback_post_pin,
            commands::feedback::feedback_post_delete_any,
            commands::feedback::feedback_comment_delete_any,
            commands::feedback::feedback_comment_official_reply,
            commands::feedback::feedback_avatar_upload,
            commands::site::site_push_busy,
            commands::site::site_fetch_bookings,
            commands::capture::get_capture_state,
            commands::capture::capture_start,
            commands::capture::capture_stop,
            commands::capture::capture_arm,
            commands::capture::capture_disarm,
            commands::capture::capture_save_replay,
            commands::capture::capture_screenshot,
            commands::capture::capture_clip_delete,
            commands::capture::capture_list_clips,
            commands::capture::capture_list_screenshots,
            commands::capture::capture_rebind_hotkeys,
            commands::capture::capture_set_overlay_key,
            commands::capture::capture_open_kde_settings,
            commands::capture::set_capture_config,
            commands::capture::get_captures_dir,
            commands::capture::set_captures_dir,
            commands::capture::reset_captures_dir,
            commands::stt::stt_load_model,
            commands::stt::stt_transcribe_file,
            commands::stt::stt_start_dictation,
            commands::stt::stt_stop_dictation,
            commands::stt::stt_set_scrim_key,
            commands::stt::stt_cancel,
            commands::stt::stt_unload,
            commands::stt::stt_status,
            commands::stt::stt_list_models,
            commands::stt::stt_delete_model,
            commands::stt::stt_download_model,
            commands::stt::stt_reveal_model,
            commands::stt::stt_rebind_hotkeys,
            commands::stt::stt_open_kde_settings,
            overlay::state::overlay_go_live,
            overlay::state::overlay_go_offline,
            overlay::state::overlay_get_live_target,
            overlay::state::overlay_list_monitors,
            overlay::state::overlay_set_monitor,
            overlay::state::overlay_note_toast,
            overlay::state::overlay_toast_pending,
            overlay::state::overlay_toast_done,
            commands::vod_timer::vod_set_timer_keys,
            commands::broadcast::broadcast_get_state,
            commands::broadcast::broadcast_request,
            commands::broadcast::broadcast_start_record,
            commands::broadcast::broadcast_stop_record,
            #[cfg(target_os = "windows")] commands::broadcast::broadcast_display_create,
            #[cfg(target_os = "windows")] commands::broadcast::broadcast_display_bounds,
            #[cfg(target_os = "windows")] commands::broadcast::broadcast_display_destroy,
            #[cfg(target_os = "windows")] player_host::player_open,
            #[cfg(target_os = "windows")] player_host::player_bounds,
            #[cfg(target_os = "windows")] player_host::player_close,
            #[cfg(target_os = "windows")] player_host::player_command,
            #[cfg(target_os = "windows")] player_host::player_controls_attach,
            commands::broadcast::broadcast_restart_engine,
            commands::broadcast::broadcast_open_log,
            commands::broadcast::broadcast_paths,
            commands::broadcast::broadcast_remux_start,
            commands::broadcast::broadcast_twitch_ingests,
            commands::broadcast::broadcast_twitch_fetch_key,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                commands::self_update::record_focus_change(*focused);
                commands::feedback::record_focus_change(*focused);
                // The video player's controls ride the app: always-on-top
                // windows that keep floating over other apps are a bug. Driven
                // from here rather than from a handler player_host registers
                // itself, because that one is behind a Once that a single
                // missed window lookup spends for good.
                #[cfg(target_os = "windows")]
                player_host::on_focus_change(window.app_handle(), window.label(), *focused);
                // Lock-on-blur: toplevel focus loss = real app-switch (does NOT
                // fire when focus moves to a child native web view).
                if !*focused {
                    commands::credentials::lock_if_blur_enabled();
                }
            } else if let WindowEvent::CloseRequested { .. } = event {
                // Die-with-app: the hidden `overlay-host` window is created at
                // startup and never destroyed, so Tauri (which exits only on
                // LAST window close) never reaches RunEvent::Exit on a main-window
                // X-click — the 3 sidecar `shutdown()` calls in the Exit arm below
                // never ran, so the daemons outlived the host and the supervisor
                // respawned them. exit(0) forces the app past the still-alive
                // overlay-host and fires RunEvent::Exit, reusing the existing
                // reap path (DRY — no mirrored shutdown here). The Win32 Job
                // Object (winjob::init) is the belt for crash / Task-Manager
                // kills where neither this handler nor the Exit arm can run.
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let RunEvent::Exit = event {
                // The transcode cache deliberately survives exit — the next
                // launch adopts it (see the startup sweep). Killed children
                // leave only `.partial` staging files, which adoption removes.
                commands::video_editor::shutdown_export();
                // Game Capture reap (5-SF2d): terminate the spawned engine + (Unix)
                // unlink the control socket. Ported to Windows (SF7 swaps the libc
                // signals for proc_util::terminate_pid). No-op when adopted/down.
                capture::supervisor::shutdown();
                // STT reap — mirror capture: terminate the worker. Ported to Windows
                // (SF6 swaps the libc signals for proc_util::terminate_pid).
                stt::supervisor::shutdown();
                // Broadcast reap — terminate the spawned libobs engine (no-op when
                // adopted/down; the daemon saves its collection on pipe shutdown,
                // and a forceful kill is recoverable — collections autosave on
                // every mutation).
                broadcast::supervisor::shutdown();
                // No mpv reap here on purpose. One was written and measured on
                // 2026-08-28 and always found `surfaces=0`: the close path has
                // already run `kill_proc`, and mpv quits itself the moment the
                // `--wid` HWND dies (it logs `Exiting... (Quit)`). The only path
                // that could orphan a player — a Task-Manager kill — reaches
                // neither this arm nor `CloseRequested`, and `winjob`'s
                // KILL_ON_JOB_CLOSE job covers it instead.
            }
        });
}

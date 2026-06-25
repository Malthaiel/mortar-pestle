use tauri::{Manager, RunEvent, WindowEvent};

pub mod asset_protocol;
// Windows port: the in-app browser (webkit2gtk), Shield blocker (webkit2gtk-sys
// FFI), and forward proxy are Linux-only subsystems, stubbed/hidden on Windows v1.
// STT and Game Capture are PORTED to Windows (named-pipe IPC) — see `pub mod stt`
// + `pub mod capture` below. Gate the rest so the Windows build links. `overlay`
// stays — it only shells out to `qdbus` and cleanly no-ops off-KDE.
// Shield blocker — host/cosmetic/scriptlet layers are pure Rust (ported to
// Windows); only the WebKit content-filter FFI (`blocker::ffi`) is Linux-only.
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub mod blocker;
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub mod capture;
pub mod commands;
pub mod media_server;
pub mod overlay;
pub mod parsers;
// Loopback-refusing forward proxy = the browser's network boundary. Pure Rust
// (std::net + tokio); ported to Windows alongside the WebView2 content views.
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub mod proxy;
pub mod render;
// STT is ported to Windows (named-pipe IPC, SF1+); Linux uses the Unix socket.
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub mod stt;
pub mod tool_path;
pub mod watcher;

#[tauri::command]
fn media_server_port() -> Option<u16> {
    media_server::port()
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

/// Iskariel rebrand — one-shot migration of app-data from any legacy identifier
/// (`dev.judeau.agentic-os` original, `dev.malthaiel.lodestar` first rebrand) to
/// the current `dev.malthaiel.iskariel`. Tauri derives the data / config / cache
/// dirs from `tauri.conf.json::identifier`, so changing it would otherwise orphan
/// the user's vaults, config, and cache. Strategy: atomic same-volume `rename` of
/// each app-data dir (instant even for multi-GB Library data), then rewrite the
/// absolute legacy-id paths baked into the top-level `*.json` configs — chiefly
/// `vaults.json`, whose App/Pulse/Library/GameWiki mounts are stored as absolute
/// paths. Gated on the destination not existing, so it runs exactly once on the
/// first post-rebrand launch and is a no-op on a fresh install. Best-effort: every
/// error is logged and swallowed (a failed migrate degrades to a fresh-looking
/// app, never a crash; the legacy dir is left intact for manual recovery). MUST
/// run first in `setup`, before the log plugin or any app-data read.
fn migrate_legacy_identity_data(app: &tauri::AppHandle) {
    // Newest legacy id first so a chained install (judeau -> lodestar -> iskariel)
    // migrates from its most recent identity.
    const LEGACY_IDS: [&str; 2] = ["dev.malthaiel.lodestar", "dev.judeau.agentic-os"];
    const NEW_ID: &str = "dev.malthaiel.iskariel";

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
        .register_uri_scheme_protocol("iskariel-asset", |ctx, req| asset_protocol::handle(ctx, req))
        .setup(|app| {
            // Iskariel rebrand — migrate legacy app-data (dev.judeau.agentic-os
            // or dev.malthaiel.lodestar) to dev.malthaiel.iskariel BEFORE the log
            // plugin or any app-data read (the log plugin would otherwise create
            // the new log dir first and block the atomic cache-dir move).
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

            // Anime Browse — capture the per-app cache dir for the Jikan
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

            // Wipe stale transcodes left by a hard-killed prior session — the
            // in-memory registry starts empty so LRU can't see orphans, and a
            // clean exit already wipes this dir (RunEvent::Exit below). One
            // complete transcode per (file, audio) is recreated on next play.
            if let Ok(dir) = parsers::video_transcode::cache_root() {
                let _ = std::fs::remove_dir_all(&dir);
            }

            // SF12 follow-up — loopback HTTP server for media bytes. WebKitGTK
            // rejects custom URI schemes in HTMLMediaElement, so audio/video
            // can't load from `iskariel-asset://`. Spawn an axum router on a
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
            #[cfg(any(target_os = "linux", target_os = "windows"))]
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
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
            // WI-2: load the persisted recordings-folder override into the
            // captures_dir() cache BEFORE the engine spawns, so the daemon binds
            // ISKARIEL_CAPTURES_DIR to the user's chosen dir on first launch.
            commands::capture::init_captures_override(app.handle());

            capture::supervisor::start(app.handle().clone());

            // STT (speech-to-text) — supervisor owns the model/worker lifecycle,
            // mirroring capture's adopt/spawn/respawn + RunEvent::Exit reap.
            stt::supervisor::start(app.handle().clone());

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
                                    if let Some(t) = crate::overlay::state::current_live_target() {
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
                                        let ds = crate::parsers::daily::today_str();
                                        let (ok, err) =
                                            match crate::parsers::sessions::append_quick_note(&ds, &text)
                                            {
                                                Ok(_) => (true, None),
                                                Err(e) => {
                                                    log::warn!("stt: daily-log sink failed: {e:?}");
                                                    (false, Some(format!("{e:?}")))
                                                }
                                            };
                                        let _ = bridge_app.emit(
                                            "stt-dictation-saved",
                                            serde_json::json!({
                                                "ok": ok, "ds": ds, "text": text, "error": err,
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
                                    if let Err(e) = bridge_app.emit("capture-screenshot-saved", &ev.data) {
                                        log::warn!("emit capture-screenshot-saved failed: {e}");
                                    }
                                }
                                // In-game capture overlay show/hide (Phase A). The
                                // capture daemon's Shift+C hold emits this wire event
                                // (press → show, release → hide); toggle the always-
                                // on-top overlay-capture window host-side (instant,
                                // even if its webview is idle) + mirror the visibility
                                // to the overlay's own UI via `overlay-capture-visible`.
                                "overlay" => {
                                    let show = ev.data.get("show").and_then(|v| v.as_bool()).unwrap_or(false);
                                    if let Some(win) = bridge_app.get_webview_window("overlay-capture") {
                                        if show {
                                            // SF9 — harden before showing: topmost,
                                            // excluded from the capture stream, and
                                            // non-activating so the HUD's interactive
                                            // buttons don't pull the game out of focus.
                                            overlay::state::harden_capture_overlay(&win);
                                            let _ = win.show();
                                        } else {
                                            let _ = win.hide();
                                        }
                                    }
                                    let _ = bridge_app.emit("overlay-capture-visible", &ev.data);
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
            } // end STT + Game Capture (linux+windows) supervisor/bridge block

            // In-game overlays — pin the overlay windows above everything (incl.
            // a borderless game) via KWin's scripting API. Tauri/GTK always-on-top
            // and static kwinrulesrc rules both no-op under KWin-Wayland here;
            // `window.keepAbove = true` via a KWin script is what actually works
            // (verified: keepAbove true, layer 3). Best-effort; logged, never fatal.
            // Linux/KDE-only: Windows pins each scrim via `set_always_on_top` directly
            // (SF4, in `overlay::state::overlay_go_live`).
            #[cfg(target_os = "linux")]
            overlay::kwin_rule::ensure_installed(app.handle());

            // Sub-feature 11 — Tauri loads the frontend directly via devUrl
            // (Vite at 5173 in dev) or the bundled `web/dist/` (asset:// scheme
            // in prod). No port-probe wait, no Node-sidecar handoff — show
            // the window immediately.
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.show() {
                    eprintln!("window.show failed: {e}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            media_server_port,
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
            #[cfg(target_os = "linux")]
            commands::dev_service::dev_service_action,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_navigate,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_back,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_forward,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_reload,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_stop,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_set_bounds,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_set_visible,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_new_tab,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_close_tab,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_switch_tab,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_clear_data,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_clear_cache,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_clear_cookies,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_cache_size,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::browser::browser_cookie_sites,
            #[cfg(any(target_os = "linux", target_os = "windows"))] blocker::commands::blocker_get_state,
            #[cfg(any(target_os = "linux", target_os = "windows"))] blocker::commands::blocker_set_enabled,
            #[cfg(any(target_os = "linux", target_os = "windows"))] blocker::commands::blocker_set_site_allowed,
            #[cfg(any(target_os = "linux", target_os = "windows"))] blocker::commands::blocker_refresh_lists,
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
            commands::daily::daily_append_session,
            commands::daily::daily_update_session,
            commands::daily::daily_update_plan_block,
            commands::daily::daily_delete_session,
            commands::daily::daily_update_session_note,
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
            commands::media::video_start_transcode,
            commands::media::video_extract_subs,
            commands::media::reveal_in_files,
            commands::media::open_path,
            commands::coaching::coaching_read_image,
            commands::coaching::coaching_open_path,
            commands::coaching::coaching_extract_audio,
            commands::coaching::deadlock_fetch_match,
            commands::coaching::coaching_classify_match,
            commands::music_listen::music_record_listen,
            commands::music_listen::music_listen_minutes_for_month,
            commands::music_search::music_search_releasegroups,
            commands::music_search::music_search_artists,
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
            commands::qbit::qbit_get_config,
            commands::qbit::qbit_set_config,
            commands::qbit::qbit_status,
            commands::qbit::qbit_start_daemon,
            commands::qbit::qbit_stop_daemon,
            commands::anime_download::anime_download_enqueue,
            commands::anime_download::anime_download_status,
            commands::anime_download::anime_download_cancel,
            commands::anime_download::anime_torrent_search,
            commands::anime_download::anime_uninstall,
            commands::music_download::music_download_enqueue,
            commands::music_download::music_download_status,
            commands::music_download::music_download_cancel,
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
            commands::docs::docs_get_manifest,
            commands::design::agent_chat,
            commands::design::agent_chat_cli,
            commands::design::design_cli_auth_status,
            commands::design::design_set_api_key,
            commands::design::design_get_api_key,
            commands::design::design_read_file,
            commands::design::design_write_file,
            commands::design::design_pending_get,
            commands::design::design_pending_set,
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
            commands::credentials::creds_settings_get,
            commands::credentials::creds_settings_set,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::get_capture_state,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_start,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_stop,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_arm,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_disarm,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_save_replay,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_screenshot,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_clip_delete,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_list_clips,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_rebind_hotkeys,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::capture_open_kde_settings,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::set_capture_config,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::get_captures_dir,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::set_captures_dir,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::capture::reset_captures_dir,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_load_model,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_transcribe_file,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_start_dictation,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_stop_dictation,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_cancel,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_unload,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_status,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_list_models,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_delete_model,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_download_model,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_rebind_hotkeys,
            #[cfg(any(target_os = "linux", target_os = "windows"))] commands::stt::stt_open_kde_settings,
            overlay::state::overlay_go_live,
            overlay::state::overlay_go_offline,
            overlay::state::overlay_get_live_target,
        ])
        .on_window_event(|_window, event| {
            if let WindowEvent::Focused(focused) = event {
                commands::self_update::record_focus_change(*focused);
                // Lock-on-blur: toplevel focus loss = real app-switch (does NOT
                // fire when focus moves to a child native web view).
                if !*focused {
                    commands::credentials::lock_if_blur_enabled();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let RunEvent::Exit = event {
                if let Ok(dir) = parsers::video_transcode::cache_root() {
                    let _ = std::fs::remove_dir_all(&dir);
                }
                parsers::video_transcode::shutdown_active();
                commands::video_editor::shutdown_export();
                // Game Capture reap (5-SF2d): terminate the spawned engine + (Unix)
                // unlink the control socket. Ported to Windows (SF7 swaps the libc
                // signals for proc_util::terminate_pid). No-op when adopted/down.
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                capture::supervisor::shutdown();
                // STT reap — mirror capture: terminate the worker. Ported to Windows
                // (SF6 swaps the libc signals for proc_util::terminate_pid).
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                stt::supervisor::shutdown();
            }
        });
}

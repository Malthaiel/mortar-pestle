//! Embedded, fully-sandboxed in-app browser — now multi-tab.
//!
//! Each tab is its OWN raw `webkit2gtk::WebView` (deliberately NOT a
//! Tauri-managed webview), packed as an overlay child over the main window's
//! GTK container next to the privileged React chrome. Switching tabs shows the
//! active view and hides + mutes the rest, so every tab keeps its live page
//! state (scroll position, video playback, login). Because these views never
//! go through Tauri's webview pipeline, the Tauri IPC bridge
//! (`window.__TAURI_INTERNALS__`, the invoke key, the `ipc` message handler) is
//! NEVER injected into them: there is no bridge for hostile content to reach.
//! Defense-in-depth on top of that, applied PER WEBVIEW in `configure_webview`:
//!
//!   * Network: one persistent, proxy-routed `WebContext` shared by every tab
//!     (so login carries across tabs — one profile) routed through the
//!     loopback-refusing `crate::proxy`.
//!   * Navigation: `decide-policy` allows only `https:` to non-local hosts and
//!     denies every new-window / non-https / local-host navigation.
//!   * Permissions: `permission-request` denies everything (geo/cam/mic/…).
//!   * New windows: `create` returns no widget.
//!   * Downloads: the context cancels every download.
//!   * Engine: WebRTC / media-stream / DNS-prefetch / clipboard / WebGL all
//!     disabled; persistent storage; HW acceleration off; default TLS policy.
//!
//! Each tab also emits `browser-tab-update` Tauri events (title / url / load
//! state / favicon) so the React chrome can label the sidebar tab buttons.
//!
//! The chrome drives everything through the `browser_*` commands below, each of
//! which validates its input. GTK objects are `!Send`, so all state lives in a
//! main-thread `thread_local!` and every command hops onto the GTK main thread
//! via `run_on_main_thread` / `with_webview`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gtk::gdk_pixbuf::prelude::*;
use gtk::prelude::*;
use tauri::{AppHandle, Emitter, Manager};
use webkit2gtk::{
    CookieManagerExt, CookiePersistentStorage, DownloadExt, HardwareAccelerationPolicy, LoadEvent,
    NavigationPolicyDecision, NavigationPolicyDecisionExt, NetworkProxyMode, NetworkProxySettings,
    PermissionRequestExt, PolicyDecisionExt, PolicyDecisionType, SettingsExt, URIRequestExt,
    UserContentInjectedFrames, UserContentManager, UserContentManagerExt, UserStyleLevel,
    UserStyleSheet, WebContext, WebContextExt, WebView, WebViewExt, WebsiteDataManager,
    WebsiteDataManagerExt,
};

/// Whole-browser state: the overlay (built once), the shared persistent context,
/// the shared fullscreen hint label, the live tabs keyed by frontend id, and
/// the active tab id. Only ever touched on the GTK main thread.
struct BrowserState {
    overlay: gtk::Overlay,
    ctx: WebContext,
    hint: gtk::Label,
    tabs: HashMap<String, WebView>,
    active: Option<String>,
}

thread_local! {
    /// The browser state, created lazily on the first navigation/new-tab.
    static STATE: RefCell<Option<BrowserState>> = const { RefCell::new(None) };

    /// True while the active content view is in HTML fullscreen.
    /// `browser_set_bounds` honors this and skips re-clamping, so the
    /// frontend's resize-driven re-sync can't fight the enter-fullscreen
    /// handler's margin drop.
    static FULLSCREEN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

// Navigation/host allow-list helpers now live in the shared `browser_common`
// module (kept identical with the Windows WebView2 driver so the two can't drift).
use crate::commands::browser_common::{host_of_url, nav_allowed};

/// Apply the full sandbox hardening + navigation/permission/new-window policy to
/// a freshly built content view. Called for EVERY tab so the posture is
/// replicated per webview.
fn configure_webview(content: &WebView) {
    if let Some(s) = WebViewExt::settings(content) {
        s.set_enable_webrtc(false);
        s.set_enable_media_stream(false);
        s.set_enable_mock_capture_devices(false);
        s.set_enable_dns_prefetching(false);
        s.set_javascript_can_access_clipboard(false);
        // Content-view inspector: dev builds only, so a release never hands
        // untrusted content a devtools surface.
        s.set_enable_developer_extras(cfg!(debug_assertions));
        // Fullscreen video is intentionally allowed (YouTube, etc.). It adds no
        // sandbox capability; ESC-to-exit can't be trapped by the page.
        s.set_enable_fullscreen(true);
        // GPU attack-surface hardening for the untrusted content view: deny it
        // accelerated compositing and WebGL so hostile pages reach no GPU
        // driver code paths and can't fingerprint via WebGL. (Does NOT touch
        // the GStreamer video sink — normal/fullscreen video stays decoded.)
        s.set_hardware_acceleration_policy(HardwareAccelerationPolicy::Never);
        s.set_enable_webgl(false);
    }

    content.connect_decide_policy(move |_wv, decision, dtype| {
        match dtype {
            PolicyDecisionType::NavigationAction | PolicyDecisionType::NewWindowAction => {
                let uri = decision
                    .downcast_ref::<NavigationPolicyDecision>()
                    .and_then(|d| d.navigation_action())
                    .and_then(|a| a.request())
                    .and_then(|r| r.uri())
                    .map(|g| g.to_string())
                    .unwrap_or_default();
                if dtype == PolicyDecisionType::NewWindowAction || !nav_allowed(&uri) {
                    log::info!("browser: blocked navigation to {uri:?} ({dtype:?})");
                    decision.ignore();
                } else {
                    decision.use_();
                }
                true
            }
            // Response (sub- + main-resource) AND any other/unknown decision type
            // proceed via use_(). WebKitGTK 2.52.x interrupts an *undecided* response
            // policy decision (WebKitPolicyError "Frame load interrupted") → empty
            // page. Against the stale webkit2gtk 2.0.2 bindings a 2.52 response
            // decision need not even map to `PolicyDecisionType::Response`, so we must
            // decide EVERYTHING that isn't a navigation here — not just a named
            // `Response` arm. The proxy + navigation allow-list above remain the
            // security gate, so letting responses proceed is the intended posture.
            _ => {
                decision.use_();
                true
            }
        }
    });

    content.connect_permission_request(|_wv, req| {
        req.deny();
        true
    });

    content.connect_create(|_wv, _action| -> Option<gtk::Widget> { None });
}

/// Wire a content view's signals to `browser-tab-update` events carrying the
/// tab id and whatever changed (title / url + nav state / load state / favicon).
fn wire_signals(app: &AppHandle, content: &WebView, id: &str) {
    let a = app.clone();
    let tid = id.to_string();
    content.connect_title_notify(move |wv| {
        let _ = a.emit(
            "browser-tab-update",
            serde_json::json!({ "tabId": tid, "title": wv.title().map(|g| g.to_string()) }),
        );
    });

    let a = app.clone();
    let tid = id.to_string();
    content.connect_uri_notify(move |wv| {
        let _ = a.emit(
            "browser-tab-update",
            serde_json::json!({
                "tabId": tid,
                "url": wv.uri().map(|g| g.to_string()),
                "canBack": wv.can_go_back(),
                "canForward": wv.can_go_forward(),
            }),
        );
    });

    let a = app.clone();
    let tid = id.to_string();
    content.connect_load_changed(move |wv, ev| {
        log::debug!("browser: tab {tid} load {ev:?} uri={:?}", wv.uri().map(|g| g.to_string()));
        // SF4a — (re)apply Shield's per-tab layers for the host being loaded,
        // gated by the global flag + per-site allow-list. Fires on every load
        // incl. reload, so toggling Shield then reloading takes effect.
        if matches!(ev, LoadEvent::Started) {
            if let Some(ucm) = wv.user_content_manager() {
                let allowed = wv
                    .uri()
                    .and_then(|u| host_of_url(&u))
                    .is_some_and(|h| crate::blocker::is_site_allowed(&h));
                apply_tab_layers(&ucm, crate::blocker::enabled() && !allowed);
            }
        }
        let _ = a.emit(
            "browser-tab-update",
            serde_json::json!({
                "tabId": tid,
                "loading": !matches!(ev, LoadEvent::Finished),
                // Committed = the new document is in & about to paint; the frontend
                // reveals the native view a beat after this (no white flash).
                "committed": matches!(ev, LoadEvent::Committed),
                "url": wv.uri().map(|g| g.to_string()),
                "canBack": wv.can_go_back(),
                "canForward": wv.can_go_forward(),
            }),
        );
    });

    let a = app.clone();
    let tid = id.to_string();
    content.connect_favicon_notify(move |wv| {
        if let Some(data) = favicon_data_url(wv) {
            let _ = a.emit(
                "browser-tab-update",
                serde_json::json!({ "tabId": tid, "favicon": data }),
            );
        }
    });
}

/// Best-effort: render the view's current favicon to a PNG data URL. Returns
/// None when there's no favicon or the conversion fails (the frontend then
/// shows a globe glyph). Uses only the gtk-re-exported cairo/gdk/glib — no new
/// crate. Deliberately does NOT enable an on-disk favicon DB; relies on
/// WebKit's in-memory favicon for the session.
fn favicon_data_url(wv: &WebView) -> Option<String> {
    let surface = wv.favicon()?;
    let img = gtk::cairo::ImageSurface::try_from(surface).ok()?;
    let (w, h) = (img.width(), img.height());
    if w <= 0 || h <= 0 {
        return None;
    }
    let pixbuf = gtk::gdk::pixbuf_get_from_surface(&img, 0, 0, w, h)?;
    let bytes = pixbuf.save_to_bufferv("png", &[]).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        gtk::glib::base64_encode(&bytes)
    ))
}

/// Build (once) the overlay, the shared persistent proxied context, and the
/// shared fullscreen hint, reparenting the main webview into the overlay. No
/// content view is created here — tabs are added by `make_tab`. Runs on the GTK
/// main thread (inside `with_webview`).
fn embed(pw: &tauri::webview::PlatformWebview, proxy_port: u16, profile_dir: std::path::PathBuf) {
    STATE.with(|cell| {
        if cell.borrow().is_some() {
            return;
        }

        let main_wv = pw.inner();
        let main_widget: gtk::Widget = main_wv.clone().upcast();
        // wry/tao build the window as `Window > GtkBox > main_webview`, and wry's
        // borderless-resize handler unwraps `main_webview.parent().parent()` as a
        // gtk::Window on every left button-press. The reparent below MUST keep
        // the webview exactly two levels under the window, or that unwrap hits a
        // non-Window grandparent and aborts.
        let Some(vbox_w) = main_widget.parent() else {
            log::error!("browser embed: main webview has no parent widget");
            return;
        };
        let Some(win_w) = vbox_w.parent() else {
            log::error!("browser embed: main webview parent has no window");
            return;
        };
        let Ok(window) = win_w.downcast::<gtk::Window>() else {
            log::error!("browser embed: main webview grandparent is not a gtk::Window");
            return;
        };
        let Ok(vbox) = vbox_w.downcast::<gtk::Container>() else {
            log::error!("browser embed: main webview parent is not a container");
            return;
        };

        // Persistent, proxy-routed web context, SHARED by every tab. Cookies /
        // localStorage / IndexedDB / cache live on disk under `profile_dir` so a
        // logged-in session (YouTube/Google) survives an app restart. The proxy
        // still refuses loopback/private destinations for ALL request types.
        let cache_dir = profile_dir.join("cache");
        let _ = std::fs::create_dir_all(&profile_dir);
        let _ = std::fs::create_dir_all(&cache_dir);
        let dm = WebsiteDataManager::builder()
            .base_data_directory(profile_dir.to_string_lossy().into_owned())
            .base_cache_directory(cache_dir.to_string_lossy().into_owned())
            .build();
        let proxy_uri = format!("http://127.0.0.1:{proxy_port}");
        let mut proxy = NetworkProxySettings::new(Some(&proxy_uri), &[]);
        dm.set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut proxy));
        // Cookies are in-memory unless told to persist; point them at a SQLite
        // file inside the profile (the cookie manager lives on the data manager
        // in this crate — there is no NetworkSession in webkit2gtk 2.0.2).
        if let Some(cm) = dm.cookie_manager() {
            let cookies = profile_dir.join("cookies.sqlite");
            cm.set_persistent_storage(&cookies.to_string_lossy(), CookiePersistentStorage::Sqlite);
        }
        let ctx = WebContext::with_website_data_manager(&dm);
        ctx.connect_download_started(|_ctx, download| {
            log::warn!(
                "browser: download-started (cancelling) uri={:?}",
                download.request().and_then(|r| r.uri()).map(|g| g.to_string())
            );
            download.cancel();
        });

        // Overlay the content over the main webview WITHOUT changing the
        // webview's depth under the window: the Overlay becomes the window's
        // DIRECT child with the main webview as its base child
        // (`Window > Overlay > webview`). Tab content views are added later as
        // overlay children, each positioned by `browser_set_bounds`.
        vbox.remove(&main_widget);
        window.remove(&vbox);
        let overlay = gtk::Overlay::new();
        overlay.add(&main_widget);

        // Fullscreen "Press Esc" hint — a NATIVE label (a React toast can't
        // paint over the native content views). Shared across tabs; raised above
        // the content on enter-fullscreen.
        let hint = gtk::Label::new(None);
        hint.set_markup(
            "<span background=\"#16161a\" foreground=\"#ffffff\">  \
             Press Esc to exit fullscreen  </span>",
        );
        hint.set_halign(gtk::Align::Center);
        hint.set_valign(gtk::Align::Start);
        hint.set_margin_top(24);
        overlay.add_overlay(&hint);

        window.add(&overlay);
        overlay.show_all();
        hint.hide();

        cell.replace(Some(BrowserState {
            overlay,
            ctx,
            hint,
            tabs: HashMap::new(),
            active: None,
        }));
        log::info!("browser: overlay embedded (proxy 127.0.0.1:{proxy_port})");

        // Shield content-filters — compile the vendored WebKit content-blocker
        // JSON (network + cosmetic) into the store and attach the compiled
        // filters when ready. Async + independent so one bad rule set can't kill
        // the other; `reattach_content_filters` wires the ready set onto tabs.
        let filters_dir = profile_dir.join("filters");
        let _ = std::fs::create_dir_all(&filters_dir);
        crate::blocker::ffi::compile(
            &filters_dir,
            "shield-cosmetic",
            crate::blocker::content_filter_cosmetic_json(),
            reattach_content_filters,
        );
        crate::blocker::ffi::compile(
            &filters_dir,
            "shield-net",
            crate::blocker::content_filter_net_json(),
            reattach_content_filters,
        );
    });
}

/// Re-attach the ready Shield content-filters to every open tab's UCM, gated
/// per-tab by the global flag + per-site allow-list. Invoked on the GTK main
/// thread when a filter finishes compiling (the `on_ready` hook passed to
/// `blocker::ffi::compile`). `remove_all_filters` first keeps it idempotent as
/// each of the two filters becomes ready.
fn reattach_content_filters() {
    STATE.with(|cell| {
        if let Some(st) = cell.borrow().as_ref() {
            for wv in st.tabs.values() {
                let Some(ucm) = wv.user_content_manager() else {
                    continue;
                };
                ucm.remove_all_filters();
                let allowed = wv
                    .uri()
                    .and_then(|u| host_of_url(&u))
                    .is_some_and(|h| crate::blocker::is_site_allowed(&h));
                if crate::blocker::enabled() && !allowed {
                    crate::blocker::ffi::add_ready_filters(&ucm);
                }
            }
        }
    });
}

/// (Re)build a tab's Shield layers to match `on`: clear the per-tab cosmetic
/// stylesheet, content-filters, and scriptlets, then re-add them when `on`.
/// Idempotent (always clears first), so it's safe on every navigation. `on`
/// folds the global flag and the per-site allow-list; the proxy layer is global
/// and untouched here.
fn apply_tab_layers(ucm: &UserContentManager, on: bool) {
    ucm.remove_all_style_sheets();
    ucm.remove_all_filters();
    ucm.remove_all_scripts();
    if !on {
        return;
    }
    let css = crate::blocker::cosmetic_css();
    let sheet = UserStyleSheet::new(
        &css,
        UserContentInjectedFrames::AllFrames,
        UserStyleLevel::User,
        &[],
        &[],
    );
    ucm.add_style_sheet(&sheet);
    crate::blocker::scriptlets::attach(ucm);
    crate::blocker::ffi::add_ready_filters(ucm);
}

// `host_of_url` now lives in the shared `browser_common` module (imported above).

/// Create a content view for `id` (no-op if it already exists), hardened and
/// wired, added to the overlay and started hidden. Must run on the GTK main
/// thread with STATE already embedded.
fn make_tab(app: &AppHandle, id: &str) {
    STATE.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let Some(st) = borrow.as_mut() else {
            return;
        };
        if st.tabs.contains_key(id) {
            return;
        }

        // Per-tab UserContentManager — carries the Shield (ad-blocker) layers
        // (cosmetic stylesheet + WebKit content-filters + scriptlet bootstrap).
        // A fresh tab has no host yet, so it's governed by the global flag;
        // `apply_tab_layers` re-runs per-host on every navigation (see
        // `wire_signals`), and `reattach_content_filters` re-adds filters when an
        // async compile completes. Network blocking is handled out-of-band by
        // `crate::proxy`, which checks the global flag per request.
        let ucm = UserContentManager::new();
        let content = WebView::builder()
            .web_context(&st.ctx)
            .user_content_manager(&ucm)
            .build();
        apply_tab_layers(&ucm, crate::blocker::enabled());
        configure_webview(&content);
        wire_signals(app, &content, id);

        // Surface load failures that were previously SILENT (a failed load left
        // the native view blank-white with no log line and no error page). Log
        // the URI + error and emit a `failed` state to the chrome; return false
        // so WebKit still renders its built-in error page instead of nothing.
        // KEEP — durable diagnostics beyond this regression hunt.
        let a = app.clone();
        let tid = id.to_string();
        content.connect_load_failed(move |_wv, ev, uri, err| {
            log::warn!("browser: tab {tid} LOAD-FAILED {ev:?} uri={uri} err={err:?}");
            let _ = a.emit(
                "browser-tab-update",
                serde_json::json!({ "tabId": tid, "loading": false, "failed": err.message().to_string() }),
            );
            false
        });
        let a = app.clone();
        let tid = id.to_string();
        content.connect_load_failed_with_tls_errors(move |_wv, uri, _cert, flags| {
            log::warn!("browser: tab {tid} LOAD-FAILED-TLS uri={uri} flags={flags:?}");
            let _ = a.emit(
                "browser-tab-update",
                serde_json::json!({ "tabId": tid, "loading": false, "failed": format!("TLS error: {flags:?}") }),
            );
            false
        });

        // FILL + zero margins clamp the view to EXACTLY the rect
        // `browser_set_bounds` asks for (independent of the page's natural size).
        content.set_halign(gtk::Align::Fill);
        content.set_valign(gtk::Align::Fill);
        content.set_margin_start(0);
        content.set_margin_top(0);
        content.set_margin_end(0);
        content.set_margin_bottom(0);
        content.set_size_request(0, 0);
        st.overlay.add_overlay(&content);

        // Per-tab fullscreen: drop margins so the video fills the window, raise
        // the shared hint above the content, restore on leave. Only the active
        // (visible) tab can trigger this.
        let overlay = st.overlay.clone();
        let hint_enter = st.hint.clone();
        let saved = Rc::new(RefCell::new(None::<(i32, i32, i32, i32)>));
        let sm_enter = saved.clone();
        content.connect_enter_fullscreen(move |wv| {
            log::info!("browser: enter-fullscreen");
            FULLSCREEN.with(|f| f.set(true));
            *sm_enter.borrow_mut() = Some((
                wv.margin_start(),
                wv.margin_top(),
                wv.margin_end(),
                wv.margin_bottom(),
            ));
            wv.set_margin_start(0);
            wv.set_margin_top(0);
            wv.set_margin_end(0);
            wv.set_margin_bottom(0);
            overlay.reorder_overlay(&hint_enter, -1);
            hint_enter.show();
            let h = hint_enter.clone();
            gtk::glib::timeout_add_seconds_local(3, move || {
                h.hide();
                gtk::glib::ControlFlow::Break
            });
            false
        });
        let hint_leave = st.hint.clone();
        let sm_leave = saved.clone();
        content.connect_leave_fullscreen(move |wv| {
            log::info!("browser: leave-fullscreen");
            FULLSCREEN.with(|f| f.set(false));
            if let Some((s, t, e, b)) = sm_leave.borrow_mut().take() {
                wv.set_margin_start(s);
                wv.set_margin_top(t);
                wv.set_margin_end(e);
                wv.set_margin_bottom(b);
            }
            hint_leave.hide();
            false
        });

        // Renderer recovery: a killed/crashed web process leaves the view blank
        // with no built-in recovery. Reload ONCE to respawn it; if it dies again
        // within a few seconds it's a deterministic crash, so stop and surface a
        // `crashed` state to the chrome instead of thrashing in a kill/reload
        // loop. The termination reason is logged so a recurrence pinpoints why.
        let a = app.clone();
        let tid = id.to_string();
        let last_recover: Rc<std::cell::Cell<Option<std::time::Instant>>> =
            Rc::new(std::cell::Cell::new(None));
        content.connect_web_process_terminated(move |wv, reason| {
            log::warn!("browser: tab {tid} renderer terminated ({reason:?})");
            let now = std::time::Instant::now();
            let looping = last_recover
                .get()
                .map_or(false, |t| now.duration_since(t).as_secs() < 8);
            if looping {
                let _ = a.emit(
                    "browser-tab-update",
                    serde_json::json!({
                        "tabId": tid,
                        "loading": false,
                        "crashed": format!("{reason:?}"),
                    }),
                );
                return;
            }
            last_recover.set(Some(now));
            let _ = a.emit(
                "browser-tab-update",
                serde_json::json!({ "tabId": tid, "loading": true, "crashed": null }),
            );
            wv.reload();
        });

        content.hide();
        st.tabs.insert(id.to_string(), content);
    });
}

/// Run `f` against the content view for `id` on the GTK main thread (no-op if
/// it doesn't exist).
fn with_tab<F>(app: &AppHandle, id: String, f: F) -> Result<(), String>
where
    F: Fn(&WebView) + Send + 'static,
{
    app.run_on_main_thread(move || {
        STATE.with(|c| match c.borrow().as_ref() {
            Some(st) => match st.tabs.get(&id) {
                Some(wv) => f(wv),
                None => log::warn!("browser: with_tab no-op — tab {id} not in STATE.tabs"),
            },
            None => log::warn!("browser: with_tab no-op — STATE not initialized"),
        });
    })
    .map_err(|e| e.to_string())
}

/// Run `f` against the ACTIVE content view on the GTK main thread (no-op if
/// none active).
fn with_active<F>(app: &AppHandle, f: F) -> Result<(), String>
where
    F: Fn(&WebView) + Send + 'static,
{
    app.run_on_main_thread(move || {
        STATE.with(|c| {
            if let Some(st) = c.borrow().as_ref() {
                if let Some(active) = st.active.as_ref() {
                    if let Some(wv) = st.tabs.get(active) {
                        f(wv);
                    }
                }
            }
        });
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_new_tab(app: AppHandle, id: String, url: Option<String>) -> Result<(), String> {
    let Some(port) = crate::proxy::port() else {
        return Err("browser proxy not ready".into());
    };
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let profile_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("browser-profile");
    let app2 = app.clone();
    let id2 = id.clone();
    window
        .with_webview(move |pw| {
            embed(&pw, port, profile_dir.clone());
            make_tab(&app2, &id2);
        })
        .map_err(|e| e.to_string())?;
    // Load the (restore) URL only AFTER `with_webview` returns. Calling
    // `load_uri` inside the closure runs it while wry holds the webview-
    // dispatcher mutex; `load_uri` fires the `uri` notify synchronously, and
    // that handler (`wire_signals`) calls `app.emit(...)` → `eval_script`, which
    // re-locks the SAME mutex on this thread — a self-deadlock that freezes the
    // whole UI. `with_tab` runs the load as its own main-thread task (the path
    // `browser_navigate` already uses safely), so the dispatcher lock isn't held.
    if let Some(u) = url {
        if nav_allowed(&u) {
            with_tab(&app, id, move |wv| wv.load_uri(&u))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_switch_tab(app: AppHandle, id: String) -> Result<(), String> {
    app.run_on_main_thread(move || {
        STATE.with(|c| {
            if let Some(st) = c.borrow_mut().as_mut() {
                // Hide + mute the previously-active tab so a backgrounded video
                // can't keep playing audio. The page keeps running.
                if let Some(prev) = st.active.clone() {
                    if prev != id {
                        if let Some(wv) = st.tabs.get(&prev) {
                            wv.set_is_muted(true);
                            wv.hide();
                        }
                    }
                }
                if st.tabs.contains_key(&id) {
                    st.active = Some(id);
                }
            }
        });
    })
    .map_err(|e| e.to_string())
}

/// Clear browsing data: delete all cookies (signs you out everywhere — auth is
/// cookie-based) and clear the on-disk cache. Site localStorage/IndexedDB are
/// NOT wiped (no `clear`/`remove` in webkit2gtk 2.0.2). Runs on the GTK main
/// thread against the shared context.
#[tauri::command]
pub fn browser_clear_data(app: AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        STATE.with(|c| {
            if let Some(st) = c.borrow().as_ref() {
                // `delete_all_cookies` is deprecated upstream (2.16+) in favor of
                // `WebsiteDataManager::clear`, which webkit2gtk 2.0.2 does not
                // bind; this is the only cookie-clear API exposed here.
                #[allow(deprecated)]
                if let Some(cm) = st.ctx.website_data_manager().and_then(|dm| dm.cookie_manager()) {
                    cm.delete_all_cookies();
                }
                st.ctx.clear_cache();
            }
        });
    })
    .map_err(|e| e.to_string())
}

/// Clear ONLY the on-disk HTTP cache (keeps cookies / login). GTK main thread.
#[tauri::command]
pub fn browser_clear_cache(app: AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        STATE.with(|c| {
            if let Some(st) = c.borrow().as_ref() {
                st.ctx.clear_cache();
            }
        });
    })
    .map_err(|e| e.to_string())
}

/// Clear ONLY cookies — signs you out everywhere (keeps the cache). GTK main
/// thread. `delete_all_cookies` is deprecated upstream but the only cookie-clear
/// API bound in webkit2gtk 2.0.2 (same as `browser_clear_data`).
#[tauri::command]
pub fn browser_clear_cookies(app: AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        STATE.with(|c| {
            if let Some(st) = c.borrow().as_ref() {
                #[allow(deprecated)]
                if let Some(cm) = st.ctx.website_data_manager().and_then(|dm| dm.cookie_manager()) {
                    cm.delete_all_cookies();
                }
            }
        });
    })
    .map_err(|e| e.to_string())
}

/// Total size (bytes) of the on-disk HTTP cache (`browser-profile/cache/`).
/// Pure filesystem walk offloaded to a blocking thread — the cache can hold tens
/// of thousands of files; does NOT touch GTK.
#[tauri::command]
pub async fn browser_cache_size(app: AppHandle) -> Result<u64, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("browser-profile")
        .join("cache");
    tauri::async_runtime::spawn_blocking(move || {
        let mut total: u64 = 0;
        for entry in walkdir::WalkDir::new(&dir).into_iter().flatten() {
            if entry.file_type().is_file() {
                total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
        total
    })
    .await
    .map_err(|e| e.to_string())
}

/// Distinct cookie sites + total cookie count. Used by the Settings "Browsing
/// data" readout so you can see where you're logged in.
#[derive(serde::Serialize)]
pub struct CookieSites {
    sites: Vec<String>,
    count: usize,
}

/// Read the cookie sites read-only from the WebKit/libsoup cookie SQLite jar.
/// The persistent-cookie schema has shifted across WebKitGTK versions, so probe
/// a few known (table, host-column) shapes; degrade to `Err` (UI shows
/// "unavailable") if none match. NEVER opened read-write — WebKit holds the live
/// handle, so a writer collision could corrupt the WAL.
#[tauri::command]
pub async fn browser_cookie_sites(app: AppHandle) -> Result<CookieSites, String> {
    let db = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("browser-profile")
        .join("cookies.sqlite");
    tauri::async_runtime::spawn_blocking(move || read_cookie_sites(&db))
        .await
        .map_err(|e| e.to_string())?
}

fn read_cookie_sites(db: &std::path::Path) -> Result<CookieSites, String> {
    use rusqlite::{Connection, OpenFlags};
    if !db.exists() {
        return Ok(CookieSites { sites: vec![], count: 0 });
    }
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
    // (table, host-column) candidates across WebKitGTK / libsoup versions.
    for (table, col) in [("moz_cookies", "host"), ("cookies", "domain"), ("Cookie", "domain")] {
        let Ok(mut stmt) = conn.prepare(&format!("SELECT \"{col}\" FROM \"{table}\"")) else {
            continue;
        };
        let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
            continue;
        };
        let mut count = 0usize;
        let mut set = std::collections::BTreeSet::new();
        for host in rows.flatten() {
            count += 1;
            let h = host.trim_start_matches('.').to_ascii_lowercase();
            if !h.is_empty() {
                set.insert(h);
            }
        }
        return Ok(CookieSites { sites: set.into_iter().collect(), count });
    }
    Err("unrecognized cookie store schema".into())
}

#[tauri::command]
pub fn browser_close_tab(app: AppHandle, id: String) -> Result<(), String> {
    app.run_on_main_thread(move || {
        STATE.with(|c| {
            if let Some(st) = c.borrow_mut().as_mut() {
                if let Some(wv) = st.tabs.remove(&id) {
                    // Detach from the overlay and drop → the webview (and its
                    // media) is destroyed, freeing memory.
                    st.overlay.remove(&wv);
                }
                if st.active.as_deref() == Some(id.as_str()) {
                    st.active = None;
                }
            }
        });
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    if !nav_allowed(&url) {
        return Err("blocked: only https:// public URLs are allowed".into());
    }
    with_tab(&app, id, move |wv| wv.load_uri(&url))
}

#[tauri::command]
pub fn browser_back(app: AppHandle, id: String) -> Result<(), String> {
    with_tab(&app, id, |wv| {
        if wv.can_go_back() {
            wv.go_back();
        }
    })
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, id: String) -> Result<(), String> {
    with_tab(&app, id, |wv| {
        if wv.can_go_forward() {
            wv.go_forward();
        }
    })
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, id: String) -> Result<(), String> {
    with_tab(&app, id, |wv| wv.reload())
}

#[tauri::command]
pub fn browser_stop(app: AppHandle, id: String) -> Result<(), String> {
    with_tab(&app, id, |wv| wv.stop_loading())
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), String> {
    with_active(&app, move |wv| {
        // While fullscreen, the margins are pinned to 0 by the enter-fullscreen
        // handler; the frontend's resize-driven re-sync must NOT re-clamp them.
        if FULLSCREEN.with(|f| f.get()) {
            return;
        }
        // The content view fills its overlay minus four margins, so derive
        // end/bottom from the overlay's own allocation — the rect is then exact
        // regardless of the loaded page's natural size.
        let (aw, ah) = wv
            .parent()
            .map(|p| (p.allocated_width(), p.allocated_height()))
            .unwrap_or((0, 0));
        let x = x.max(0);
        let y = y.max(0);
        let w = width.max(0);
        let h = height.max(0);
        wv.set_margin_start(x);
        wv.set_margin_top(y);
        wv.set_margin_end((aw - (x + w)).max(0));
        wv.set_margin_bottom((ah - (y + h)).max(0));
    })
}

#[tauri::command]
pub fn browser_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    with_active(&app, move |wv| {
        // Couple mute to visibility: hiding the active view (route leave) also
        // mutes it; re-entering unmutes. The page keeps running while hidden so
        // re-entering resumes it where it left off.
        wv.set_is_muted(!visible);
        if visible {
            wv.show();
        } else {
            wv.hide();
        }
    })
}

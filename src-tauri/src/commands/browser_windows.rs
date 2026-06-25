//! Windows (WebView2) in-app browser controller — the per-OS sibling of
//! `browser.rs` (WebKitGTK on Linux). Selected by the `#[cfg]/#[path]` switch in
//! `commands/mod.rs`; implements the SAME 15 `browser_*` commands the React
//! chrome calls, so `lib.rs`/`build.rs`/`capabilities` only swap a cfg, not names.
//!
//! Each tab is its OWN isolated Tauri child webview, added over the `main`
//! window via the `unstable` multi-webview API (`Window::add_child`). The child
//! is an External-URL webview: Tauri injects no IPC bridge into it
//! (`withGlobalTauri:false` + it is NOT in the `default` capability's webview
//! list; an explicit empty-permission `browser-content` capability is
//! belt-and-suspenders), so `window.__TAURI_INTERNALS__` / `invoke` are
//! unreachable from hostile content — the same "no bridge for content to reach"
//! guarantee the Linux raw-webkit build has by construction.
//!
//! The real network boundary is the shared loopback-refusing `crate::proxy`,
//! pointed at via `WebviewBuilder::proxy_url` (wry emits `--proxy-server`); it
//! refuses loopback/RFC1918 for ALL request types and honors the Shield
//! host-blocklist + per-site allow-list. Shield cosmetics ride a document-start
//! init-script (best-effort; WebView2 has no compiled content-filter).
//!
//! Tauri `Webview` is `Send + Clone` and every op dispatches to the UI thread
//! internally, so state is a plain `Mutex` static — no GTK `thread_local!` /
//! `run_on_main_thread` dance.
//!
//! Phase 2 (2026-06-23) closed the Phase-1 gaps via a `with_webview` →
//! `ICoreWebView2` reach-through (registered per tab at creation): permission
//! deny-all (PermissionRequested), faithful canBack/canForward (HistoryChanged)
//! + native GoBack/GoForward, favicons (FaviconChanged → PNG data URL), cookie
//! enumeration + profile clear (ClearBrowsingData), and renderer-crash
//! auto-reload (ProcessFailed). Remaining limit: cookie-list/clear need ≥1 open
//! tab (the shared WebView2 profile lives on the child controllers).

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl,
};
// Phase 2 — raw WebView2 (ICoreWebView2) reach-through. `Microsoft::…::Win32::*`
// brings the interfaces + consts; the named items are the event-handler structs
// + `take_pwstr` (mirrors wry's own import). `Interface` powers `.cast()`.
use base64::Engine;
use webview2_com::{
    take_pwstr, ClearBrowsingDataCompletedHandler, FaviconChangedEventHandler,
    GetCookiesCompletedHandler, GetFaviconCompletedHandler, HistoryChangedEventHandler,
    Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler, ProcessFailedEventHandler,
};
use windows::core::{Interface, BOOL, PCWSTR, PWSTR};

/// Live tabs: frontend tab id → its child webview. `Webview` is `Send` so this
/// needs no thread-local; `Mutex::new`/`HashMap::new` are const so no LazyLock.
static TABS: Mutex<Option<HashMap<String, Webview>>> = Mutex::new(None);
/// The active tab id (the one `browser_set_bounds`/`set_visible` act on).
static ACTIVE: Mutex<Option<String>> = Mutex::new(None);

// ── shared allow-list helpers ────────────────────────────────────────────────
// SECURITY-CRITICAL nav/host gate — now shared with the Linux WebKitGTK driver
// (`browser.rs`) via the `browser_common` module, so the two can't drift.
use crate::commands::browser_common::{host_of_url, nav_allowed};

// ── Shield (best-effort cosmetic layer; network blocking rides the proxy) ─────

/// Document-start init-script: inject the Shield cosmetic stylesheet (id'd so it
/// can be stripped per-site) + run the scriptlet bootstrap. Captured at tab
/// creation; the proxy (network) + the per-nav strip below honor live state.
fn shield_init_script() -> String {
    let css = serde_json::to_string(&crate::blocker::cosmetic_css())
        .unwrap_or_else(|_| "\"\"".to_string());
    let scriptlets = crate::blocker::scriptlets::bootstrap();
    format!(
        "(function(){{try{{var d=document,s=d.createElement('style');\
         s.id='__iskariel_shield__';s.textContent={css};\
         (d.head||d.documentElement).appendChild(s);}}catch(e){{}}}})();\n{scriptlets}"
    )
}

/// Strip the injected cosmetic stylesheet (run after navigation when Shield is
/// off for the host — globally disabled or per-site allow-listed). The proxy
/// already stopped network ad/tracker loads; this just un-hides cosmetically.
const STRIP_SHIELD_JS: &str =
    "(function(){try{var e=document.getElementById('__iskariel_shield__');if(e)e.remove();}catch(_){}})();";

// ── tab-store plumbing ───────────────────────────────────────────────────────

/// Run `f` against the webview for `id` (cloned out so the lock isn't held
/// across the dispatch). No-op if the tab doesn't exist (mirrors Linux).
fn with_tab<F: FnOnce(&Webview)>(id: &str, f: F) {
    let wv = TABS
        .lock()
        .ok()
        .and_then(|t| t.as_ref().and_then(|m| m.get(id).cloned()));
    match wv {
        Some(wv) => f(&wv),
        None => log::warn!("browser(win): op on missing tab {id}"),
    }
}

/// Run `f` against the active tab's webview (no-op if none / it's gone).
fn with_active<F: FnOnce(&Webview)>(f: F) {
    let active = ACTIVE.lock().ok().and_then(|a| a.clone());
    if let Some(id) = active {
        with_tab(&id, f);
    }
}

/// A webview to run a profile-wide op (cookie list / clear) against. All tabs
/// share one WebView2 profile (`data_directory`), so any live tab's controller
/// sees the whole store; prefer the active tab, else any open one. None ⇒ no tab.
fn pick_tab() -> Option<Webview> {
    let active = ACTIVE.lock().ok().and_then(|a| a.clone());
    let guard = TABS.lock().ok()?;
    let map = guard.as_ref()?;
    active
        .as_ref()
        .and_then(|id| map.get(id).cloned())
        .or_else(|| map.values().next().cloned())
}

// ── commands (signatures mirror commands/browser.rs) ─────────────────────────

#[tauri::command]
pub async fn browser_new_tab(app: AppHandle, id: String, url: Option<String>) -> Result<(), String> {
    let Some(port) = crate::proxy::port() else {
        return Err("browser proxy not ready".into());
    };
    // Idempotent: re-seeding a tab that already has a view is a no-op.
    if TABS
        .lock()
        .ok()
        .and_then(|t| t.as_ref().map(|m| m.contains_key(&id)))
        .unwrap_or(false)
    {
        return Ok(());
    }

    // WebView2 `add_child` (controller creation) is ASYNC and is pumped by the UI
    // thread's message loop. Calling it directly on a command worker thread blocks
    // forever — the creation callback is never pumped, deadlocking the thread and
    // (because commands serialize) starving all other IPC. Dispatch the whole
    // build+wire onto the main thread and await it via a oneshot: the Windows
    // analogue of the Linux `with_webview`/`run_on_main_thread` discipline.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let app = app.clone();
    app.clone()
        .run_on_main_thread(move || {
            let _ = tx.send((|| -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("no main window")?;
    let profile_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("browser-profile");
    let _ = std::fs::create_dir_all(&profile_dir);

    let proxy = Url::parse(&format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?;
    // Initial URL: the given https URL if allowed, else about:blank (the chrome
    // builds a view with url:null, then drives the real load via browser_navigate).
    let start = url.as_deref().filter(|u| nav_allowed(u)).unwrap_or("about:blank");
    let start_url = Url::parse(start).map_err(|e| e.to_string())?;
    let label = format!("browser-content-{id}");

    let (app_nav, id_nav) = (app.clone(), id.clone());
    let (app_load, id_load) = (app.clone(), id.clone());
    let (app_title, id_title) = (app.clone(), id.clone());

    let builder = WebviewBuilder::new(label, WebviewUrl::External(start_url))
        .proxy_url(proxy)
        .data_directory(profile_dir)
        // All-frames so cosmetics + scriptlets reach ad iframes (parity with the
        // Linux UserScript AllFrames injection).
        .initialization_script_for_all_frames(shield_init_script())
        .on_navigation(move |u| {
            let allowed = nav_allowed(u.as_str());
            if allowed {
                // Address bar + loading. Faithful canBack/canForward ride the
                // Phase-2 HistoryChanged handler, not this emit.
                let _ = app_nav.emit(
                    "browser-tab-update",
                    serde_json::json!({
                        "tabId": id_nav, "url": u.as_str(),
                        "loading": true, "committed": true,
                    }),
                );
            } else {
                log::info!("browser(win): blocked navigation to {u}");
            }
            allowed
        })
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_wv, _ev| false)
        .on_document_title_changed(move |_wv, title| {
            let _ = app_title.emit(
                "browser-tab-update",
                serde_json::json!({ "tabId": id_title, "title": title }),
            );
        })
        .on_page_load(move |wv, payload| match payload.event() {
            PageLoadEvent::Started => {
                // Honor the live Shield toggle + per-site allow-list: strip the
                // cosmetic sheet when off (the init-script always injects it).
                let on = crate::blocker::enabled()
                    && host_of_url(payload.url().as_str())
                        .map_or(true, |h| !crate::blocker::is_site_allowed(&h));
                if !on {
                    let _ = wv.eval(STRIP_SHIELD_JS);
                }
            }
            PageLoadEvent::Finished => {
                let _ = app_load.emit(
                    "browser-tab-update",
                    serde_json::json!({
                        "tabId": id_load, "loading": false,
                    }),
                );
            }
        });

    let window = main.as_ref().window();
    let child = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(800.0, 600.0))
        .map_err(|e| format!("add_child: {e}"))?;
    // Start hidden; the chrome reveals + positions via set_visible/set_bounds.
    let _ = child.hide();

    // ── Phase 2: reach through to the child's ICoreWebView2 to wire the native
    // gaps Tauri's typed surface doesn't expose. Runs on the UI thread; COM is
    // already STA-initialized there, so no CoInitializeEx. Best-effort: a missing
    // interface just leaves that gap at its Phase-1 fallback.
    let (app_hist, id_hist) = (app.clone(), id.clone());
    let (app_fav, id_fav) = (app.clone(), id.clone());
    let (app_crash, id_crash) = (app.clone(), id.clone());
    let _ = child.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else {
            log::warn!("browser(win): no CoreWebView2 on child; Phase-2 handlers skipped");
            return;
        };

        // Permissions: silently deny every request (parity with Linux req.deny()).
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
                if let Some(args) = args {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                }
                Ok(())
            })),
            &mut 0i64,
        );

        // Faithful canBack/canForward: re-query on every history change.
        let _ = core.add_HistoryChanged(
            &HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(s) = sender {
                    let (mut b, mut f) = (BOOL::default(), BOOL::default());
                    let _ = s.CanGoBack(&mut b);
                    let _ = s.CanGoForward(&mut f);
                    let _ = app_hist.emit(
                        "browser-tab-update",
                        serde_json::json!({
                            "tabId": id_hist,
                            "canBack": b.as_bool(),
                            "canForward": f.as_bool(),
                        }),
                    );
                }
                Ok(())
            })),
            &mut 0i64,
        );

        // Favicons: on change, fetch the PNG bytes → base64 data URL → emit.
        if let Ok(core15) = core.cast::<ICoreWebView2_15>() {
            let core_fav = core15.clone();
            let _ = core15.add_FaviconChanged(
                &FaviconChangedEventHandler::create(Box::new(move |_sender, _| {
                    let (app_f, id_f) = (app_fav.clone(), id_fav.clone());
                    let _ = core_fav.GetFavicon(
                        COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG,
                        &GetFaviconCompletedHandler::create(Box::new(move |hr, stream| {
                            hr?;
                            if let Some(stream) = stream {
                                let mut data = Vec::new();
                                let mut buf = [0u8; 8192];
                                loop {
                                    let mut read = 0u32;
                                    let eof = stream
                                        .Read(
                                            buf.as_mut_ptr() as *mut _,
                                            buf.len() as u32,
                                            Some(&mut read),
                                        )
                                        .is_err()
                                        || read == 0;
                                    if eof {
                                        break;
                                    }
                                    data.extend_from_slice(&buf[..read as usize]);
                                }
                                if !data.is_empty() {
                                    let b64 =
                                        base64::engine::general_purpose::STANDARD.encode(&data);
                                    let _ = app_f.emit(
                                        "browser-tab-update",
                                        serde_json::json!({
                                            "tabId": id_f,
                                            "favicon": format!("data:image/png;base64,{b64}"),
                                        }),
                                    );
                                }
                            }
                            Ok(())
                        })),
                    );
                    Ok(())
                })),
                &mut 0i64,
            );
        }

        // Crash recovery: reload once; a repeat within 8s surfaces the crash card.
        let mut last_recover: Option<std::time::Instant> = None;
        let _ = core.add_ProcessFailed(
            &ProcessFailedEventHandler::create(Box::new(move |sender, _args| {
                let now = std::time::Instant::now();
                let looping = last_recover.is_some_and(|t| now.duration_since(t).as_secs() < 8);
                if looping {
                    let _ = app_crash.emit(
                        "browser-tab-update",
                        serde_json::json!({
                            "tabId": id_crash, "loading": false, "crashed": "Crashed",
                        }),
                    );
                } else {
                    last_recover = Some(now);
                    let _ = app_crash.emit(
                        "browser-tab-update",
                        serde_json::json!({
                            "tabId": id_crash, "loading": true,
                            "crashed": serde_json::Value::Null,
                        }),
                    );
                    if let Some(s) = sender {
                        let _ = s.Reload();
                    }
                }
                Ok(())
            })),
            &mut 0i64,
        );
    });

    let mut guard = TABS.lock().map_err(|_| "tabs lock poisoned")?;
    guard.get_or_insert_with(HashMap::new).insert(id, child);
    Ok(())
            })());
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "new_tab task dropped".to_string())?
}

#[tauri::command]
pub fn browser_switch_tab(id: String) -> Result<(), String> {
    // Hide the previously-active view; the chrome shows the new one via
    // set_visible. Set active even if there's no native view (a New-Tab Page),
    // so with_active cleanly no-ops on it.
    let prev = ACTIVE.lock().map_err(|_| "active lock")?.clone();
    if let Some(p) = prev {
        if p != id {
            with_tab(&p, |wv| {
                let _ = wv.hide();
            });
        }
    }
    *ACTIVE.lock().map_err(|_| "active lock")? = Some(id);
    Ok(())
}

#[tauri::command]
pub fn browser_close_tab(id: String) -> Result<(), String> {
    if let Some(wv) = TABS
        .lock()
        .map_err(|_| "tabs lock")?
        .as_mut()
        .and_then(|m| m.remove(&id))
    {
        let _ = wv.close();
    }
    let mut a = ACTIVE.lock().map_err(|_| "active lock")?;
    if a.as_deref() == Some(id.as_str()) {
        *a = None;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(id: String, url: String) -> Result<(), String> {
    if !nav_allowed(&url) {
        return Err("blocked: only https:// public URLs are allowed".into());
    }
    let u = Url::parse(&url).map_err(|e| e.to_string())?;
    with_tab(&id, move |wv| {
        let _ = wv.navigate(u);
    });
    Ok(())
}

// Back/forward use the content view's native session history via the Phase-2
// ICoreWebView2 reach-through (CanGoBack/CanGoForward-guarded GoBack/GoForward) —
// fixes the cross-origin `history.back()` no-op. Reload is native; stop stays
// eval (no native verb). Faithful enabled-state rides the HistoryChanged handler.
#[tauri::command]
pub fn browser_back(id: String) -> Result<(), String> {
    with_tab(&id, |wv| {
        let _ = wv.with_webview(|pw| unsafe {
            if let Ok(core) = pw.controller().CoreWebView2() {
                let mut b = BOOL::default();
                if core.CanGoBack(&mut b).is_ok() && b.as_bool() {
                    let _ = core.GoBack();
                }
            }
        });
    });
    Ok(())
}

#[tauri::command]
pub fn browser_forward(id: String) -> Result<(), String> {
    with_tab(&id, |wv| {
        let _ = wv.with_webview(|pw| unsafe {
            if let Ok(core) = pw.controller().CoreWebView2() {
                let mut f = BOOL::default();
                if core.CanGoForward(&mut f).is_ok() && f.as_bool() {
                    let _ = core.GoForward();
                }
            }
        });
    });
    Ok(())
}

#[tauri::command]
pub fn browser_reload(id: String) -> Result<(), String> {
    with_tab(&id, |wv| {
        let _ = wv.reload();
    });
    Ok(())
}

#[tauri::command]
pub fn browser_stop(id: String) -> Result<(), String> {
    with_tab(&id, |wv| {
        let _ = wv.eval("window.stop()");
    });
    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    with_active(move |wv| {
        let _ = wv.set_bounds(Rect {
            position: LogicalPosition::new(x.max(0) as f64, y.max(0) as f64).into(),
            size: LogicalSize::new(width.max(0) as f64, height.max(0) as f64).into(),
        });
    });
    Ok(())
}

#[tauri::command]
pub fn browser_set_visible(visible: bool) -> Result<(), String> {
    with_active(move |wv| {
        let _ = if visible { wv.show() } else { wv.hide() };
    });
    Ok(())
}

// Profile clear via the Phase-2 reach-through (ICoreWebView2Profile2). The
// profile is shared across tabs, so any live tab clears the whole store;
// fire-and-forget (the no-op completion handler just closes the async op).
// `None` ⇒ clear everything; `Some(kinds)` ⇒ a specific subset.
fn clear_browsing(kinds: Option<COREWEBVIEW2_BROWSING_DATA_KINDS>) -> Result<(), String> {
    let Some(wv) = pick_tab() else {
        log::warn!("browser(win): clear needs an open browser tab (shared WebView2 profile)");
        return Ok(());
    };
    let _ = wv.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let Ok(p13) = core.cast::<ICoreWebView2_13>() else { return };
        let Ok(profile) = p13.Profile() else { return };
        let Ok(profile2) = profile.cast::<ICoreWebView2Profile2>() else { return };
        let done = ClearBrowsingDataCompletedHandler::create(Box::new(move |_| Ok(())));
        let _ = match kinds {
            Some(k) => profile2.ClearBrowsingData(k, &done),
            None => profile2.ClearBrowsingDataAll(&done),
        };
    });
    Ok(())
}

#[tauri::command]
pub fn browser_clear_data() -> Result<(), String> {
    clear_browsing(None)
}

#[tauri::command]
pub fn browser_clear_cache() -> Result<(), String> {
    clear_browsing(Some(
        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE,
    ))
}

#[tauri::command]
pub fn browser_clear_cookies() -> Result<(), String> {
    clear_browsing(Some(COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES))
}

/// On-disk size (bytes) of the WebView2 profile (`browser-profile/`, incl. its
/// `EBWebView/` cache). Honest readout; pure filesystem walk off-thread.
#[tauri::command]
pub async fn browser_cache_size(app: AppHandle) -> Result<u64, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("browser-profile");
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

#[derive(Serialize)]
pub struct CookieSites {
    sites: Vec<String>,
    count: usize,
}

/// Enumerate the WebView2 cookie store: distinct hosts + total count, for the
/// Settings "Browsing data" panel. Bridges the async COM completion to this async
/// command via a oneshot; needs ≥1 open tab (shared profile). Zero tabs ⇒ empty.
#[tauri::command]
pub async fn browser_cookie_sites() -> Result<CookieSites, String> {
    let Some(wv) = pick_tab() else {
        return Ok(CookieSites { sites: Vec::new(), count: 0 });
    };
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<CookieSites, String>>();
    // Hold the sender in a shared slot so a synchronous setup failure (no _2
    // interface, GetCookies refused) still answers `rx` instead of hanging it.
    wv.with_webview(move |pw| {
        let slot = std::rc::Rc::new(std::cell::RefCell::new(Some(tx)));
        let slot2 = slot.clone();
        let done = GetCookiesCompletedHandler::create(Box::new(move |hr, list| {
            let result = (|| -> Result<CookieSites, String> {
                hr.map_err(|e| e.to_string())?;
                let mut sites = BTreeSet::new();
                let mut count = 0usize;
                if let Some(list) = list {
                    let mut n = 0u32;
                    unsafe { list.Count(&mut n) }.map_err(|e| e.to_string())?;
                    count = n as usize;
                    for i in 0..n {
                        let Ok(cookie) = (unsafe { list.GetValueAtIndex(i) }) else {
                            continue;
                        };
                        let mut dom = PWSTR::null();
                        if unsafe { cookie.Domain(&mut dom) }.is_ok() {
                            let d = take_pwstr(dom).trim_start_matches('.').to_ascii_lowercase();
                            if !d.is_empty() {
                                sites.insert(d);
                            }
                        }
                    }
                }
                Ok(CookieSites { sites: sites.into_iter().collect(), count })
            })();
            if let Some(tx) = slot2.borrow_mut().take() {
                let _ = tx.send(result);
            }
            Ok(())
        }));
        let setup = (|| -> windows::core::Result<()> {
            unsafe {
                let core = pw.controller().CoreWebView2()?;
                core.cast::<ICoreWebView2_2>()?
                    .CookieManager()?
                    .GetCookies(PCWSTR::null(), &done)?;
            }
            Ok(())
        })();
        if let Err(e) = setup {
            if let Some(tx) = slot.borrow_mut().take() {
                let _ = tx.send(Err(e.to_string()));
            }
        }
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "cookie query was dropped".to_string())?
}

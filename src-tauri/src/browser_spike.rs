//! SF0 spike (Windows in-app-browser port) — throwaway Path-A feasibility probe.
//!
//! Behind `ISKARIEL_BROWSER_SPIKE=1`, creates one isolated child webview over the
//! `main` window via the Tauri `unstable` multi-webview API (`Window::add_child` +
//! `WebviewBuilder`) — the exact primitive the real Windows controller (SF3) uses.
//! It exercises every Path-A capability the port depends on (proxy routing,
//! document-start init-script, navigation gate, title + load events, child
//! placement over the chrome) so isolation + z-order can be eyeballed at runtime
//! before the full controller is trusted. DELETE this module once Path A is
//! runtime-confirmed (see the Browser port plan, SF0).

use std::time::Duration;

use tauri::{
    webview::WebviewBuilder, AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

/// Entry point, called from `lib.rs` setup (Windows only). No-op unless the
/// `ISKARIEL_BROWSER_SPIKE` env var is set — zero cost in a normal run.
pub fn run(app: AppHandle) {
    if std::env::var_os("ISKARIEL_BROWSER_SPIKE").is_none() {
        return;
    }
    log::info!("[browser-spike] ISKARIEL_BROWSER_SPIKE set — probing Path A");
    tauri::async_runtime::spawn(async move {
        // The proxy binds asynchronously at startup; wait briefly for its port.
        let mut port = None;
        for _ in 0..40 {
            if let Some(p) = crate::proxy::port() {
                port = Some(p);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let Some(port) = port else {
            log::error!("[browser-spike] proxy port never bound — aborting spike");
            return;
        };
        let app2 = app.clone();
        if let Err(e) = app.run_on_main_thread(move || open(&app2, port)) {
            log::error!("[browser-spike] run_on_main_thread failed: {e}");
        }
    });
}

/// Create the child webview on the main thread (Tauri webview ops are main-thread).
fn open(app: &AppHandle, proxy_port: u16) {
    let Some(main) = app.get_webview_window("main") else {
        log::error!("[browser-spike] no `main` window");
        return;
    };
    let Ok(proxy) = tauri::Url::parse(&format!("http://127.0.0.1:{proxy_port}")) else {
        return;
    };
    let Ok(start) = tauri::Url::parse("https://example.org/") else {
        return;
    };

    // The init-script logs the isolation surface from inside the content view —
    // open the child's devtools to confirm __TAURI__ / __TAURI_INTERNALS__ /
    // isTauri are all undefined and invoke() is unreachable (the Path-A gate).
    const PROBE: &str = "console.log('[spike] init-script ran @ document-start');\
        console.log('[spike] __TAURI__=', typeof window.__TAURI__,\
        ' __TAURI_INTERNALS__=', typeof window.__TAURI_INTERNALS__,\
        ' isTauri=', window.isTauri);";

    let builder = WebviewBuilder::new("browser-content-spike", WebviewUrl::External(start))
        .proxy_url(proxy)
        .initialization_script(PROBE)
        .on_navigation(|url| {
            log::info!("[browser-spike] navigation → {url}");
            url.scheme() == "https"
        })
        .on_document_title_changed(|_webview, title| {
            log::info!("[browser-spike] title → {title}");
        })
        .on_page_load(|_webview, payload| {
            log::info!("[browser-spike] page-load → {}", payload.url());
        });

    let window = main.as_ref().window();
    match window.add_child(
        builder,
        LogicalPosition::new(120.0, 120.0),
        LogicalSize::new(960.0, 640.0),
    ) {
        Ok(_child) => log::info!(
            "[browser-spike] child created over `main` (proxy :{proxy_port}); eyeball: \
             paints above the chrome, https loads, http://127.0.0.1:7878 refused"
        ),
        Err(e) => log::error!("[browser-spike] add_child failed: {e}"),
    }
}

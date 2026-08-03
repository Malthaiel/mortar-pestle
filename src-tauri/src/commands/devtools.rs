//! Dev-build devtools opener. The app-wide custom context menu suppresses the
//! native WebKit menu — and with it the native "Inspect Element" — so dev
//! builds expose this command behind a DEV-gated context-menu row
//! (ContextMenuProvider). Release builds keep the command registered but
//! no-op: the browser-module rule — a release never hands out a devtools
//! surface (commands/browser.rs:105 precedent).

#[cfg(debug_assertions)]
use tauri::Manager;

#[tauri::command]
pub fn open_devtools(app: tauri::AppHandle) {
    #[cfg(debug_assertions)]
    // get_webview, not get_webview_window: once a browser tab attaches a child
    // webview to "main", is_webview_window() is false and get_webview_window
    // returns None. The main webview's own label is still "main".
    if let Some(w) = app.get_webview("main") {
        w.open_devtools();
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
}

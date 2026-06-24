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
    if let Some(w) = app.get_webview_window("main") {
        w.open_devtools();
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
}

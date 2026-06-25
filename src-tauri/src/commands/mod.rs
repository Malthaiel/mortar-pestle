pub mod anime_download;
pub mod anime_search;
// Windows port: the browser is a per-OS module — `browser.rs` drives WebKitGTK
// on Linux, `browser_windows.rs` drives WebView2 child webviews on Windows. Both
// expose the SAME `browser_*` command names, so the handler/build/capabilities
// sites only swap a cfg. capture + stt are ported to Windows (named-pipe IPC).
#[cfg(target_os = "linux")]
pub mod browser;
#[cfg(target_os = "windows")]
#[path = "browser_windows.rs"]
pub mod browser;
// Shared (cross-platform) browser nav/host allow-list helpers, used by both the
// Linux `browser.rs` and Windows `browser_windows.rs` drivers.
pub mod browser_common;
pub mod build;
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub mod capture;
pub mod claude_usage;
pub mod coaching;
pub mod credentials;
pub mod daily;
pub mod design;
// Windows port (SF5): systemd dev-service control is Linux-only — on Windows
// the dev loop is `npm run tauri dev` in a terminal, no service to restart.
#[cfg(target_os = "linux")]
pub mod dev_service;
pub mod devtools;
pub mod docs;
pub mod domain;
pub mod downloads_history;
pub mod folder;
pub mod food;
pub mod health;
pub mod knowledge;
pub mod library_import;
pub mod manifest_gen;
pub mod media;
pub mod music_download;
pub mod music_listen;
pub mod music_playlist;
pub mod music_search;
pub mod proc_util;
pub mod pty;
pub mod qbit;
pub mod recycle_bin;
pub mod reference;
pub mod release;
pub mod self_update;
pub mod sidebar;
pub mod skills;
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub mod stt;
pub mod vault;
pub mod vaults;
pub mod video_editor;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

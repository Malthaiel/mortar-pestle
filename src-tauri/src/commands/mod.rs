pub mod anime_download;
pub mod anime_search;
pub mod broadcast;
// `browser` drives WebView2 child webviews. Was a per-OS pair until Linux was
// dropped as a target (2026-08-06); the WebKitGTK driver and its cfg/#[path]
// switch are gone and `browser_windows.rs` took the plain name.
pub mod browser;
// Browser nav/host allow-list helpers, split out when the driver was per-OS.
pub mod browser_common;
pub mod build;
pub mod capture;
pub mod claude_usage;
pub mod coach_job;
pub mod coaching;
// Comms-extraction job (Scrim Coaching): stt-engine-driving, so it shares stt's
// per-OS gate (the `crate::stt` bridge only exists on linux/windows builds).
pub mod comms_job;
pub mod credentials;
pub mod daily;
pub mod design;
pub mod devtools;
pub mod docs;
pub mod domain;
pub mod downloads_history;
pub mod feedback;
pub mod folder;
pub mod food;
pub mod health;
pub mod job_queue;
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
pub mod video_config;
pub mod recycle_bin;
pub mod reference;
pub mod release;
pub mod self_update;
pub mod sessions;
pub mod sidebar;
pub mod site;
pub mod skills;
pub mod stt;
pub mod torrent;
pub mod vault;
pub mod vaults;
pub mod video_editor;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

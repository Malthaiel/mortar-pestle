//! Save path (sub-plan 3 SF1) — the live, video-only mux.
//!
//! Each clip's encoded Annex-B H.264 is teed (by the `Recorder`) into a per-clip
//! FIFO; system ffmpeg reads that FIFO and writes a **fragmented, kill-survivable**
//! MP4 directly at the final path, then (on a clean stop) faststart-remuxes it in
//! place for smooth WebKitGTK playback. No codec library is linked — ffmpeg is a
//! subprocess, exactly like the `run` proof harness's `decode-proof`.
//!
//! Audio (Step 6) is added by `mux.rs` at FINALIZE (not live): the recording stays a
//! single video FIFO, and the cut PCM is muxed into an Opus track during the same
//! ffmpeg pass that faststarts the file. The video path is `-c:v copy`.

#[cfg(unix)]
pub mod fifo;
pub mod mux;
#[cfg(unix)]
pub mod namer;
// Windows GameNamer: a separate per-OS file (`#[path]`) so `namer.rs` stays
// Linux-only and byte-identical — foreground-window-title detection, no `/proc`.
#[cfg(windows)]
#[path = "namer_win.rs"]
pub mod namer;

pub use mux::ClipMux;

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Session-scoped runtime dir (tmpfs under `$XDG_RUNTIME_DIR`) holding the per-clip
/// FIFOs + the control socket. `/tmp` fallback keeps a headless run working.
#[cfg(unix)]
fn runtime_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("mortar-pestle")
}

/// Windows scratch dir under `%TEMP%` — the captures-root fallback when neither
/// `MORTAR_PESTLE_CAPTURES_DIR` nor `%USERPROFILE%` is set (no per-clip FIFOs on Windows).
#[cfg(windows)]
fn runtime_dir() -> PathBuf {
    std::env::temp_dir().join("mortar-pestle")
}

/// A unique per-clip FIFO path under the session runtime dir (named by wall-clock
/// ms so sequential clips never collide).
#[cfg(unix)]
fn fifo_path() -> PathBuf {
    let dir = runtime_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("clip-{}.h264.fifo", now_ms()))
}

/// The Library captures root: `MORTAR_PESTLE_CAPTURES_DIR` (set by the app's engine
/// spawn = `library_vault_root()/Captures`), with a runtime-dir fallback so manual
/// `nc -U` testing works without the app driving the spawn.
#[cfg(unix)]
fn captures_root() -> PathBuf {
    std::env::var_os("MORTAR_PESTLE_CAPTURES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_dir().join("captures"))
}

/// Windows captures root: `MORTAR_PESTLE_CAPTURES_DIR` (the app sets it) → default
/// `%USERPROFILE%\Videos\Iskariel` (decision #11 — Roaming app-data is wrong for
/// multi-GB media) → `%TEMP%\iskariel\captures` as a last resort.
#[cfg(windows)]
fn captures_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("MORTAR_PESTLE_CAPTURES_DIR") {
        return PathBuf::from(dir);
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        return PathBuf::from(home).join("Videos").join("Iskariel");
    }
    runtime_dir().join("captures")
}

/// Compute (and create the parent dir of) the final `.mp4` path for a clip of
/// `game` (an already-sanitized folder component from the GameNamer, or "Desktop").
/// Names the file `<Game> YYYY-MM-DD HH-MM-SS.mp4`, deduped on a same-second clash.
pub fn clip_mp4_path(game: &str) -> Result<String, String> {
    let dir = captures_root().join(game);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create captures dir {}: {e}", dir.display()))?;
    let stem = format!("{game} {}", timestamp_stem());
    let mut path = dir.join(format!("{stem}.mp4"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).mp4"));
        n += 1;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Like [`clip_mp4_path`] but tags the file as an instant-replay save:
/// `<Game> YYYY-MM-DD HH-MM-SS Replay.mp4` (so replays are distinguishable from
/// manual recordings in the Library). Phase 2.
pub fn clip_replay_path(game: &str) -> Result<String, String> {
    let dir = captures_root().join(game);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create captures dir {}: {e}", dir.display()))?;
    let stem = format!("{game} {} Replay", timestamp_stem());
    let mut path = dir.join(format!("{stem}.mp4"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).mp4"));
        n += 1;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Local-time `YYYY-MM-DD HH-MM-SS` stem via `date` (no chrono dep). Falls back to
/// a unix-ms stem if `date` is somehow unavailable.
#[cfg(unix)]
fn timestamp_stem() -> String {
    if let Ok(out) = std::process::Command::new("date").arg("+%Y-%m-%d %H-%M-%S").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    now_ms().to_string()
}

/// Windows stem: local-time `YYYY-MM-DD HH-MM-SS` via Win32 `GetLocalTime` (no
/// chrono dep — matches the Unix `date +%Y-%m-%d %H-%M-%S` output). Falls back to a
/// unix-ms stem only if `GetLocalTime` somehow yields a zero year.
#[cfg(windows)]
fn timestamp_stem() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let st = unsafe { GetLocalTime() };
    if st.wYear == 0 {
        return now_ms().to_string();
    }
    format!(
        "{:04}-{:02}-{:02} {:02}-{:02}-{:02}",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
    )
}

/// Wall-clock unix milliseconds (saturates to 0 before the epoch).
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

//! mortar-pestle-broadcast bridge — the src-tauri side of the Broadcast engine
//! (Broadcast SP1 SF5).
//!
//! The engine itself is a **separate binary** (`mortar-pestle-broadcast`,
//! GPL-2.0 — the license boundary is this process boundary). This module is
//! deliberately decoupled from it: there is NO engine-crate dependency and no
//! code sharing. The ONLY coupling is
//!
//!   1. the runtime-resolved binary **path** ([`carriage::resolve_engine_binary`]), and
//!   2. the NDJSON control **protocol** — serde structs mirrored by hand in
//!      [`client`] (the engine's canonical copy lives in
//!      `mortar-pestle-broadcast/src/daemon/protocol.rs`). Mirrored, never
//!      shared: no crate may cross the GPL boundary in either direction.
//!
//! Third instance of the capture/stt supervision pattern. Broadcast-specific
//! deltas: the spawn-time env var is `MORTAR_PESTLE_CAPTURES_DIR` (recordings
//! land through the same Captures root as game clips) and the log filename is
//! `mortar-pestle-broadcast.log`; like stt there is no config-push machinery
//! (the engine owns its own scene-collection/profile store).
//!
//! Module map:
//! - [`carriage`] — runtime presence-check that resolves the engine binary.
//! - [`client`]   — the sole owner of the control pipe; an async NDJSON
//!   request/response + event client with a typed [`client::StateSnapshot`].
//! - [`supervisor`] — the engine lifecycle owner: adopt-first / spawn-second,
//!   respawn-with-backoff, crash-loop terminal, and the `RunEvent::Exit` reap.

pub mod carriage;
pub mod client;
#[cfg(windows)]
pub mod display_host;
pub mod supervisor;

use std::path::PathBuf;
use std::process::Stdio;

use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncBufReadExt, BufReader};

/// The env-var name carrying the recordings root — the SAME name + value the
/// capture engine gets (`captures_dir()`), so Broadcast recordings land in the
/// one Captures tree (`RootKind::Captures` consumer surfaces unchanged).
const CAPTURES_DIR_ENV: &str = "MORTAR_PESTLE_CAPTURES_DIR";

/// Spawn the Broadcast engine daemon (driven by [`supervisor`]) — a bare,
/// kill-on-drop child. Argv is `[bin, "daemon"]` (the sidecar convention).
/// Returns the child PID (for the reap) plus a join-handle that resolves to
/// the child's exit code once it exits (drives the supervisor's respawn
/// decision). The child stays **owned by the wait-task** so
/// `kill_on_drop(true)` keeps holding — the supervisor never owns the `Child`,
/// only its PID + exit signal.
///
/// MUST be called from inside the Tokio reactor (it is — the supervise loop
/// runs on `tauri::async_runtime::spawn`).
pub fn spawn_engine_child(bin: &PathBuf) -> std::io::Result<(u32, JoinHandle<Option<i32>>)> {
    // Recordings root, created before spawn so the engine never has to mkdir it.
    let captures_dir = PathBuf::from(crate::commands::vault::captures_dir());
    if let Err(e) = std::fs::create_dir_all(&captures_dir) {
        log::warn!("broadcast: failed to create captures dir {}: {e}", captures_dir.display());
        // Continue: the engine creates it on record start anyway.
    }

    // Log file: %LOCALAPPDATA%\mortar-pestle\logs\mortar-pestle-broadcast.log (parent created).
    let log_path = engine_log_path();
    if let Some(parent) = log_path.as_ref().and_then(|p| p.parent()) {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("broadcast: failed to create log dir {}: {e}", parent.display());
        }
    }

    let mut cmd = crate::commands::proc_util::tokio_cmd(bin);
    cmd.arg("daemon")
        .env(CAPTURES_DIR_ENV, &captures_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(rust_log) = std::env::var_os("RUST_LOG") {
        cmd.env("RUST_LOG", rust_log);
    }

    let mut child = cmd.spawn()?;
    // A freshly-spawned child always has a PID; `None` means it exited instantly.
    // Treat that as a spawn failure rather than recording pid 0.
    let Some(pid) = child.id() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "spawned engine has no PID (exited immediately)",
        ));
    };
    log::info!(
        "broadcast: spawned engine {} daemon pid {pid} (captures dir {})",
        bin.display(),
        captures_dir.display()
    );

    // Open the log file once for the appending drain (best-effort; if it can't
    // be opened, fall back to forwarding child output to the app log).
    let log_file = log_path
        .and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok());
    let log_file = std::sync::Arc::new(std::sync::Mutex::new(log_file));

    if let Some(out) = child.stdout.take() {
        tokio::spawn(drain_to_log(out, log_file.clone(), "out"));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(drain_to_log(err, log_file.clone(), "err"));
    }

    // `kill_on_drop(true)` means `child` must outlive the daemon: the wait-task
    // owns it and `wait`s, yielding the exit code to the supervisor.
    let wait = tauri::async_runtime::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                log::info!("broadcast: engine pid {pid} exited ({status})");
                status.code()
            }
            Err(e) => {
                log::warn!("broadcast: engine wait failed: {e}");
                None
            }
        }
    });

    Ok((pid, wait))
}

/// Drain one child pipe line-by-line into the shared log file (or the app log
/// facade as a fallback). Never panics on child output.
async fn drain_to_log<R>(
    pipe: R,
    sink: std::sync::Arc<std::sync::Mutex<Option<std::fs::File>>>,
    tag: &'static str,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    use std::io::Write;
    let mut lines = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let wrote = sink
            .lock()
            .ok()
            .and_then(|mut g| g.as_mut().map(|f| writeln!(f, "[{tag}] {line}").is_ok()))
            .unwrap_or(false);
        if !wrote {
            log::info!("broadcast[{tag}]: {line}");
        }
    }
}

/// The sidecar's stdout/stderr log sink. Windows:
/// `%LOCALAPPDATA%\mortar-pestle\logs\mortar-pestle-broadcast.log`; Linux:
/// `~/.local/state/mortar-pestle/mortar-pestle-broadcast.log`. `None` if the
/// base env var is unset. `pub(crate)`: the settings tab's "Open log" reads it.
#[cfg(windows)]
pub(crate) fn engine_log_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|base| {
        PathBuf::from(base).join("mortar-pestle").join("logs").join("mortar-pestle-broadcast.log")
    })
}

#[cfg(not(windows))]
pub(crate) fn engine_log_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home).join(".local/state/mortar-pestle/mortar-pestle-broadcast.log")
    })
}

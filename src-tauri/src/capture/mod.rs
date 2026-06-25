//! Game Capture bridge — the src-tauri side of the studio-tier capture engine
//! (Game Capture Phase 1, Step 2 `[APP]`).
//!
//! The engine itself is a **separate, optional binary** (`iskariel-capture`,
//! built only in the studio tier). This crate is deliberately decoupled from it:
//! there is NO `use iskariel_capture::…`, no engine-crate dependency, and no
//! `studio` cargo feature on src-tauri. The ONLY coupling is
//!
//!   1. the runtime-resolved binary **path** ([`carriage::resolve_engine_binary`]), and
//!   2. the NDJSON control **protocol** — serde structs duplicated byte-for-byte
//!      in [`client`] (the engine's canonical copy lives in
//!      `iskariel-capture/src/daemon/protocol.rs`; a cross-crate round-trip test
//!      in `tests/capture_roundtrip.rs` gates the two against drift).
//!
//! Module map:
//! - [`carriage`] — runtime presence-check that resolves the engine binary (5-SF2a).
//! - [`client`]   — the sole owner of the Unix control socket; an async NDJSON
//!   request/response + event client (5-SF2e).
//! - [`supervisor`] — the engine lifecycle owner: adopt-first / spawn-second,
//!   respawn-with-backoff, crash-loop terminal, and the `RunEvent::Exit` reap
//!   (5-SF2c/d). It drives the spawn primitives below.

pub mod carriage;
pub mod client;
pub mod supervisor;

use std::path::PathBuf;
use std::process::Stdio;

use serde_json::Value;
use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;

/// The resolved env-var name carrying the captures output root (plan Risk #10):
/// `captures_dir()` (`%USERPROFILE%\Videos\Iskariel` on Windows — decision #11).
/// The app's clip-list scan (Step 4) reads the same root.
const CAPTURES_DIR_ENV: &str = "ISKARIEL_CAPTURES_DIR";

/// Spawn the capture engine daemon (5-SF2b, driven by [`supervisor`]) — a bare,
/// kill-on-drop child. Argv is `[bin, "daemon"]`. Returns the child PID (for the
/// reap) plus a join-handle that resolves to the child's exit code once it
/// exits (drives the supervisor's respawn decision). The child itself stays
/// **owned by the wait-task** so `kill_on_drop(true)` keeps holding — the
/// supervisor never owns the `Child`, only its PID + exit signal.
///
/// Environment:
/// - `ISKARIEL_CAPTURES_DIR` = `captures_dir()` (created up-front).
/// - `RUST_LOG` is passed through from the app's own env when set.
///
/// stdout + stderr are drained line-by-line to `~/.local/state/iskariel/
/// iskariel-capture.log` (parent created). Mirrors the
/// `parsers::video_transcode` Tokio + `Stdio` + `kill_on_drop` idiom and the
/// `commands::build` concurrent-drain idiom.
///
/// MUST be called from inside the Tokio reactor (it is — the supervise loop runs
/// on `tauri::async_runtime::spawn`): spawning a `tokio::process::Child` off the
/// reactor panics with "there is no reactor running".
pub fn spawn_engine_child(bin: &PathBuf) -> std::io::Result<(u32, JoinHandle<Option<i32>>)> {
    // Captures root: `captures_dir()` (`%USERPROFILE%\Videos\Iskariel` on Windows
    // per decision #11), created before spawn so the engine never has to mkdir it.
    // Clips live outside the Library, so the bin resolves them via the `captures`
    // mount (`RootKind::Captures`), not `root:'library'`.
    let captures_dir = PathBuf::from(crate::commands::vault::captures_dir());
    if let Err(e) = std::fs::create_dir_all(&captures_dir) {
        log::warn!("capture: failed to create captures dir {}: {e}", captures_dir.display());
        // Continue: the engine resolves/creates its own per-game subdirs; a
        // missing root is the engine's error to surface, not a spawn blocker.
    }

    // Log file: ~/.local/state/iskariel/iskariel-capture.log (parent created).
    let log_path = engine_log_path();
    if let Some(parent) = log_path.as_ref().and_then(|p| p.parent()) {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("capture: failed to create log dir {}: {e}", parent.display());
        }
    }

    let mut cmd = TokioCommand::new(bin);
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
    // Treat that as a spawn failure (the supervisor's crash-loop logic handles the
    // Err) rather than recording pid 0 — `kill(0, …)` would signal the CALLER's
    // process group at reap time. Dropping `child` kills it (it's already gone).
    let Some(pid) = child.id() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "spawned engine has no PID (exited immediately)",
        ));
    };
    log::info!(
        "capture: spawned engine {} daemon pid {pid} (captures dir {})",
        bin.display(),
        captures_dir.display()
    );

    // Open the log file once for the appending drain (best-effort; if it can't
    // be opened, fall back to forwarding child output to the app log).
    let log_file = log_path
        .and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok());
    let log_file = std::sync::Arc::new(std::sync::Mutex::new(log_file));

    // Concurrent drain tasks (build.rs idiom): one per pipe.
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
                log::info!("capture: engine pid {pid} exited ({status})");
                status.code()
            }
            Err(e) => {
                log::warn!("capture: engine wait failed: {e}");
                None
            }
        }
    });

    Ok((pid, wait))
}

/// Read the persisted engine config at `path` as raw JSON for the supervisor's
/// best-effort `set_config` push. The file is camelCase (JS-authored) and the
/// engine accepts the object verbatim, so this stays schema-agnostic — no
/// decode/re-encode through [`client::CaptureConfig`]. Returns `None` (skip the
/// push) when the file is absent, unreadable, or not a JSON object. The `path`
/// is the same one [`commands::capture::config_file`] writes, resolved once from
/// the real `AppHandle` at supervisor start (no hardcoded app-id).
pub fn read_persisted_config(path: &std::path::Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Value>(&text) {
        Ok(v @ Value::Object(_)) => Some(v),
        _ => None,
    }
}

/// The persisted engine-config filename (config-push contract). Shared by the
/// command writer and the supervisor reader.
pub const CONFIG_FILE: &str = "iskariel-capture.json";

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
            // Log-file unavailable — forward to the app log so output isn't lost.
            log::info!("capture[{tag}]: {line}");
        }
    }
}

/// The sidecar's stdout/stderr log sink. Windows:
/// `%LOCALAPPDATA%\iskariel\logs\iskariel-capture.log`; Linux:
/// `~/.local/state/iskariel/iskariel-capture.log`. `None` if the base env var is unset.
#[cfg(windows)]
fn engine_log_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("iskariel").join("logs").join("iskariel-capture.log"))
}

#[cfg(not(windows))]
fn engine_log_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home).join(".local/state/iskariel/iskariel-capture.log")
    })
}

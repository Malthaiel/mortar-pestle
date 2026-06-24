//! iskariel-stt bridge — the src-tauri side of the studio-tier STT engine
//! (Speech-to-Text SF1).
//!
//! The engine itself is a **separate, optional binary** (`iskariel-stt`, built
//! only in the studio tier). This crate is deliberately decoupled from it: there
//! is NO `use iskariel_stt::…`, no engine-crate dependency, and no `studio` cargo
//! feature on src-tauri. The ONLY coupling is
//!
//!   1. the runtime-resolved binary **path** ([`carriage::resolve_engine_binary`]), and
//!   2. the NDJSON control **protocol** — serde structs duplicated byte-for-byte
//!      in [`client`] (the engine's canonical copy lives in
//!      `iskariel-stt/src/daemon/protocol.rs`; a cross-crate round-trip test in
//!      `tests/stt_roundtrip.rs` gates the two against drift).
//!
//! Faithful clone of `capture::mod`. STT-specific deltas: the spawn-time output
//! env var ([`STT_OUTPUT_DIR_ENV`]) and the log filename (`iskariel-stt.log`);
//! the capture `CONFIG_FILE` / `read_persisted_config` config-push machinery is
//! dropped (the SF1 `iskariel-stt` daemon has no persisted config).
//!
//! Module map:
//! - [`carriage`] — runtime presence-check that resolves the engine binary.
//! - [`client`]   — the sole owner of the Unix control socket; an async NDJSON
//!   request/response + event client.
//! - [`supervisor`] — the engine lifecycle owner: adopt-first / spawn-second,
//!   respawn-with-backoff, crash-loop terminal, and the `RunEvent::Exit` reap.
//!   It drives the spawn primitive below.

pub mod carriage;
pub mod client;
pub mod supervisor;

use std::path::PathBuf;
use std::process::Stdio;

use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;

/// The env-var name carrying the STT output/work root: `library_vault_root() +
/// "/STT"`. The engine writes transcription artifacts here.
const STT_OUTPUT_DIR_ENV: &str = "ISKARIEL_STT_DIR";

/// Spawn the STT engine daemon (driven by [`supervisor`]) — a bare,
/// kill-on-drop child. Argv is `[bin, "daemon"]` (the iskariel-capture
/// convention; iskariel-stt's CLI mirrors it). Returns the child PID (for the
/// reap) plus a join-handle that resolves to the child's exit code once it exits
/// (drives the supervisor's respawn decision). The child itself stays **owned by
/// the wait-task** so `kill_on_drop(true)` keeps holding — the supervisor never
/// owns the `Child`, only its PID + exit signal.
///
/// Environment:
/// - `ISKARIEL_STT_DIR` = `library_vault_root()/STT` (created up-front).
/// - `RUST_LOG` is passed through from the app's own env when set.
///
/// stdout + stderr are drained line-by-line to `~/.local/state/iskariel/
/// iskariel-stt.log` (parent created).
///
/// MUST be called from inside the Tokio reactor (it is — the supervise loop runs
/// on `tauri::async_runtime::spawn`): spawning a `tokio::process::Child` off the
/// reactor panics with "there is no reactor running".
pub fn spawn_engine_child(bin: &PathBuf) -> std::io::Result<(u32, JoinHandle<Option<i32>>)> {
    // Output root: library_vault_root()/STT, created before spawn so the engine
    // never has to mkdir it. NOTE `root:'library'` rel-paths carry no `Library/`
    // prefix — this is the canonicalized library vault root.
    let output_dir =
        PathBuf::from(crate::commands::vault::library_vault_root()).join("STT");
    if let Err(e) = std::fs::create_dir_all(&output_dir) {
        log::warn!("stt: failed to create output dir {}: {e}", output_dir.display());
        // Continue: the engine resolves/creates its own subdirs; a missing root
        // is the engine's error to surface, not a spawn blocker.
    }

    // Log file: ~/.local/state/iskariel/iskariel-stt.log (parent created).
    let log_path = engine_log_path();
    if let Some(parent) = log_path.as_ref().and_then(|p| p.parent()) {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("stt: failed to create log dir {}: {e}", parent.display());
        }
    }

    let mut cmd = TokioCommand::new(bin);
    cmd.arg("daemon")
        .env(STT_OUTPUT_DIR_ENV, &output_dir)
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
        "stt: spawned engine {} daemon pid {pid} (output dir {})",
        bin.display(),
        output_dir.display()
    );

    // Open the log file once for the appending drain (best-effort; if it can't be
    // opened, fall back to forwarding child output to the app log).
    let log_file = log_path
        .and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok());
    let log_file = std::sync::Arc::new(std::sync::Mutex::new(log_file));

    // Concurrent drain tasks: one per pipe.
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
                log::info!("stt: engine pid {pid} exited ({status})");
                status.code()
            }
            Err(e) => {
                log::warn!("stt: engine wait failed: {e}");
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
            // Log-file unavailable — forward to the app log so output isn't lost.
            log::info!("stt[{tag}]: {line}");
        }
    }
}

/// The sidecar's stdout/stderr log sink. Windows:
/// `%LOCALAPPDATA%\iskariel\logs\iskariel-stt.log`; Linux:
/// `~/.local/state/iskariel/iskariel-stt.log`. `None` if the base env var is unset.
#[cfg(windows)]
fn engine_log_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("iskariel").join("logs").join("iskariel-stt.log"))
}

#[cfg(not(windows))]
fn engine_log_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home).join(".local/state/iskariel/iskariel-stt.log")
    })
}


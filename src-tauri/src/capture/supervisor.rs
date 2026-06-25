//! 5-SF2c/5-SF2d — the capture engine supervisor.
//!
//! Owns the optional `iskariel-capture` engine's whole lifecycle for the app's
//! lifetime: **adopt-first / spawn-second**, bounded-backoff respawn on
//! unexpected exit, a crash-loop terminal state, and a `RunEvent::Exit` reap.
//! It feeds the `capture-engine-status` Tauri event and holds the single
//! [`CaptureClient`] every Tauri command talks through.
//!
//! ## Adopt-first (Risk #6 / qbit precedent)
//! An app relaunch (HMR, restart, crash-recovery) must never spawn a second
//! daemon. Before spawning, the supervisor **socket-probes** the live control
//! socket: it connects a throwaway [`CaptureClient`] and asks `get_state`. A
//! live reply ⇒ adopt the running engine (no spawn, no child handle to reap —
//! the daemon is single-instance bind-or-probe and exits 0 if we'd double-bind
//! it anyway). The probe failing ⇒ resolve the binary and spawn `[bin, "daemon"]`.
//!
//! ## Respawn + crash-loop terminal
//! A spawned engine that exits unexpectedly is respawned after a fixed-step
//! capped backoff (the `client` reconnect idiom — never a tight loop). Repeated
//! *immediate* exits (a child that dies inside [`CRASH_WINDOW`]) increment a
//! crash counter; once it reaches [`CRASH_LOOP_LIMIT`] the supervisor enters a
//! terminal `failed` state and stops respawning (gate `(2c)`: immediate-exit →
//! terminal `failed` after 5/30s). A long-lived run that then dies resets the
//! crash counter, so a one-off later crash still respawns.
//!
//! ## Generation counter
//! Each spawn captures a monotonic `generation` (`AtomicU64`). The wait-task
//! only acts on the exit if its captured generation still equals the live one,
//! so a newer spawn / an adoption / a shutdown silently invalidates an older
//! wait-task's respawn decision — the stale-write guard from
//! `parsers::video_transcode::spawn_supervisor`, hoisted to a singleton.
//!
//! ## Reap (`RunEvent::Exit`)
//! [`shutdown`] terminates the spawned child (if any): on Unix it SIGTERMs, waits
//! briefly, SIGKILLs a survivor, then unlinks the control socket; on Windows it
//! is a single `proc_util::terminate_pid` (taskkill /T /F) and the named pipe is
//! reclaimed by the kernel (no unlink). Adopted engines are NOT killed (we don't
//! own them) — on Unix only the socket cleanup runs.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::client::CaptureClient;

/// Fixed-step respawn backoff bounds (capped — the `client` reconnect idiom,
/// NOT exponential-unbounded, NOT a tight loop).
const RESPAWN_MIN: Duration = Duration::from_millis(500);
const RESPAWN_MAX: Duration = Duration::from_secs(5);
/// An exit within this window of spawn counts as an "immediate" / crash-loop
/// death; a child that ran longer than this resets the crash counter.
const CRASH_WINDOW: Duration = Duration::from_secs(5);
/// Consecutive immediate exits before the supervisor gives up (terminal
/// `failed`). 5 × ≤5 s windows ⇒ well inside the gate's 30 s ceiling.
const CRASH_LOOP_LIMIT: u32 = 5;
/// Reap: how long to wait for a SIGTERM'd child before escalating to SIGKILL.
/// Unix-only — the Windows reap is a single forceful taskkill with no grace poll.
#[cfg(unix)]
const REAP_GRACE: Duration = Duration::from_millis(1500);
/// Reap poll cadence while waiting out [`REAP_GRACE`].
#[cfg(unix)]
const REAP_POLL: Duration = Duration::from_millis(50);

/// Send SIGTERM to a PID (Unix reap escalation). Windows reaps via
/// `proc_util::terminate_pid` (taskkill /T /F) instead — see [`shutdown`].
#[cfg(unix)]
fn signal_term(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

/// Send SIGKILL to a PID (Unix reap escalation) — guarantees no engine survives quit.
#[cfg(unix)]
fn signal_kill(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

/// The `capture-engine-status` Tauri-event payload. **camelCase on the wire**
/// (`restartCount`/`lastExitCode`) per the plan's bridge contract — the
/// frontend listens for exactly these keys.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// `adopting | adopted | spawning | up | down | failed`.
    pub state: String,
    /// Total respawns since app start (an adoption is not a respawn).
    pub restart_count: u32,
    /// The most recent observed exit code (`None` = never exited / signalled).
    pub last_exit_code: Option<i32>,
    /// Human-readable one-liner for the status pill / logs.
    pub message: String,
}

/// Live supervisor state behind the singleton mutex.
struct Inner {
    /// PID of the child we spawned (and therefore must reap). `None` when
    /// adopted (not ours to kill) or down.
    spawned_pid: Option<u32>,
    /// Monotonic spawn generation — the stale-write guard key.
    generation: u64,
    /// Consecutive immediate exits (reset by any sufficiently-long run).
    crash_count: u32,
    /// Latched terminal state — once `true`, no further respawns.
    terminal: bool,
    /// Last status we emitted (so a duplicate emit is cheap to suppress).
    last_state: String,
    restart_count: u32,
    last_exit_code: Option<i32>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            spawned_pid: None,
            generation: 0,
            crash_count: 0,
            terminal: false,
            last_state: String::new(),
            restart_count: 0,
            last_exit_code: None,
        }
    }
}

/// The capture engine supervisor. A process-lifetime singleton (mirrors
/// `video_transcode`'s registry) so the `RunEvent::Exit` reap reaches it with
/// no `AppHandle` plumbing. Holds the one [`CaptureClient`] all commands use.
pub struct Supervisor {
    inner: Mutex<Inner>,
    /// Spawn-generation allocator (read by wait-tasks for the stale guard).
    gen: AtomicU64,
    /// The shared socket client (cheap clone; reconnect-surviving).
    client: CaptureClient,
    /// Absolute path to the persisted `iskariel-capture.json`, resolved from the
    /// real `AppHandle` at [`start`] (same file the `set_capture_config` command
    /// writes) — read for the best-effort `set_config` push.
    config_path: Option<PathBuf>,
}

fn cell() -> &'static OnceLock<Supervisor> {
    static CELL: OnceLock<Supervisor> = OnceLock::new();
    &CELL
}

/// The process-lifetime supervisor singleton. Initialised by [`start`] in
/// `setup`; [`get`] returns it for the command surface + the reap.
pub fn get() -> Option<&'static Supervisor> {
    cell().get()
}

/// The shared [`CaptureClient`], if the supervisor has been started. Every
/// Tauri command routes through this — one client for the whole app.
pub fn client() -> Option<CaptureClient> {
    cell().get().map(|s| s.client.clone())
}

/// Start the supervisor (5-SF2b/c). Idempotent: a second call is a no-op (the
/// `OnceLock` is already filled). Spawns the long-lived supervise loop on the
/// Tauri async runtime; returns immediately so `setup` never blocks on a probe
/// or a backoff. `app` carries the `capture-engine-status` emits.
pub fn start(app: AppHandle) {
    // Resolve the persisted-config path once, from the real AppHandle (no
    // hardcoded app-id), so the detached push reader and the command writer
    // agree byte-for-byte. Absent ⇒ the push self-disables (file = the only
    // persistence-of-record either way).
    let config_path = crate::commands::sidebar::app_config_root(&app)
        .ok()
        .map(|root| root.join(super::CONFIG_FILE));

    // First call wins; a relaunch within the same process is a no-op.
    let _ = cell().get_or_init(|| Supervisor {
        inner: Mutex::new(Inner::default()),
        gen: AtomicU64::new(0),
        client: CaptureClient::connect(),
        config_path,
    });
    let sup = cell().get().expect("supervisor just initialised");
    tauri::async_runtime::spawn(supervise(sup, app));
}

/// Restart the spawned engine child so the next spawn rebinds
/// `ISKARIEL_CAPTURES_DIR` (= `captures_dir()`) — the repoint path for a
/// recordings-folder change (WI-2). Kills the child (Unix SIGTERM / Windows
/// taskkill /T /F, mirroring [`shutdown`]); the live wait-task observes the exit
/// and respawns (a >5 s run resets the crash streak, so a settings change never
/// trips the crash-loop guard). An adopted/down engine (no `spawned_pid`) ⇒ the
/// change applies on the next app start.
pub fn restart() {
    let Some(sup) = get() else { return };
    let pid = lock(&sup.inner).spawned_pid;
    let Some(pid) = pid else {
        log::info!(
            "capture supervisor: no spawned child to restart (adopted/down) — captures-dir change applies on next start"
        );
        return;
    };
    log::info!("capture supervisor: restarting engine pid {pid} to repoint the captures dir");
    #[cfg(unix)]
    signal_term(pid);
    #[cfg(not(unix))]
    crate::commands::proc_util::terminate_pid(pid);
}

impl Supervisor {
    /// Snapshot the current status for an `EngineStatus` emit / a command read.
    fn status(&self, state: &str, message: impl Into<String>) -> EngineStatus {
        let g = lock(&self.inner);
        EngineStatus {
            state: state.to_string(),
            restart_count: g.restart_count,
            last_exit_code: g.last_exit_code,
            message: message.into(),
        }
    }
}

/// Lock the inner state, recovering a poisoned mutex (matches the house
/// `lock().unwrap_or_else(PoisonError::into_inner)` idiom).
fn lock(m: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Emit a `capture-engine-status` event (best-effort; a failed emit is logged,
/// never fatal — mirrors `watcher.rs`). Updates `last_state` under the lock.
fn emit_status(sup: &Supervisor, app: &AppHandle, state: &str, message: impl Into<String>) {
    let status = sup.status(state, message);
    {
        let mut g = lock(&sup.inner);
        g.last_state = state.to_string();
    }
    if let Err(e) = app.emit("capture-engine-status", &status) {
        log::warn!("emit capture-engine-status failed: {e}");
    }
}

/// Probe the live control socket: a throwaway client + a bounded `get_state`.
/// `true` ⇒ a daemon is already serving ⇒ adopt it. The `client`'s own connect
/// backoff means a single `get_state` is enough — it either answers fast or the
/// socket isn't there.
async fn socket_alive() -> bool {
    let probe = CaptureClient::connect();
    // The client reconnects on its own; give one connect + request attempt a
    // short bound. A live daemon answers in well under this.
    match tokio::time::timeout(Duration::from_millis(750), probe.get_state()).await {
        Ok(Ok(_)) => true,
        // `Disconnected`/`Timeout`/engine-error all ⇒ not (cleanly) serving.
        _ => false,
    }
}

/// The long-lived supervise loop: adopt-or-spawn, then respawn-on-exit with
/// crash-loop backoff until either the engine settles `up`/`adopted` or the
/// supervisor latches `failed`.
async fn supervise(sup: &'static Supervisor, app: AppHandle) {
    let mut backoff = RESPAWN_MIN;

    loop {
        // Adopt-first: never spawn a duplicate if the socket already answers.
        if socket_alive().await {
            {
                let mut g = lock(&sup.inner);
                g.spawned_pid = None; // not ours to reap
                g.crash_count = 0;
            }
            log::info!("capture supervisor: adopted live engine (socket answered get_state)");
            emit_status(sup, &app, "adopted", "Adopted the running capture engine");
            push_config(sup);
            return; // adopted engines self-supervise; nothing to wait on
        }

        // No live socket — resolve the binary and spawn. A missing binary is the
        // stable tier: log once and stay inert (no respawn churn).
        let Some(bin) = super::carriage::resolve_engine_binary(&app) else {
            log::info!("capture: engine binary not found, disabling");
            emit_status(sup, &app, "down", "Capture engine not installed");
            return;
        };

        let generation = sup.gen.fetch_add(1, Ordering::SeqCst) + 1;
        emit_status(sup, &app, "spawning", "Starting the capture engine");
        let spawned_at = Instant::now();

        match super::spawn_engine_child(&bin) {
            Ok((pid, wait)) => {
                {
                    let mut g = lock(&sup.inner);
                    g.spawned_pid = Some(pid);
                    g.generation = generation;
                }
                log::info!("capture supervisor: spawned engine pid {pid} (gen {generation})");
                // The bare child + its log drains live in `spawn_engine_child`;
                // the returned `wait` join-handle resolves to the exit code once
                // the child exits (the child stays owned by that task, preserving
                // `kill_on_drop`). Push config to the freshly-bound socket, mark
                // `up`, then block on the child's exit.
                emit_status(sup, &app, "up", "Capture engine running");
                push_config(sup);

                let exit_code = wait.await.ok().flatten();
                let ran_for = spawned_at.elapsed();

                // Stale-write guard: a newer spawn / adoption / shutdown bumped
                // the generation out from under us ⇒ this wait-task is stale.
                {
                    let g = lock(&sup.inner);
                    if g.generation != generation || g.terminal {
                        log::debug!(
                            "capture supervisor: stale exit (gen {generation} ≠ live {}); not respawning",
                            g.generation
                        );
                        return;
                    }
                }

                // Record the exit + decide crash-loop vs respawn.
                let give_up = {
                    let mut g = lock(&sup.inner);
                    g.spawned_pid = None;
                    g.last_exit_code = exit_code;
                    if ran_for < CRASH_WINDOW {
                        g.crash_count += 1;
                    } else {
                        g.crash_count = 0; // a healthy run resets the streak
                    }
                    if g.crash_count >= CRASH_LOOP_LIMIT {
                        g.terminal = true;
                        true
                    } else {
                        g.restart_count += 1;
                        false
                    }
                };

                if give_up {
                    log::error!(
                        "capture supervisor: engine crash-looped ({CRASH_LOOP_LIMIT} immediate exits) — giving up"
                    );
                    emit_status(
                        sup,
                        &app,
                        "failed",
                        format!("Capture engine crash-looped (last exit {exit_code:?})"),
                    );
                    return;
                }

                log::warn!(
                    "capture supervisor: engine exited ({exit_code:?}) after {:?} — respawning in {:?}",
                    ran_for, backoff
                );
                emit_status(
                    sup,
                    &app,
                    "down",
                    format!("Capture engine exited ({exit_code:?}); restarting"),
                );
                tokio::time::sleep(backoff).await;
                // A healthy run reset crash_count above ⇒ also reset backoff.
                if ran_for >= CRASH_WINDOW {
                    backoff = RESPAWN_MIN;
                } else {
                    backoff = (backoff * 2).min(RESPAWN_MAX);
                }
            }
            Err(e) => {
                // Spawn itself failed (exec error). Treat as an immediate crash.
                let give_up = {
                    let mut g = lock(&sup.inner);
                    g.crash_count += 1;
                    g.crash_count >= CRASH_LOOP_LIMIT
                };
                log::error!("capture supervisor: spawn failed: {e}");
                if give_up {
                    {
                        let mut g = lock(&sup.inner);
                        g.terminal = true;
                    }
                    emit_status(sup, &app, "failed", format!("Capture engine failed to start: {e}"));
                    return;
                }
                emit_status(sup, &app, "down", "Capture engine failed to start; retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(RESPAWN_MAX);
            }
        }
    }
}

/// Best-effort `set_config` push after (re)connect (config-push contract: the
/// file is persistence-of-record, the push is best-effort). Reads the persisted
/// `iskariel-capture.json` and forwards it on the socket; absent / unreadable ⇒
/// skip silently (the engine keeps its own defaults). Detached so a slow socket
/// can't stall the supervise loop.
fn push_config(sup: &Supervisor) {
    let client = sup.client.clone();
    let Some(path) = sup.config_path.clone() else {
        return; // no resolvable config path ⇒ nothing to push
    };
    tauri::async_runtime::spawn(async move {
        let Some(cfg) = super::read_persisted_config(&path) else {
            return;
        };
        match client.request("set_config", cfg).await {
            Ok(_) => log::debug!("capture supervisor: pushed persisted config"),
            Err(e) => log::debug!("capture supervisor: set_config push skipped ({e})"),
        }
    });
}

/// Reap (5-SF2d / gate `(2d)`): SIGTERM the spawned child, wait out
/// [`REAP_GRACE`], SIGKILL a survivor, then unlink the control socket. Called
/// synchronously from the `RunEvent::Exit` arm (mirrors
/// `video_transcode::shutdown_active`). No-op + socket-cleanup-only when the
/// engine was adopted (not ours to kill) or already down.
pub fn shutdown() {
    let Some(sup) = cell().get() else { return };

    let pid = {
        let mut g = lock(&sup.inner);
        g.terminal = true; // stop any in-flight wait-task from respawning
        g.generation = g.generation.wrapping_add(1); // invalidate stale guards
        g.spawned_pid.take()
    };
    // Also bump the shared allocator so a concurrent spawn's captured gen is stale.
    sup.gen.fetch_add(1, Ordering::SeqCst);

    if let Some(pid) = pid {
        #[cfg(unix)]
        {
            signal_term(pid);
            // Wait out the grace window, then SIGKILL a survivor. We're on the
            // (sync) RunEvent::Exit thread, so this is a blocking poll — bounded by
            // REAP_GRACE so app teardown can't hang.
            let deadline = Instant::now() + REAP_GRACE;
            while Instant::now() < deadline && pid_alive(pid) {
                std::thread::sleep(REAP_POLL);
            }
            if pid_alive(pid) {
                log::warn!("capture supervisor: engine pid {pid} survived SIGTERM — SIGKILL");
                signal_kill(pid);
            } else {
                log::info!("capture supervisor: engine pid {pid} reaped on SIGTERM");
            }
        }
        #[cfg(not(unix))]
        {
            // Windows has no SIGTERM→SIGKILL escalation: taskkill /T /F is an
            // immediate, forceful TREE kill (reaps any grandchildren too). One shot.
            log::info!("capture supervisor: terminating engine pid {pid} (taskkill /T /F)");
            crate::commands::proc_util::terminate_pid(pid);
        }
    }

    // Unlink the control socket so a stale path can't confuse the next launch (the
    // daemon also unlinks on clean exit; this covers a SIGKILL'd child). Unix-only:
    // `socket_path()` is `#[cfg(unix)]`, and a Windows named pipe is a kernel object
    // reclaimed on the daemon's exit — there is no filesystem path to unlink.
    #[cfg(unix)]
    {
        let sock = super::client::socket_path();
        if sock.exists() {
            if let Err(e) = std::fs::remove_file(&sock) {
                log::debug!("capture supervisor: socket unlink {} failed: {e}", sock.display());
            }
        }
    }
}

/// Is `pid` still a live process? `kill(pid, 0)` returns 0 while it exists, `ESRCH`
/// once gone. Unix-only: the Windows reap is a single `terminate_pid` with no
/// liveness poll, so there is no Windows caller.
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
}

//! STT SF1 — the mortar-pestle-stt engine supervisor.
//!
//! Owns the optional `mortar-pestle-stt` engine's whole lifecycle for the app's
//! lifetime: **adopt-first / spawn-second**, bounded-backoff respawn on
//! unexpected exit, a crash-loop terminal state, and a `RunEvent::Exit` reap.
//! It feeds the `stt-engine-status` Tauri event and holds the single
//! [`SttClient`] every Tauri command talks through.
//!
//! Faithful clone of `capture::supervisor`. The adopt/spawn loop, backoff,
//! crash-loop terminal latch, generation stale-write guard, signal helpers, and
//! reap are copied verbatim. STT-specific deltas: the event name
//! (`stt-engine-status`), the client type ([`SttClient`]), and — since the SF1
//! `mortar-pestle-stt` daemon has no persisted config — the capture `config_path` /
//! `push_config` machinery is dropped.
//!
//! ## Adopt-first (single-instance)
//! An app relaunch (HMR, restart, crash-recovery) must never spawn a second
//! daemon. Before spawning, the supervisor **socket-probes** the live control
//! socket: it connects a throwaway [`SttClient`] and asks `get_state`. A live
//! reply ⇒ adopt the running engine (no spawn, no child handle to reap — the
//! daemon is single-instance bind-or-probe and exits 0 if we'd double-bind it
//! anyway). The probe failing ⇒ resolve the binary and spawn `[bin, "daemon"]`.
//!
//! ## Respawn + crash-loop terminal
//! A spawned engine that exits unexpectedly is respawned after a fixed-step
//! capped backoff (never a tight loop). Repeated *immediate* exits (a child that
//! dies inside [`CRASH_WINDOW`]) increment a crash counter; once it reaches
//! [`CRASH_LOOP_LIMIT`] the supervisor enters a terminal `failed` state and
//! stops respawning. A long-lived run that then dies resets the crash counter,
//! so a one-off later crash still respawns.
//!
//! ## Generation counter
//! Each spawn captures a monotonic `generation` (`AtomicU64`). The wait-task only
//! acts on the exit if its captured generation still equals the live one, so a
//! newer spawn / an adoption / a shutdown silently invalidates an older
//! wait-task's respawn decision.
//!
//! ## Reap (`RunEvent::Exit`)
//! [`shutdown`] kills the spawned child (if any) — Unix SIGTERM→grace→SIGKILL, or a
//! single Windows `proc_util::terminate_pid` (taskkill /T /F) — then (Unix only)
//! unlinks the control socket. Adopted engines are NOT killed (we don't own them).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::client::SttClient;

/// Fixed-step respawn backoff bounds (capped — NOT exponential-unbounded, NOT a
/// tight loop).
const RESPAWN_MIN: Duration = Duration::from_millis(500);
const RESPAWN_MAX: Duration = Duration::from_secs(5);
/// An exit within this window of spawn counts as an "immediate" / crash-loop
/// death; a child that ran longer than this resets the crash counter.
const CRASH_WINDOW: Duration = Duration::from_secs(5);
/// Consecutive immediate exits before the supervisor gives up (terminal
/// `failed`).
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

/// The `stt-engine-status` Tauri-event payload. **camelCase on the wire**
/// (`restartCount`/`lastExitCode`) — the frontend listens for exactly these keys.
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
    /// PID of the child we spawned (and therefore must reap). `None` when adopted
    /// (not ours to kill) or down.
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

/// The STT engine supervisor. A process-lifetime singleton so the
/// `RunEvent::Exit` reap reaches it with no `AppHandle` plumbing. Holds the one
/// [`SttClient`] all commands use.
pub struct Supervisor {
    inner: Mutex<Inner>,
    /// Spawn-generation allocator (read by wait-tasks for the stale guard).
    gen: AtomicU64,
    /// The shared socket client (cheap clone; reconnect-surviving).
    client: SttClient,
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

/// The shared [`SttClient`], if the supervisor has been started. Every Tauri
/// command routes through this — one client for the whole app.
pub fn client() -> Option<SttClient> {
    cell().get().map(|s| s.client.clone())
}

/// Start the supervisor. Idempotent: a second call is a no-op (the `OnceLock` is
/// already filled). Spawns the long-lived supervise loop on the Tauri async
/// runtime; returns immediately so `setup` never blocks on a probe or a backoff.
/// `app` carries the `stt-engine-status` emits.
pub fn start(app: AppHandle) {
    // First call wins; a relaunch within the same process is a no-op.
    let _ = cell().get_or_init(|| Supervisor {
        inner: Mutex::new(Inner::default()),
        gen: AtomicU64::new(0),
        client: SttClient::connect(),
    });
    let sup = cell().get().expect("supervisor just initialised");
    tauri::async_runtime::spawn(supervise(sup, app));
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

/// Lock the inner state, recovering a poisoned mutex.
fn lock(m: &Mutex<Inner>) -> std::sync::MutexGuard<'_, Inner> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Emit an `stt-engine-status` event (best-effort; a failed emit is logged,
/// never fatal). Updates `last_state` under the lock.
fn emit_status(sup: &Supervisor, app: &AppHandle, state: &str, message: impl Into<String>) {
    let status = sup.status(state, message);
    {
        let mut g = lock(&sup.inner);
        g.last_state = state.to_string();
    }
    if let Err(e) = app.emit("stt-engine-status", &status) {
        log::warn!("emit stt-engine-status failed: {e}");
    }
}

/// Probe the live control socket: a throwaway client + a bounded `get_state`.
/// `true` ⇒ a daemon is already serving ⇒ adopt it.
async fn socket_alive() -> bool {
    let probe = SttClient::connect();
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
            log::info!("stt supervisor: adopted live engine (socket answered get_state)");
            emit_status(sup, &app, "adopted", "Adopted the running STT engine");
            return; // adopted engines self-supervise; nothing to wait on
        }

        // No live socket — resolve the binary and spawn. A missing binary is the
        // stable tier: log once and stay inert (no respawn churn).
        let Some(bin) = super::carriage::resolve_engine_binary(&app) else {
            log::info!("stt: engine binary not found, disabling");
            emit_status(sup, &app, "down", "STT engine not installed");
            return;
        };

        let generation = sup.gen.fetch_add(1, Ordering::SeqCst) + 1;
        emit_status(sup, &app, "spawning", "Starting the STT engine");
        let spawned_at = Instant::now();

        match super::spawn_engine_child(&bin) {
            Ok((pid, wait)) => {
                {
                    let mut g = lock(&sup.inner);
                    g.spawned_pid = Some(pid);
                    g.generation = generation;
                }
                log::info!("stt supervisor: spawned engine pid {pid} (gen {generation})");
                emit_status(sup, &app, "up", "STT engine running");

                let exit_code = wait.await.ok().flatten();
                let ran_for = spawned_at.elapsed();

                // Stale-write guard: a newer spawn / adoption / shutdown bumped
                // the generation out from under us ⇒ this wait-task is stale.
                {
                    let g = lock(&sup.inner);
                    if g.generation != generation || g.terminal {
                        log::debug!(
                            "stt supervisor: stale exit (gen {generation} ≠ live {}); not respawning",
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
                        "stt supervisor: engine crash-looped ({CRASH_LOOP_LIMIT} immediate exits) — giving up"
                    );
                    emit_status(
                        sup,
                        &app,
                        "failed",
                        format!("STT engine crash-looped (last exit {exit_code:?})"),
                    );
                    return;
                }

                log::warn!(
                    "stt supervisor: engine exited ({exit_code:?}) after {:?} — respawning in {:?}",
                    ran_for, backoff
                );
                emit_status(
                    sup,
                    &app,
                    "down",
                    format!("STT engine exited ({exit_code:?}); restarting"),
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
                log::error!("stt supervisor: spawn failed: {e}");
                if give_up {
                    {
                        let mut g = lock(&sup.inner);
                        g.terminal = true;
                    }
                    emit_status(sup, &app, "failed", format!("STT engine failed to start: {e}"));
                    return;
                }
                emit_status(sup, &app, "down", "STT engine failed to start; retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(RESPAWN_MAX);
            }
        }
    }
}

/// Reap (gate `(2d)`): SIGTERM the spawned child, wait out [`REAP_GRACE`],
/// SIGKILL a survivor, then unlink the control socket. Called synchronously from
/// the `RunEvent::Exit` arm. No-op + socket-cleanup-only when the engine was
/// adopted (not ours to kill) or already down.
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
                log::warn!("stt supervisor: engine pid {pid} survived SIGTERM — SIGKILL");
                signal_kill(pid);
            } else {
                log::info!("stt supervisor: engine pid {pid} reaped on SIGTERM");
            }
        }
        #[cfg(not(unix))]
        {
            // Windows has no SIGTERM→SIGKILL escalation: taskkill /T /F is an
            // immediate, forceful TREE kill (reaps any grandchildren too). One shot.
            log::info!("stt supervisor: terminating engine pid {pid} (taskkill /T /F)");
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
                log::debug!("stt supervisor: socket unlink {} failed: {e}", sock.display());
            }
        }
    }
}

/// Is `pid` still a live process? `kill(pid, 0)` returns 0 while it exists, `ESRCH`
/// once gone. Unix-only: the Windows reap is a single `terminate_pid` with no liveness
/// poll, so there is no Windows caller.
#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}


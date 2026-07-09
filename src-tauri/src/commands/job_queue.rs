//! Shared background-job-queue primitives for the download/import engines
//! (music_download, anime_download, library_import). Non-command helper module —
//! exports NO #[tauri::command], so it needs no lib.rs / build.rs / capabilities
//! registration.
//!
//! Three engines independently re-implemented the same bookkeeping: a
//! process-global `Mutex<{ jobs, worker_running }>`, a `_status` snapshot, a
//! find-by-id `snapshot`, a graceful process-kill sequence, and (for music +
//! library) a queued/active cancel decision. Those genuinely-shared pieces live
//! here so a fix (grace period, Windows kill bug, cancel semantics) has exactly
//! one home. The per-domain worker/process_job work is NOT shared and stays in
//! each engine.

use std::sync::Mutex;

#[cfg(unix)]
const CANCEL_GRACE_MS: u64 = 2000;

#[cfg(unix)]
fn send_signal(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

/// SIGTERM a python child, SIGKILL after a grace period (unix); `terminate_pid`
/// on Windows. The in-flight child may finish its current unit before exiting;
/// no new work starts. Lifted verbatim from the three engines' cancel paths.
pub fn kill_child_graceful(pid: u32) {
    #[cfg(unix)]
    {
        send_signal(pid, libc::SIGTERM);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(CANCEL_GRACE_MS)).await;
            send_signal(pid, libc::SIGKILL);
        });
    }
    #[cfg(not(unix))]
    crate::commands::proc_util::terminate_pid(pid);
}

/// The process-global queue shape shared by every engine: an ordered job list +
/// a single-worker-running latch.
pub struct Queue<J> {
    pub jobs: Vec<J>,
    pub worker_running: bool,
}

impl<J> Queue<J> {
    pub const fn new() -> Self {
        Queue { jobs: Vec::new(), worker_running: false }
    }
}

/// Snapshot all jobs for provider hydration (the `_status` command body).
pub fn status<J: Clone>(state: &Mutex<Queue<J>>) -> Vec<J> {
    state.lock().unwrap().jobs.clone()
}

/// Find a job by an id-returning predicate and clone it.
pub fn snapshot<J: Clone>(state: &Mutex<Queue<J>>, matches: impl Fn(&J) -> bool) -> Option<J> {
    state.lock().unwrap().jobs.iter().find(|j| matches(j)).cloned()
}

/// The cancel decision for a single job, made against its domain-specific state
/// enum by `JobItem::cancel_in_place`.
pub enum CancelAction {
    /// Job is already Done/Error/Cancelled — nothing to do.
    Terminal,
    /// Job was Queued and has just been flipped to Cancelled (no child to kill).
    Queued,
    /// Job was active; `cancel_requested` was set. Carries the child pid to kill,
    /// if one is running.
    Active(Option<u32>),
}

/// A queue job that knows how to cancel itself. Implemented per engine because
/// each has a different state enum (music: Queued/Downloading/…, library:
/// Queued/Parsing/Importing/…).
pub trait JobItem {
    fn id(&self) -> &str;
    /// Inspect the current state and mutate a queued job into Cancelled; report
    /// what the caller must do next.
    fn cancel_in_place(&mut self) -> CancelAction;
}

/// Shared cancel body for engines whose cancel is a plain state transition
/// (music, library). Finds the job, applies its `cancel_in_place`, runs
/// `after_queued_cancel` under the still-held lock when a queued job was
/// cancelled (music renumbers queue positions here; library passes a no-op),
/// and returns the active child pid to kill (if any) once the lock is released.
///
/// NOT used by anime: `anime_uninstall` cancels jobs while already holding the
/// queue lock, so anime keeps its own lock-held `cancel_job_inner`.
pub fn cancel<J: JobItem>(
    state: &Mutex<Queue<J>>,
    job_id: &str,
    after_queued_cancel: impl FnOnce(&mut Queue<J>),
) -> Result<Option<u32>, String> {
    let mut g = state.lock().unwrap();
    let action = {
        let Some(job) = g.jobs.iter_mut().find(|j| j.id() == job_id) else {
            return Err("no such job".into());
        };
        job.cancel_in_place()
    };
    match action {
        CancelAction::Terminal => Err("job is not cancellable".into()),
        CancelAction::Queued => {
            after_queued_cancel(&mut g);
            Ok(None)
        }
        CancelAction::Active(pid) => Ok(pid),
    }
}

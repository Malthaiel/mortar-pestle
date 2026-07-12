//! Win32 Job Object die-with-app safety net.
//!
//! Assigns the host process to a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` job. When
//! the host dies — clean main-window close (handled by the `CloseRequested`→
//! `exit(0)` path in `lib.rs`, which fires `RunEvent::Exit` and runs the
//! `supervisor::shutdown()`s), crash, or Task-Manager kill — the OS kernel
//! reaps every process in the job. The 3 sidecar daemons (capture / stt /
//! broadcast) are spawned by the host via `tokio::process::Command` with no
//! `CREATE_BREAKAWAY_FROM_JOB` flag, so they inherit job membership and die
//! with the host. This is the belt behind the explicit `shutdown()` path:
//! it catches the cases shutdown() can't reach (host crash / End Task).
//!
//! The job HANDLE lives in a process-lifetime `OnceLock`; it is never
//! explicitly closed on the success path — Windows closes all process
//! handles on process death, which IS the KILL_ON_JOB_CLOSE trigger.
//! Nested jobs are safe on Windows 8+ (the project targets Win10+); a
//! failure to assign (already in an incompatible job, e.g. an AV/EDR
//! injected one) is non-fatal — the explicit shutdown path + daemon
//! `kill_on_drop` still cover the clean-close case, and a `log::warn!`
//! surfaces the degraded die-on-End-Task guarantee.

use std::sync::OnceLock;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    JOBOBJECT_BASIC_LIMIT_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, SetInformationJobObject,
};
use windows::Win32::System::Threading::GetCurrentProcess;

/// `HANDLE` wraps a raw pointer — `Copy` but NOT `Send`/`Sync` by default, so a
/// bare `static OnceLock<HANDLE>` fails the `Sync` bound (E0277). A kernel job
/// HANDLE is safe to hold across threads (the OS synchronizes kernel objects),
/// so the wrapper asserts `Send`+`Sync` to keep it in a process-lifetime cell.
#[allow(dead_code)] // the handle is held for its side-effect (OS reaps the job on process death), never read
struct JobHandle(HANDLE);
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

static JOB: OnceLock<JobHandle> = OnceLock::new();

/// Assign the current process to a `KILL_ON_JOB_CLOSE` job. Idempotent; call
/// once at setup start, before the first sidecar spawns. Best-effort — a
/// failure logs and leaves die-with-app to the explicit shutdown path + the
/// daemons' `kill_on_drop`. A null HANDLE is latched on failure so the
/// `OnceLock` stays filled (no retry, no panic).
pub fn init() {
    let _ = JOB.get_or_init(|| unsafe {
        let job = match CreateJobObjectW(None, PCWSTR::null()) {
            Ok(h) => h,
            Err(e) => {
                log::warn!("winjob: CreateJobObjectW failed: {e}");
                return JobHandle(HANDLE(std::ptr::null_mut()));
            }
        };
        let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };
        if let Err(e) = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) {
            log::warn!("winjob: SetInformationJobObject failed: {e}");
            let _ = CloseHandle(job);
            return JobHandle(HANDLE(std::ptr::null_mut()));
        }
        if let Err(e) = AssignProcessToJobObject(job, GetCurrentProcess()) {
            // Win8+ allows nesting; a failure here is usually "already in an
            // incompatible job" (AV/EDR) — non-fatal (explicit shutdown still
            // covers clean close; crash/End Task is the residual).
            log::warn!("winjob: AssignProcessToJobObject failed: {e} (already in a job?)");
            let _ = CloseHandle(job);
            return JobHandle(HANDLE(std::ptr::null_mut()));
        }
        log::info!("winjob: host assigned to KILL_ON_JOB_CLOSE job");
        JobHandle(job)
    });
}
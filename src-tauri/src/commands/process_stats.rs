//! Per-process CPU + memory sampling for the Processes window.
//!
//! One command, `process_stats(pids)`, answering "how much of this machine is
//! each of these helper programs eating right now". It is deliberately pull-only
//! and stateless apart from one previous-sample cell: the frontend asks once a
//! second WHILE THE PROCESSES WINDOW IS OPEN and never otherwise, so an idle app
//! samples nothing.
//!
//! No new dependency — this rides the `windows` crate the app already links.
//!
//! CPU is a delta, not an instant: Windows only reports cumulative kernel+user
//! time, so a percentage needs two readings. The FIRST sample of a pid therefore
//! reports `cpu_pct: None` (honest) rather than a made-up zero; every later one
//! divides the time burned since the previous sample by the wall time that
//! passed and by the core count, so 100% means one whole machine, not one core.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;

#[cfg(windows)]
use windows::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE},
    System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
    System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcStat {
    pub pid: u32,
    /// Percent of the WHOLE machine (all cores), `None` on the first sample of
    /// a pid — there is no previous reading to subtract yet.
    pub cpu_pct: Option<f64>,
    /// Working set, bytes. `None` when the process refused the query.
    pub rss_bytes: Option<u64>,
    /// False once the pid is gone, so a row can stop asking about it.
    pub alive: bool,
}

/// pid -> (cumulative 100ns kernel+user ticks, when we read them)
type Prev = HashMap<u32, (u64, Instant)>;

fn prev_cell() -> &'static Mutex<Prev> {
    static CELL: OnceLock<Mutex<Prev>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(windows)]
fn ft_to_u64(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

#[cfg(windows)]
fn sample_one(pid: u32, prev: &mut Prev, now: Instant, cores: f64) -> ProcStat {
    use windows::Win32::System::Threading::GetProcessTimes;

    let dead = ProcStat { pid, cpu_pct: None, rss_bytes: None, alive: false };

    // PROCESS_QUERY_LIMITED_INFORMATION is the least privilege that still
    // answers both questions, and unlike PROCESS_QUERY_INFORMATION it is
    // granted for a process running at a different integrity level.
    let handle: HANDLE = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
    {
        Ok(h) if !h.is_invalid() => h,
        _ => {
            prev.remove(&pid);
            return dead;
        }
    };

    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let times_ok =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }.is_ok();

    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let mem_ok = unsafe { GetProcessMemoryInfo(handle, &mut counters, size) }.is_ok();

    unsafe { let _ = CloseHandle(handle); }

    let rss_bytes = if mem_ok { Some(counters.WorkingSetSize as u64) } else { None };

    let cpu_pct = if !times_ok {
        None
    } else {
        // Both are in 100-nanosecond units.
        let ticks = ft_to_u64(kernel) + ft_to_u64(user);
        let out = match prev.get(&pid) {
            Some((last_ticks, last_at)) => {
                let wall_ns = now.duration_since(*last_at).as_nanos() as f64;
                let burned_ns = ticks.saturating_sub(*last_ticks) as f64 * 100.0;
                if wall_ns > 0.0 {
                    Some((burned_ns / wall_ns / cores * 100.0).clamp(0.0, 100.0))
                } else {
                    None
                }
            }
            None => None,
        };
        prev.insert(pid, (ticks, now));
        out
    };

    ProcStat { pid, cpu_pct, rss_bytes, alive: true }
}

/// Sample every pid in one pass. Unknown / exited pids come back `alive: false`
/// rather than as an error — a job that just finished is the normal case.
#[tauri::command]
pub fn process_stats(pids: Vec<u32>) -> Vec<ProcStat> {
    #[cfg(windows)]
    {
        let now = Instant::now();
        let cores = std::thread::available_parallelism().map(|n| n.get() as f64).unwrap_or(1.0);
        let mut prev = prev_cell().lock().unwrap();
        // Drop bookkeeping for pids nobody asked about, so the map can't grow
        // without bound across a long session.
        prev.retain(|pid, _| pids.contains(pid));
        pids.iter().map(|&pid| sample_one(pid, &mut prev, now, cores)).collect()
    }
    #[cfg(not(windows))]
    {
        let _ = prev_cell();
        pids.into_iter()
            .map(|pid| ProcStat { pid, cpu_pct: None, rss_bytes: None, alive: false })
            .collect()
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    // The one runnable check: our OWN pid must read alive with a working set,
    // report no CPU on the first sample, and report a real one on the second.
    #[test]
    fn samples_self() {
        let me = std::process::id();
        let first = process_stats(vec![me]);
        assert_eq!(first.len(), 1);
        assert!(first[0].alive, "own process must be alive");
        assert!(first[0].rss_bytes.unwrap_or(0) > 0, "own working set must be non-zero");
        assert!(first[0].cpu_pct.is_none(), "first sample has no delta to report");

        std::thread::sleep(std::time::Duration::from_millis(50));
        let second = process_stats(vec![me]);
        let pct = second[0].cpu_pct.expect("second sample must carry a percentage");
        assert!((0.0..=100.0).contains(&pct), "cpu {pct} out of range");

        // A pid that cannot exist reads dead, never an error.
        let bogus = process_stats(vec![u32::MAX]);
        assert!(!bogus[0].alive);
    }
}

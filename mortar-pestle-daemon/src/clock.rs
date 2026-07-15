//! 3-WAY shared monotonic-ns clock. Moved verbatim-math from
//! `mortar-pestle-capture/src/daemon/socket.rs:521-587` so the capture/stt
//! snapshot `elapsed_ns` clock domain is preserved. i128 math avoids the
//! `counter * 1e9` i64 overflow at 10 MHz QPC.

/// Current `CLOCK_MONOTONIC` in ns (Linux). Falls back to 0 on clock_gettime
/// failure. Uses a local `extern "C"` binding — no `libc` dep needed.
#[cfg(unix)]
pub fn now_mono_ns() -> u64 {
    let mut ts = Timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: `ts` is a valid owned timespec; CLOCK_MONOTONIC is always valid.
    let rc = unsafe { clock_gettime(CLOCK_MONOTONIC, &mut ts) };
    if rc != 0 {
        return 0;
    }
    (ts.tv_sec as u64).saturating_mul(1_000_000_000).saturating_add(ts.tv_nsec as u64)
}

#[cfg(unix)]
const CLOCK_MONOTONIC: i32 = 1;
#[cfg(unix)]
#[repr(C)]
struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}
#[cfg(unix)]
extern "C" {
    fn clock_gettime(clk_id: i32, tp: *mut Timespec) -> i32;
}

/// Current monotonic time in ns via `QueryPerformanceCounter` (Windows). Same
/// math as the capture pacer's `now_mono_ns` so the clock domains never diverge.
#[cfg(windows)]
pub fn now_mono_ns() -> u64 {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::Performance::{
        QueryPerformanceCounter, QueryPerformanceFrequency,
    };
    static FREQ: OnceLock<i64> = OnceLock::new();
    let freq = *FREQ.get_or_init(|| {
        let mut f: i64 = 0;
        // SAFETY: `f` is a valid out-param; QPF never fails on supported hardware.
        unsafe {
            let _ = QueryPerformanceFrequency(&mut f);
        }
        if f <= 0 {
            1
        } else {
            f
        }
    });
    let mut c: i64 = 0;
    // SAFETY: `c` is a valid out-param.
    unsafe {
        let _ = QueryPerformanceCounter(&mut c);
    }
    if c <= 0 {
        0
    } else {
        ((c as i128 * 1_000_000_000) / freq as i128) as u64
    }
}
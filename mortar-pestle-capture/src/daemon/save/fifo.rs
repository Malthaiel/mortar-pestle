//! Named-pipe (FIFO) plumbing for the live mux.
//!
//! Two operations the standard library doesn't give us: create a FIFO (`mkfifo`)
//! and open its write end **without wedging the capture thread** if ffmpeg (the
//! reader) never opens the read end. The crate carries no `libc` dependency, so —
//! exactly like `socket.rs`'s `clock_gettime` — we declare the two C functions we
//! need by hand.

use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::raw::c_char;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Child;
use std::time::{Duration, Instant};

extern "C" {
    fn mkfifo(path: *const c_char, mode: u32) -> i32;
    fn fcntl(fd: i32, cmd: i32, arg: i32) -> i32;
}

// Linux x86_64 ABI constants.
const O_NONBLOCK: i32 = 0o4000; // 2048
const F_GETFL: i32 = 3;
const F_SETFL: i32 = 4;
const ENXIO: i32 = 6; // "No such device or address" — a FIFO write-open with no reader.

/// Create a FIFO at `path` (mode 0600). Errors on any failure incl. an existing
/// path (per-clip paths are unique, so a collision is a real bug, not a reuse).
pub fn make_fifo(path: &Path) -> Result<(), String> {
    let c = CString::new(path.as_os_str().as_bytes())
        .map_err(|e| format!("fifo path has interior NUL: {e}"))?;
    // SAFETY: `c` is a valid NUL-terminated C string borrowed for the call.
    let rc = unsafe { mkfifo(c.as_ptr(), 0o600) };
    if rc != 0 {
        return Err(format!("mkfifo {}: {}", path.display(), io::Error::last_os_error()));
    }
    Ok(())
}

/// Open the write end of `fifo`, retrying until ffmpeg opens the read end, bounded
/// by `timeout` and a child-liveness check so a dead/missing ffmpeg never wedges
/// the caller. Clears `O_NONBLOCK` on success so later writes BLOCK (backpressure
/// the encoder if ffmpeg ever stalls — never silently drop encoded packets).
pub fn open_writer_bounded(fifo: &Path, child: &mut Child, timeout: Duration) -> Result<File, String> {
    let deadline = Instant::now() + timeout;
    loop {
        match OpenOptions::new().write(true).custom_flags(O_NONBLOCK).open(fifo) {
            Ok(f) => {
                clear_nonblock(&f)?;
                return Ok(f);
            }
            // ENXIO: the reader hasn't opened yet. Bail if ffmpeg already died.
            Err(e) if e.raw_os_error() == Some(ENXIO) => {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!("ffmpeg exited before opening the FIFO ({status})"));
                }
                if Instant::now() >= deadline {
                    return Err("timed out waiting for ffmpeg to open the FIFO".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("open FIFO writer {}: {e}", fifo.display())),
        }
    }
}

/// Clear `O_NONBLOCK` on an open fd via `fcntl(F_GETFL)` + `fcntl(F_SETFL)`.
fn clear_nonblock(f: &File) -> Result<(), String> {
    let fd = f.as_raw_fd();
    // SAFETY: `fd` is a valid open descriptor owned by `f` for the call's duration.
    let flags = unsafe { fcntl(fd, F_GETFL, 0) };
    if flags < 0 {
        return Err(format!("fcntl F_GETFL: {}", io::Error::last_os_error()));
    }
    let rc = unsafe { fcntl(fd, F_SETFL, flags & !O_NONBLOCK) };
    if rc < 0 {
        return Err(format!("fcntl F_SETFL: {}", io::Error::last_os_error()));
    }
    Ok(())
}

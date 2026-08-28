//! Small cross-platform process helpers shared across command modules.
//!
//! Landed during the Windows-port Linux-prep (2026-06-19): the platform-agnostic
//! interpreter resolution that compiles + behaves identically on Linux while
//! giving Windows the correct entrypoint. Windows-specific PATH probing (npm.cmd,
//! `claude` under %APPDATA%, etc.) is deferred to the Windows-side port (SF3).

use std::ffi::OsStr;
use tokio::process::Command as TokioCommand;

/// `CREATE_NO_WINDOW` — give a console-subsystem child its own hidden console
/// instead of letting it inherit ours.
///
/// Every helper we spawn (python, ffmpeg, ffprobe, yt-dlp, git, the sidecar
/// daemons) is a console program. Without this flag Windows hands the child the
/// *parent's* console, which breaks two ways:
///
///  1. In the NSIS build the app has no console, so each spawn allocates a
///     visible one — a black box that flashes on screen mid-download.
///  2. In `tauri dev` the app inherits the launching terminal's console. If that
///     terminal dies while the app lives on (a killed `npm run tauri dev` job
///     leaves an orphaned but perfectly functional window), the console is gone,
///     and every child then dies during startup with `STATUS_DLL_INIT_FAILED`
///     (`0xc0000142`) before printing a single byte. That surfaced as "stream
///     resolve failed (exit code: 0xc0000142): no output" on the music player
///     and a silently empty ffmpeg encoder probe — one dead console, every
///     helper in the app down at once, with nothing in any log to say why.
///
/// The flag is Windows-only and ignored for GUI-subsystem children, so the
/// constructors below are safe to use for every spawn in the app.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The app's `tokio` process constructor — use instead of `TokioCommand::new`.
pub fn tokio_cmd<S: AsRef<OsStr>>(program: S) -> TokioCommand {
    #[allow(unused_mut)]
    let mut c = TokioCommand::new(program);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Blocking counterpart to [`tokio_cmd`] — use instead of `std::process::Command::new`.
pub fn std_cmd<S: AsRef<OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// A `tokio` Command seeded with the Python 3 interpreter for the current OS.
///
/// - Unix: `python3` (identical to the previous hardcoded callsites).
/// - Windows: the `py -3` launcher — the canonical Windows Python entrypoint
///   installed with the official installer's "py launcher" option.
pub fn python_cmd() -> TokioCommand {
    #[cfg(windows)]
    {
        let mut c = tokio_cmd("py");
        c.arg("-3");
        c
    }
    #[cfg(not(windows))]
    {
        tokio_cmd("python3")
    }
}

/// Hard-terminate a process *tree* by PID — the non-Unix arm for the cancel
/// paths that previously no-op'd on Windows. `/T` kills the whole tree (e.g. a
/// Python downloader's yt-dlp/ffmpeg children), `/F` forces it. There is no
/// graceful SIGTERM analog on Windows, so this is always a hard kill; Unix
/// callers keep using `libc::kill` for the SIGTERM→SIGKILL escalation. Sync (a
/// blocking `taskkill`) so both sync and async callers can use one helper; the
/// cancel path is rare and `taskkill` returns fast.
#[cfg(not(unix))]
pub fn terminate_pid(pid: u32) {
    let _ = std_cmd("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

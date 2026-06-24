//! Small cross-platform process helpers shared across command modules.
//!
//! Landed during the Windows-port Linux-prep (2026-06-19): the platform-agnostic
//! interpreter resolution that compiles + behaves identically on Linux while
//! giving Windows the correct entrypoint. Windows-specific PATH probing (npm.cmd,
//! `claude` under %APPDATA%, etc.) is deferred to the Windows-side port (SF3).

use tokio::process::Command as TokioCommand;

/// A `tokio` Command seeded with the Python 3 interpreter for the current OS.
///
/// - Unix: `python3` (identical to the previous hardcoded callsites).
/// - Windows: the `py -3` launcher — the canonical Windows Python entrypoint
///   installed with the official installer's "py launcher" option.
pub fn python_cmd() -> TokioCommand {
    #[cfg(windows)]
    {
        let mut c = TokioCommand::new("py");
        c.arg("-3");
        c
    }
    #[cfg(not(windows))]
    {
        TokioCommand::new("python3")
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
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
}

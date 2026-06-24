//! External-tool path resolution. Prefers a binary bundled next to the app
//! executable (`<exe-dir>/bin/<name>`) over the system `PATH`, so a release
//! build can ship ffmpeg/ffprobe/yt-dlp without requiring the user to install
//! them. Until those binaries are bundled (deferred to the public release),
//! `bundled()` finds nothing and `resolve()` returns the bare name — identical
//! to the previous `Command::new("ffmpeg")` behavior (OS `PATH` lookup).

use std::path::PathBuf;

/// Resolve an external tool to a concrete path if a bundled copy exists next to
/// the app binary, otherwise the bare `name` (resolved against `PATH` by the OS
/// at spawn time).
pub fn resolve(name: &str) -> String {
    bundled(name)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string())
}

/// Strip the `\\?\` extended-length (verbatim) prefix that `fs::canonicalize`
/// returns on Windows. ffmpeg AND ffprobe both reject the verbatim form
/// ("Error opening input: Invalid argument") — every editor import (probe +
/// remux) died on it post the Linux→Windows migration. A no-op off-Windows
/// (canonicalize never adds the prefix there) and on already-plain paths; the
/// UNC verbatim form (`\\?\UNC\server\share`) collapses back to `\\server\share`.
/// Pure prefix surgery — a `?` elsewhere in the path is untouched.
pub fn native_str(s: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s.to_string()
}

/// `native_str` for a `Path` argument (e.g. ffprobe `.arg(...)`). Non-UTF-8 paths
/// (which `canonicalize` only produces from already-valid files, vanishingly
/// rare) pass through unchanged rather than risk a lossy round-trip.
pub fn native_path(p: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    if let Some(s) = p.to_str() {
        return std::path::PathBuf::from(native_str(s));
    }
    p.to_path_buf()
}

/// `<exe-dir>/bin/<name>(.exe)` if it exists.
fn bundled(name: &str) -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    #[cfg(windows)]
    let file = format!("{name}.exe");
    #[cfg(not(windows))]
    let file = name.to_string();
    let candidate = dir.join("bin").join(file);
    candidate.exists().then_some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_falls_back_to_bare_name_when_unbundled() {
        // No `<exe-dir>/bin/<this>` exists in the test environment.
        assert_eq!(resolve("definitely-not-a-real-tool"), "definitely-not-a-real-tool");
    }

    #[test]
    fn native_str_strips_verbatim_prefix_on_windows() {
        // Plain paths and non-prefixed strings are always untouched.
        assert_eq!(native_str("C:\\Users\\a\\v.mp4"), "C:\\Users\\a\\v.mp4");
        assert_eq!(native_str("/tmp/a.mp4"), "/tmp/a.mp4");
        assert_eq!(native_str("a?b/c.mp4"), "a?b/c.mp4"); // a '?' mid-path is not a prefix
        #[cfg(windows)]
        {
            assert_eq!(native_str(r"\\?\C:\Users\a\v.mp4"), r"C:\Users\a\v.mp4");
            assert_eq!(native_str(r"\\?\UNC\srv\share\v.mp4"), r"\\srv\share\v.mp4");
        }
        #[cfg(not(windows))]
        {
            // Off-Windows the prefix is meaningless and left verbatim.
            assert_eq!(native_str(r"\\?\C:\x"), r"\\?\C:\x");
        }
    }
}

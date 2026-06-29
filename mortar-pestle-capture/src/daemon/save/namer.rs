//! GameNamer (sub-plan 3 SF2) — attribute a clip to the running game.
//!
//! Priority: a running **Steam** game (its launch wrapper's `/proc/<pid>/cmdline`
//! carries `SteamLaunch AppId=<id>`, resolved to a display name via that app's
//! `appmanifest_<id>.acf`) → the **focused toplevel window title** (best-effort,
//! KDE/X tools that may be absent) → **"Desktop"**. The result is sanitized into a
//! single safe path component used for both the `Captures/<Game>/` folder and the
//! clip filename stem.

use std::path::PathBuf;
use std::process::Command;

/// Detect the current game for clip attribution. Always returns a non-empty,
/// sanitized folder component (worst case `"Desktop"`).
pub fn detect_game() -> String {
    let raw = steam_game().or_else(toplevel_title);
    raw.map(|g| sanitize_folder(&g))
        .filter(|g| !g.is_empty())
        .unwrap_or_else(|| "Desktop".to_string())
}

/// Scan every `/proc/<pid>/cmdline` for the Steam launch-wrapper signature
/// `SteamLaunch AppId=<id>`; resolve `<id>` to the game name via its ACF.
fn steam_game() -> Option<String> {
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let fname = entry.file_name();
        let Some(pid) = fname.to_str() else { continue };
        if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else { continue };
        if let Some(appid) = parse_steam_appid(&raw) {
            // AppId found → prefer the ACF display name, else a generic label.
            return Some(acf_name(appid).unwrap_or_else(|| format!("Steam App {appid}")));
        }
    }
    None
}

/// Find `SteamLaunch ... AppId=<id>` in a NUL-separated `/proc` cmdline and return
/// `<id>`. Requires the `SteamLaunch` marker so an unrelated `AppId=` elsewhere
/// doesn't false-match.
fn parse_steam_appid(cmdline: &[u8]) -> Option<u32> {
    let text = String::from_utf8_lossy(cmdline).replace('\0', " ");
    if !text.contains("SteamLaunch") {
        return None;
    }
    let rest = &text[text.find("AppId=")? + "AppId=".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Read the display name from `appmanifest_<appid>.acf` across known steamapps roots.
fn acf_name(appid: u32) -> Option<String> {
    for root in steamapps_roots() {
        let acf = root.join(format!("appmanifest_{appid}.acf"));
        let Ok(content) = std::fs::read_to_string(&acf) else { continue };
        if let Some(name) = parse_acf_name(&content) {
            return Some(name);
        }
    }
    None
}

/// VDF is line-oriented key/value: grab the value of the top-level `"name"` key.
fn parse_acf_name(content: &str) -> Option<String> {
    for line in content.lines() {
        if let Some(rest) = line.trim().strip_prefix("\"name\"") {
            // rest looks like:  \t\t"Deadlock"
            let after = &rest[rest.find('"')? + 1..];
            let name = &after[..after.find('"')?];
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Candidate steamapps dirs: the default roots + any `libraryfolders.vdf` `"path"`
/// entries (games installed on other drives).
fn steamapps_roots() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut roots = vec![
        home.join(".steam/steam/steamapps"),
        home.join(".local/share/Steam/steamapps"),
        home.join(".steam/root/steamapps"),
    ];
    for base in roots.clone() {
        let Ok(content) = std::fs::read_to_string(base.join("libraryfolders.vdf")) else { continue };
        for line in content.lines() {
            if let Some(rest) = line.trim().strip_prefix("\"path\"") {
                if let Some(q1) = rest.find('"') {
                    let after = &rest[q1 + 1..];
                    if let Some(q2) = after.find('"') {
                        let p = PathBuf::from(&after[..q2]).join("steamapps");
                        if !roots.contains(&p) {
                            roots.push(p);
                        }
                    }
                }
            }
        }
    }
    roots
}

/// Best-effort focused-window title (non-Steam games / native launchers). The
/// tools may be absent on this box — then we fall through to "Desktop". Existence-
/// guarded the same way the KDE-settings launcher tries multiple binaries.
fn toplevel_title() -> Option<String> {
    for (bin, args) in [
        ("kdotool", ["getactivewindow", "getwindowname"]),
        ("xdotool", ["getactivewindow", "getwindowname"]),
    ] {
        if let Ok(out) = Command::new(bin).args(args).output() {
            if out.status.success() {
                let title = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !title.is_empty() && title != "Desktop" {
                    return Some(title);
                }
            }
        }
    }
    None
}

/// Sanitize a game name into one safe path component: replace separators/control
/// chars with spaces, trim surrounding whitespace + dots, collapse runs, cap to 80.
pub fn sanitize_folder(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' || c == '\0' || c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches('.').trim();
    trimmed.chars().take(80).collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_appid_needs_the_launch_marker() {
        // The real reaper cmdline (NUL-separated argv).
        let cmd = b"reaper\0SteamLaunch\0AppId=1422450\0--\0/games/deadlock.exe\0";
        assert_eq!(parse_steam_appid(cmd), Some(1422450));
        // `AppId=` without `SteamLaunch` must NOT match (avoid false positives).
        assert_eq!(parse_steam_appid(b"some-tool\0AppId=999\0"), None);
        // No AppId at all.
        assert_eq!(parse_steam_appid(b"SteamLaunch\0nope\0"), None);
    }

    #[test]
    fn acf_name_extracts_the_top_level_name() {
        let acf = "\"AppState\"\n{\n\t\"appid\"\t\t\"1422450\"\n\t\"name\"\t\t\"Deadlock\"\n\t\"StateFlags\"\t\t\"4\"\n}\n";
        assert_eq!(parse_acf_name(acf).as_deref(), Some("Deadlock"));
        // A similarly-prefixed key must not match.
        assert_eq!(parse_acf_name("\t\"namespace\"\t\t\"x\"\n"), None);
    }

    #[test]
    fn sanitize_strips_separators_and_caps() {
        assert_eq!(sanitize_folder("Deadlock"), "Deadlock");
        assert_eq!(sanitize_folder("Half-Life: Alyx/2"), "Half-Life: Alyx 2");
        assert_eq!(sanitize_folder("  ..bad..  "), "bad");
        assert_eq!(sanitize_folder("a\0b\tc"), "a b c");
        assert_eq!(sanitize_folder(&"x".repeat(200)).len(), 80);
    }
}

//! Recording filename formatter — the OBS FilenameFormatting token set (a
//! Rust port of os_generate_formatted_filename's mapping; unknown `%x` drops
//! the `%`, OBS behavior) plus the app's own `%game` token, resolved like the
//! capture engine's GameNamer: foreground window title, skipping our own
//! capture-excluded overlay windows, worst case "Desktop".
//!
//! `%game` is OURS — libobs's formatter would erase the `%` and leave "game",
//! so the replay-buffer path pre-expands ONLY `%game` (expand_game) and hands
//! the date tokens through unexpanded for libobs to stamp at save time.

use windows_sys::Win32::Foundation::SYSTEMTIME;

const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

fn now() -> SYSTEMTIME {
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    let mut st = unsafe { std::mem::zeroed::<SYSTEMTIME>() };
    unsafe { GetLocalTime(&mut st) };
    st
}

/// Full expansion (recording path stem): date tokens + %game.
pub fn format_filename(template: &str) -> String {
    expand(template, &detect_game(), &now())
}

/// Expand ONLY `%game`; every other token passes through untouched.
pub fn expand_game(template: &str) -> String {
    template.replace("%game", &detect_game())
}

fn expand(template: &str, game: &str, st: &SYSTEMTIME) -> String {
    let day = DAYS[(st.wDayOfWeek as usize).min(6)];
    let month = MONTHS[((st.wMonth as usize).clamp(1, 12)) - 1];
    let mut out = String::with_capacity(template.len() + 16);
    let mut rest = template;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        // Longest match first (%CCYY before %CC.., %game before %g..).
        let (val, len): (String, usize) = if rest.starts_with("CCYY") {
            (format!("{:04}", st.wYear), 4)
        } else if rest.starts_with("game") {
            (game.to_string(), 4)
        } else if rest.starts_with("YY") {
            (format!("{:02}", st.wYear % 100), 2)
        } else if rest.starts_with("MM") {
            (format!("{:02}", st.wMonth), 2)
        } else if rest.starts_with("DD") {
            (format!("{:02}", st.wDay), 2)
        } else if rest.starts_with("hh") {
            (format!("{:02}", st.wHour), 2)
        } else if rest.starts_with("mm") {
            (format!("{:02}", st.wMinute), 2)
        } else if rest.starts_with("ss") {
            (format!("{:02}", st.wSecond), 2)
        } else if rest.starts_with('a') {
            (day[..3].to_string(), 1)
        } else if rest.starts_with('A') {
            (day.to_string(), 1)
        } else if rest.starts_with('b') {
            (month[..3].to_string(), 1)
        } else if rest.starts_with('B') {
            (month.to_string(), 1)
        } else if rest.starts_with('%') {
            ("%".to_string(), 1)
        } else {
            // Unknown token: erase the '%' (platform.c:771 behavior).
            (String::new(), 0)
        };
        out.push_str(&val);
        rest = &rest[len..];
    }
    out.push_str(rest);
    out
}

// --- %game detection (GameNamer port, windows-sys idiom) --------------------

/// Foreground-window title as a sanitized path component, walking past our own
/// WDA_EXCLUDEFROMCAPTURE overlay HUDs ("Mortar & Pestle Overlay" titles).
/// Always non-empty; worst case "Desktop".
pub fn detect_game() -> String {
    let hwnd = capture_target_hwnd();
    title_for(hwnd)
        .map(|t| sanitize_folder(&t))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Desktop".to_string())
}

type Hwnd = windows_sys::Win32::Foundation::HWND;

fn capture_target_hwnd() -> Hwnd {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindow, GW_HWNDNEXT};
    let mut hwnd = unsafe { GetForegroundWindow() };
    for _ in 0..32 {
        if hwnd.is_null() {
            break;
        }
        if is_visible(hwnd) && !is_overlay(hwnd) {
            return hwnd;
        }
        hwnd = unsafe { GetWindow(hwnd, GW_HWNDNEXT) };
    }
    hwnd
}

fn is_overlay(hwnd: Hwnd) -> bool {
    matches!(title_for(hwnd), Some(t) if t.starts_with("Mortar & Pestle Overlay"))
}

fn is_visible(hwnd: Hwnd) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    unsafe { IsWindowVisible(hwnd) != 0 }
}

fn title_for(hwnd: Hwnd) -> Option<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    if hwnd.is_null() {
        return None;
    }
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..n as usize]))
}

/// Byte-identical port of the capture engine's sanitize_folder (namer_win.rs).
fn sanitize_folder(name: &str) -> String {
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

    fn st() -> SYSTEMTIME {
        let mut st = unsafe { std::mem::zeroed::<SYSTEMTIME>() };
        st.wYear = 2026;
        st.wMonth = 7;
        st.wDay = 3;
        st.wDayOfWeek = 5; // Friday
        st.wHour = 14;
        st.wMinute = 5;
        st.wSecond = 9;
        st
    }

    #[test]
    fn token_table() {
        let s = st();
        for (tpl, want) in [
            ("%CCYY-%MM-%DD %hh-%mm-%ss", "2026-07-03 14-05-09"),
            ("%YY", "26"),
            ("%a %A %b %B", "Fri Friday Jul July"),
            ("%game clip", "Deadlock clip"),
            ("100%%", "100%"),
            ("%unknown", "unknown"), // '%' erased, OBS behavior
            ("plain", "plain"),
        ] {
            assert_eq!(expand(tpl, "Deadlock", &s), want, "template {tpl}");
        }
    }

    #[test]
    fn game_only_expansion_leaves_dates() {
        assert_eq!(
            "%CCYY-%MM Deadlock".to_string(),
            "%CCYY-%MM %game".replace("%game", "Deadlock")
        );
    }

    #[test]
    fn sanitize() {
        assert_eq!(sanitize_folder("A/B\\C\tD"), "A B C D");
        assert_eq!(sanitize_folder("  ..dots..  "), "dots");
    }
}

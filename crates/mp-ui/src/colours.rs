//! The colour list mp-theme writes (`~/.config/mp-theme/colours.toml`): `mode`,
//! then one `[dark]` and one `[light]` section of `name = "#rrggbb"` lines. mp-theme
//! taps every M&P program that holds SIGUSR2 once it has written new ones (`hold` +
//! `changes`; the shell waits for it among its own signals).

use std::{env, fs, path::PathBuf};

use iced::futures::channel::mpsc;
use iced::{Color, Subscription};

#[derive(Debug, Clone, Copy)]
pub struct Colours {
    pub frame: Color,
    pub panel: Color,
    pub raised: Color,
    /// Lines only.
    pub border: Color,
    pub text: Color,
    pub text_muted: Color,
    pub text_faint: Color,
    pub accent: Color,
    pub on_accent: Color,
    pub error: Color,
}

/// `$XDG_CONFIG_HOME`, else `~/.config`.
pub fn config_dir() -> PathBuf {
    env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".config"))
}

pub fn load() -> Colours {
    let path = config_dir().join("mp-theme/colours.toml");
    let file = fs::read_to_string(&path).unwrap_or_else(|e| {
        eprintln!("{}: {e} (run mp-theme)", path.display());
        String::new()
    });
    let mode = value(&file, None, "mode").unwrap_or("dark");
    let get = |name| value(&file, Some(mode), name).and_then(hex).unwrap_or(Color::from_rgb8(0x80, 0x80, 0x80));
    Colours {
        frame: get("frame"),
        panel: get("panel"),
        raised: get("raised"),
        border: get("border"),
        text: get("text"),
        text_muted: get("text-muted"),
        text_faint: get("text-faint"),
        accent: get("accent"),
        on_accent: get("on-accent"),
        error: get("error"),
    }
}

/// `name = "value"` in `section` (None = before the first section).
fn value<'a>(file: &'a str, section: Option<&str>, name: &str) -> Option<&'a str> {
    let mut current = None;
    for line in file.lines() {
        if let Some(s) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = Some(s);
        } else if current == section
            && let Some((k, v)) = line.split_once('=')
            && k.trim() == name
        {
            return Some(v.trim().trim_matches('"'));
        }
    }
    None
}

fn hex(s: &str) -> Option<Color> {
    let v = u32::from_str_radix(s.strip_prefix('#')?, 16).ok()?;
    Some(Color::from_rgb8((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

fn usr2() -> libc::sigset_t {
    // SAFETY: the set is emptied before it is filled and read.
    unsafe {
        let mut set = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGUSR2);
        set
    }
}

/// Keeps SIGUSR2 (which would end the program) off every thread started after
/// this, so `changes` takes it and mp-theme knows this program listens: first
/// thing in `main`, before any thread starts.
pub fn hold() {
    // SAFETY: changes this thread's signal mask only; new threads inherit it.
    unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &usr2(), std::ptr::null_mut()) };
}

/// One message each time mp-theme has written new colours: read them with `load`.
/// A thread waits in `sigwait`, so nothing runs in between.
pub fn changes() -> Subscription<()> {
    Subscription::run(|| {
        let (mut tx, rx) = mpsc::channel(1);
        std::thread::spawn(move || {
            let set = usr2();
            let mut signal = 0;
            // SAFETY: sigwait reads the set and writes the signal's number.
            while unsafe { libc::sigwait(&set, &mut signal) } == 0 && !tx.is_closed() {
                let _ = tx.try_send(());
            }
        });
        rx
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_reads_its_own_section_only() {
        let file = "mode = \"dark\"\n[dark]\ntext = \"#ffffff\"\n[light]\ntext = \"#000000\"\n";
        assert_eq!(value(file, None, "mode"), Some("dark"));
        assert_eq!(value(file, Some("light"), "text"), Some("#000000"));
        assert_eq!(value(file, Some("dark"), "mode"), None);
        assert_eq!(value(file, Some("dim"), "text"), None);
    }

    #[test]
    fn hex_reads_six_digits() {
        assert_eq!(hex("#ff8000"), Some(Color::from_rgb8(255, 128, 0)));
        assert_eq!(hex("ff8000"), None);
        assert_eq!(hex("#nothex"), None);
    }
}

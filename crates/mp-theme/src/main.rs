//! mp-theme: the one colour list (Linux Native Apps plan, Phase 3 step 4). Since
//! 2026-11-09 two fixed sets, the wallpaper no longer read (his ask, Noctalia Look):
//! light = the colours of hooxoo's Umbriel `config.toml` in the noctalia.dev picture,
//! exactly; dark = each light colour's opposite (255 minus red, green, blue). Written
//! to ~/.config/mp-theme/ as colours.toml (apps), niri.kdl and foot.ini (included by
//! their configs). Open foot windows are recoloured with escape codes, and mp-shell is
//! told to read colours.toml again (SIGUSR2).
//!
//!   mp-theme [dark|light|toggle]
//!
//! No mode keeps the current one.
use std::{collections::HashMap, env, fmt::Write as _, fs, path::Path, process::exit};

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rgb(u8, u8, u8);

impl Rgb {
    const fn hex(v: u32) -> Self {
        Self((v >> 16) as u8, (v >> 8) as u8, v as u8)
    }

    fn as_hex(self) -> String {
        format!("{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }

    fn opposite(self) -> Self {
        Self(255 - self.0, 255 - self.1, 255 - self.2)
    }

    /// WCAG relative luminance.
    fn luminance(self) -> f64 {
        let lin = |c: u8| {
            let c = f64::from(c) / 255.0;
            if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * lin(self.0) + 0.7152 * lin(self.1) + 0.0722 * lin(self.2)
    }

    /// `t` of the way from this colour to `to`.
    fn mix(self, to: Self, t: f64) -> Self {
        let m = |a: u8, b: u8| (f64::from(a) + (f64::from(b) - f64::from(a)) * t).round() as u8;
        Self(m(self.0, to.0), m(self.1, to.1), m(self.2, to.2))
    }
}

/// WCAG contrast ratio.
fn ratio(a: Rgb, b: Rgb) -> f64 {
    let (x, y) = (a.luminance(), b.luminance());
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

/// The ten colours every program reads.
#[derive(Clone, Copy)]
struct Colours {
    frame: Rgb,
    panel: Rgb,
    raised: Rgb,
    border: Rgb,
    text: Rgb,
    text_muted: Rgb,
    text_faint: Rgb,
    accent: Rgb,
    on_accent: Rgb,
    error: Rgb,
}

/// hooxoo's Umbriel `[colors]` as the picture shows them; each slot takes one of its
/// values (its name there after the slot). The text greys keep their order, darkest =
/// strongest; its `text_muted` #AEAEAE is lighter than its unfocused title text, so it
/// fills `raised` (= its `accent_secondary`) instead.
const LIGHT: Colours = Colours {
    frame: Rgb::hex(0xcccccc),      // background
    panel: Rgb::hex(0xcccccc),      // background
    raised: Rgb::hex(0xaeaeae),     // accent_secondary
    border: Rgb::hex(0x9a9a9a),     // insert_hint
    text: Rgb::hex(0x474747),       // text_primary (border.focused, title_bar.background)
    text_muted: Rgb::hex(0x727272), // title_bar.maximize
    text_faint: Rgb::hex(0x9a9a9a), // title_bar.text_unfocused
    accent: Rgb::hex(0x333333),     // accent_primary
    on_accent: Rgb::hex(0xcccccc),  // background (title_bar.text)
    error: Rgb::hex(0xc67777),      // error
};

impl Colours {
    /// Every colour's opposite but `error`, which stays red (its opposite is teal).
    fn opposite(&self) -> Self {
        Self {
            frame: self.frame.opposite(),
            panel: self.panel.opposite(),
            raised: self.raised.opposite(),
            border: self.border.opposite(),
            text: self.text.opposite(),
            text_muted: self.text_muted.opposite(),
            text_faint: self.text_faint.opposite(),
            accent: self.accent.opposite(),
            on_accent: self.on_accent.opposite(),
            error: self.error,
        }
    }

    fn named(&self) -> [(&'static str, Rgb); 10] {
        [
            ("frame", self.frame),
            ("panel", self.panel),
            ("raised", self.raised),
            ("border", self.border),
            ("text", self.text),
            ("text-muted", self.text_muted),
            ("text-faint", self.text_faint),
            ("accent", self.accent),
            ("on-accent", self.on_accent),
            ("error", self.error),
        ]
    }

    /// foot's 16 colours, each made readable on the terminal background (`panel`):
    /// moved towards black on a light one, white on a dark one, until it reads.
    fn terminal(&self) -> [Rgb; 16] {
        let bg = self.panel;
        // 0.179: the luminance where black and white read equally well on it.
        let to = if bg.luminance() < 0.179 { Rgb(255, 255, 255) } else { Rgb(0, 0, 0) };
        let mut out = FOOT_DEFAULTS.map(Rgb::hex);
        for (i, c) in out.iter_mut().enumerate().skip(1) {
            // 0 is "black", a background colour; 8 is the faint grey (3:1 like Dim text).
            let min = if i == 8 { 3.0 } else { 4.5 };
            let start = *c;
            let mut t = 0.0;
            while ratio(*c, bg) < min && t < 1.0 {
                t += 0.02;
                *c = start.mix(to, t);
            }
        }
        out
    }
}

/// foot.ini(5) defaults for regular0-7 then bright0-7 (starlight theme, V4).
const FOOT_DEFAULTS: [u32; 16] = [
    0x242424, 0xf62b5a, 0x47b413, 0xe3c401, 0x24acd4, 0xf2affd, 0x13c299, 0xe6e6e6, 0x616161, 0xff4d51, 0x35d450, 0xe9e836, 0x5dc5f8, 0xfeabf2, 0x24dfc4, 0xffffff,
];

/// Writes through a temporary file, so niri never reads half a file.
fn write(path: &Path, text: &str) {
    let tmp = path.with_extension("tmp");
    if let Err(e) = fs::write(&tmp, text).and_then(|()| fs::rename(&tmp, path)) {
        eprintln!("mp-theme: {}: {e}", path.display());
        exit(1);
    }
}

const HEADER: &str = "Made by mp-theme: hooxoo's colours (light) and their opposite (dark). Don't edit: run mp-theme again.";

fn colours_toml(mode: &str, dark: &Colours, light: &Colours) -> String {
    let mut s = format!("# {HEADER}\nmode = \"{mode}\"\n");
    for (name, c) in [("dark", dark), ("light", light)] {
        let _ = write!(s, "\n[{name}]\n");
        for (key, rgb) in c.named() {
            let _ = writeln!(s, "{key} = \"#{}\"", rgb.as_hex());
        }
    }
    s
}

/// The line round every window, solid: hooxoo's Umbriel border, the focused one in
/// `text` (its text colour, Noctalia Look step 3), the others in `frame`, the top
/// bar's colour (his ask 2026-11-09, plan Window Title Strips). niri's config holds
/// the width.
fn niri_kdl(c: &Colours) -> String {
    format!(
        "// {HEADER}\nlayout {{\n    border {{\n        active-color \"#{}ff\"\n        inactive-color \"#{}ff\"\n    }}\n}}\n",
        c.text.as_hex(),
        c.frame.as_hex()
    )
}

fn foot_ini(mode: &str, dark: &Colours, light: &Colours) -> String {
    let mut s = format!("# {HEADER}\ninitial-color-theme={mode}\n");
    for (name, c) in [("colors-dark", dark), ("colors-light", light)] {
        let _ = write!(
            s,
            "\n[{name}]\nbackground={}\nforeground={}\ncursor={} {}\nselection-background={}\nselection-foreground={}\n",
            c.panel.as_hex(),
            c.text.as_hex(),
            c.on_accent.as_hex(),
            c.accent.as_hex(),
            c.accent.as_hex(),
            c.on_accent.as_hex()
        );
        for (i, rgb) in c.terminal().iter().enumerate() {
            let (kind, n) = if i < 8 { ("regular", i) } else { ("bright", i - 8) };
            let _ = writeln!(s, "{kind}{n}={}", rgb.as_hex());
        }
    }
    s
}

/// pid -> (name, parent pid), from /proc/<pid>/stat: "pid (name) state ppid ...".
fn processes() -> HashMap<String, (String, String)> {
    let mut procs = HashMap::new();
    for entry in fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else { continue };
        let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else { continue };
        let ppid = stat[close + 2..].split(' ').nth(1).unwrap_or("");
        procs.insert(stat[..open].trim().to_owned(), (stat[open + 1..close].to_owned(), ppid.to_owned()));
    }
    procs
}

/// Sends the colours to every terminal whose parent is foot (its shell's /dev/pts).
fn recolour_open_foot_windows(c: &Colours, procs: &HashMap<String, (String, String)>) {
    let osc = |n: &str, rgb: Rgb| format!("\x1b]{n};#{}\x1b\\", rgb.as_hex());
    let mut codes = osc("10", c.text) + &osc("11", c.panel) + &osc("12", c.accent) + &osc("17", c.accent) + &osc("19", c.on_accent);
    for (i, rgb) in c.terminal().iter().enumerate() {
        codes += &osc(&format!("4;{i}"), *rgb);
    }
    let mut done = vec![];
    for (pid, (_, ppid)) in procs {
        if procs.get(ppid).is_none_or(|(name, _)| name != "foot") {
            continue;
        }
        let Ok(tty) = fs::read_link(format!("/proc/{pid}/fd/0")) else { continue };
        if tty.starts_with("/dev/pts/") && !done.contains(&tty) {
            let _ = fs::write(&tty, &codes);
            done.push(tty);
        }
    }
}

/// Tells every M&P program that listens to read colours.toml again (SIGUSR2): its
/// name starts with `mp-` and it holds the signal (blocked or caught), so programs
/// that don't listen (mp-player) aren't ended by it.
fn recolour_m_and_p_apps(procs: &HashMap<String, (String, String)>) {
    for (pid, (name, _)) in procs {
        if name.starts_with("mp-")
            && holds_usr2(pid)
            && let Ok(pid) = pid.parse()
        {
            // SAFETY: sends a signal; reads and writes nothing.
            unsafe { libc::kill(pid, libc::SIGUSR2) };
        }
    }
}

/// SIGUSR2 in the program's blocked or caught set (`/proc/<pid>/status`, hex masks,
/// signal n = bit n - 1).
fn holds_usr2(pid: &str) -> bool {
    let Ok(status) = fs::read_to_string(format!("/proc/{pid}/status")) else { return false };
    let bit = 1u64 << (libc::SIGUSR2 - 1);
    status.lines().any(|l| (l.starts_with("SigBlk:") || l.starts_with("SigCgt:")) && u64::from_str_radix(l[7..].trim(), 16).is_ok_and(|m| m & bit != 0))
}

fn main() {
    let home = env::var("HOME").unwrap_or_default();
    let dir = env::var("XDG_CONFIG_HOME").unwrap_or(format!("{home}/.config")) + "/mp-theme";
    let list = format!("{dir}/colours.toml");
    let current = fs::read_to_string(&list).ok().and_then(|s| s.lines().find_map(|l| l.strip_prefix("mode = \"")?.strip_suffix('"').map(str::to_owned)));
    let current = current.unwrap_or_else(|| "dark".into());

    let mut mode = current.clone();
    for arg in env::args().skip(1) {
        match arg.as_str() {
            "dark" | "light" => mode = arg,
            "toggle" => mode = if current == "dark" { "light".into() } else { "dark".into() },
            _ => {
                eprintln!("usage: mp-theme [dark|light|toggle]");
                exit(2);
            }
        }
    }
    let (dark, light) = (LIGHT.opposite(), LIGHT);

    let now = if mode == "light" { &light } else { &dark };
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("mp-theme: {dir}: {e}");
        exit(1);
    }
    write(Path::new(&list), &colours_toml(&mode, &dark, &light));
    write(Path::new(&format!("{dir}/niri.kdl")), &niri_kdl(now));
    write(Path::new(&format!("{dir}/foot.ini")), &foot_ini(&mode, &dark, &light));
    let procs = processes();
    recolour_open_foot_windows(now, &procs);
    recolour_m_and_p_apps(&procs);
    println!("mp-theme: {mode}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_is_the_light_set_s_opposite_but_the_red() {
        let dark = LIGHT.opposite();
        assert_eq!(dark.frame, Rgb::hex(0x333333));
        assert_eq!(dark.text, Rgb::hex(0xb8b8b8));
        assert_eq!(dark.accent, Rgb::hex(0xcccccc));
        assert_eq!(dark.error, LIGHT.error);
    }

    #[test]
    fn terminal_colours_are_readable_on_both_sets() {
        for c in [LIGHT, LIGHT.opposite()] {
            let colours = c.terminal();
            assert_eq!(colours[0], Rgb::hex(FOOT_DEFAULTS[0]));
            for (i, rgb) in colours.iter().enumerate().skip(1) {
                let min = if i == 8 { 3.0 } else { 4.5 };
                assert!(ratio(*rgb, c.panel) >= min, "{} colour {i}", c.panel.as_hex());
            }
        }
    }

    #[test]
    fn holds_usr2_reads_this_thread_s_blocked_signals() {
        assert!(!holds_usr2("thread-self"));
        assert!(!holds_usr2("no-such-program"));
        // SAFETY: changes this test thread's signal mask only.
        unsafe {
            let mut set = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGUSR2);
            libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        }
        assert!(holds_usr2("thread-self"));
    }
}

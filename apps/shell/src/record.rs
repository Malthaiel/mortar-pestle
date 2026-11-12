//! The screen recorder's process side (Side Panel Recorder plan; the side panel's box it
//! serves is `recorder.rs`, the replay's pop-up `capture.rs`). gpu-screen-recorder does all the filming; niri starts it
//! (`Spawn`), so it outlives the panel and a shell restart (the shell is a service).
//!
//! - **Instant replay** (Malthaiel's asks 2026-11-04): always on unless he turns it
//!   Off, one screen, the last 30 s / 1 min / 2 min kept in memory, HEVC on the
//!   graphics card's Vulkan encoder at 60 frames a second (his pick after the measure:
//!   0.55% of the PC, half H.264's), sound off at first. His choices live in a small
//!   file (`want`); the shell starts the replay as it starts and checks again each time
//!   the panel opens (`sync`). A tap saves the whole kept stretch (`save`) as
//!   `Clip from 2026-11-04 13-12-43.mp4` beside the recordings.
//! - **A recording** of the replay's screen with the replay's sound runs inside the
//!   replay (his pick 2026-11-04: measured 4.2% -> 4.3% of one core, +4 MB), which
//!   can't pause (the recorder: "pausing is not supported when recording a replay").
//!   An area, another screen, other sound, or the replay Off gets a recorder of its
//!   own, HEVC Vulkan too (his pick 2026-11-04; H.264 Vulkan before), with pause =
//!   SIGUSR2; its stop = SIGINT finishes the file first (0.12-0.23 s, measured
//!   2026-11-03).
//!
//! What runs is read from the live processes each time, never assumed: the recorders
//! from /proc (`comm` is cut to 15 letters), the replay's settings from its own command
//! line, a recording inside it from the file it holds open, how long a recording has
//! run from its start. Paused is the one thing a process can't tell, so each pause is
//! noted in a file in the runtime folder (memory, gone at sign-out) with its pid.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use iced::Color;
use serde_json::json;

use crate::{apps, clock, niri, notices};

/// When the last clip landed on the disk (ms since 1970): the replay picture shows a
/// check for a moment after.
pub static SAVED: AtomicU64 = AtomicU64::new(0);

const COMM: &str = "gpu-screen-reco";
/// The replay's lengths, his rows: 30 s (the default), 1 min, 2 min.
pub const LENGTHS: [u32; 3] = [30, 60, 120];
/// A replay just asked for takes this long to show in /proc, and an old one to end.
const SETTLE: Duration = Duration::from_secs(3);

/// A recording running: its own recorder, or inside the replay (no pause there).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Live {
    pub pid: i32,
    /// When it started, ms since 1970.
    pub since: u64,
    /// Time paused before the pause now, and when that began (0: not paused).
    pub paused_ms: u64,
    pub paused_at: u64,
    pub inside: bool,
}

impl Live {
    pub fn paused(&self) -> bool {
        self.paused_at > 0
    }

    /// How long it has filmed by `now`, in ms: the clock holds while paused.
    pub fn filmed(&self, now: u64) -> u64 {
        let end = if self.paused() { self.paused_at } else { now };
        end.saturating_sub(self.since + self.paused_ms)
    }

    /// The same recording read again, while it still runs.
    pub fn again(&self) -> Option<Live> {
        if self.inside { replay_of(self.pid).and_then(|r| inside(&r)) } else { live(self.pid) }
    }
}

/// The replay as he wants it (his rows), kept in a small file.
#[derive(Debug, Clone, PartialEq)]
pub struct Want {
    pub on: bool,
    pub secs: u32,
    pub sound: bool,
    /// niri's name for the screen it films.
    pub screen: String,
}

/// The replay running, as its own command line says.
#[derive(Debug, Clone, PartialEq)]
pub struct Replay {
    pub pid: i32,
    pub secs: u32,
    pub sound: bool,
    pub screen: String,
    /// Where it takes commands (`gsr-cli -ipc`).
    pub sock: String,
}

/// What runs now.
pub struct Seen {
    pub live: Option<Live>,
    pub replay: Option<Replay>,
    /// slurp is up: an area being picked.
    pub picking: bool,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn recorders() -> impl Iterator<Item = i32> {
    fs::read_dir("/proc").into_iter().flatten().flatten().filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok())
}

pub fn look() -> Seen {
    let mut seen = Seen { live: None, replay: None, picking: false };
    for pid in recorders() {
        match fs::read_to_string(format!("/proc/{pid}/comm")).as_deref().map(str::trim_end) {
            Ok(COMM) => match replay_of(pid) {
                Some(r) if seen.replay.is_none() => {
                    if seen.live.is_none() {
                        seen.live = inside(&r);
                    }
                    seen.replay = Some(r);
                }
                Some(_) => {}
                None if seen.live.is_none() => seen.live = live(pid),
                None => {}
            },
            Ok("slurp") => seen.picking = true,
            _ => {}
        }
    }
    seen
}

/// Recorder `pid`'s settings when it is a replay (its command line has `-r`).
fn replay_of(pid: i32) -> Option<Replay> {
    let line = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let args: Vec<&str> = line.split(|b| *b == 0).filter_map(|a| std::str::from_utf8(a).ok()).collect();
    let after = |flag: &str| args.iter().position(|a| *a == flag).and_then(|i| args.get(i + 1)).map(|v| v.to_string());
    Some(Replay { pid, secs: after("-r")?.parse().ok()?, sound: args.contains(&"-a"), screen: after("-w").unwrap_or_default(), sock: after("-ipc")? })
}

/// A recording inside replay `r`: the recorder names it `Video_<date>.mp4` and holds
/// it open while it films; it began when the file was made.
fn inside(r: &Replay) -> Option<Live> {
    let file = fs::read_dir(format!("/proc/{}/fd", r.pid)).ok()?.flatten().filter_map(|fd| fs::read_link(fd.path()).ok()).find(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name.starts_with("Video_") && name.ends_with(".mp4")
    })?;
    let made = fs::metadata(&file).and_then(|m| m.created()).ok()?;
    let since = made.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    Some(Live { pid: r.pid, since, paused_ms: 0, paused_at: 0, inside: true })
}

/// A recording of its own (`pid`) while it still runs: two small reads, cheap enough
/// each second.
fn live(pid: i32) -> Option<Live> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (head, rest) = stat.rsplit_once(')')?;
    // After the name: the state is the 3rd field, the start (clock ticks after boot) the 22nd.
    let rest: Vec<&str> = rest.split_whitespace().collect();
    if head.split_once('(')?.1 != COMM || rest.first() == Some(&"Z") {
        return None;
    }
    let ticks: u64 = rest.get(19)?.parse().ok()?;
    // SAFETY: sysconf only reads.
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
    let up: f64 = fs::read_to_string("/proc/uptime").ok()?.split_whitespace().next()?.parse().ok()?;
    let since = now_ms().saturating_sub((up * 1000.0) as u64) + ticks * 1000 / hz;
    let (paused_ms, paused_at) = note().filter(|n| n.0 == pid).map_or((0, 0), |n| (n.1, n.2));
    Some(Live { pid, since, paused_ms, paused_at, inside: false })
}

fn runtime() -> PathBuf {
    PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").unwrap_or_else(|| "/tmp".into()))
}

fn note_path() -> PathBuf {
    runtime().join("mp-shell-recording")
}

/// The pause note: the pid, ms paused before, the pause now's start (0: none).
fn note() -> Option<(i32, u64, u64)> {
    let s = fs::read_to_string(note_path()).ok()?;
    let mut n = s.split_whitespace().map(str::parse::<u64>);
    Some((n.next()?.ok()? as i32, n.next()?.ok()?, n.next()?.ok()?))
}

/// Pauses or goes on (SIGUSR2 toggles it), noted for every later read; then read again.
pub fn pause(r: &Live) -> Option<Live> {
    // SAFETY: a signal to the recorder's own pid, just read live.
    if !r.inside && unsafe { libc::kill(r.pid, libc::SIGUSR2) } == 0 {
        let now = now_ms();
        let (paused_ms, paused_at) = if r.paused() { (r.paused_ms + now.saturating_sub(r.paused_at), 0) } else { (r.paused_ms, now) };
        let _ = fs::write(note_path(), format!("{} {paused_ms} {paused_at}", r.pid));
    }
    r.again()
}

/// Stops it: its own recorder finishes the file on SIGINT, then ends; one inside the
/// replay is asked to stop, then named as ours, and a replay change put off while it
/// ran is made.
pub fn stop(r: &Live) {
    if !r.inside {
        // SAFETY: as `pause`.
        unsafe { libc::kill(r.pid, libc::SIGINT) };
        let _ = fs::remove_file(note_path());
        return;
    }
    let Some(replay) = replay_of(r.pid) else { return };
    thread::spawn(move || {
        match cli(&replay.sock, &["stop-replay-recording"]) {
            Ok(path) => {
                rename(&path, "Recording");
            }
            Err(e) => eprintln!("mp-shell: recording: {e}"),
        }
        sync();
    });
}

/// The recorder's own messenger: its answer (a saved file's path), or what went wrong.
fn cli(sock: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("gsr-cli").arg("-ipc").arg(sock).args(args).stdin(Stdio::null()).output().map_err(|e| format!("gsr-cli: {e}"))?;
    let say = |b: &[u8]| String::from_utf8_lossy(b).trim().to_string();
    if out.status.success() { Ok(say(&out.stdout)) } else { Err(Some(say(&out.stderr)).filter(|e| !e.is_empty()).unwrap_or_else(|| say(&out.stdout))) }
}

/// `Replay_2026-11-04_13-12-43.mp4` -> `<word> from 2026-11-04 13-12-43.mp4`, as niri
/// names its screenshots; the recorder's name kept if the rename fails.
fn rename(path: &str, word: &str) -> PathBuf {
    let from = Path::new(path);
    let Some(rest) = from.file_name().and_then(|n| n.to_str()).and_then(|n| n.split_once('_')).map(|(_, rest)| rest.replace('_', " ")) else {
        return from.into();
    };
    let to = from.with_file_name(format!("{word} from {rest}"));
    if fs::rename(from, &to).is_ok() { to } else { from.into() }
}

pub fn folder() -> PathBuf {
    apps::home().join("Videos/Recordings")
}

/// A recording or clip in the folder: where, and what and when as the box's row says it.
pub struct Saved {
    pub path: PathBuf,
    pub when: String,
}

/// The folder's recordings and clips, newest first (Caelestia's `RecordingList`).
pub fn saved() -> Vec<Saved> {
    newest(&folder(), "mp4", |name| if name.starts_with("Clip") { "Clip" } else { "Recording" })
}

/// niri's screenshots, newest first (the recorder box's second list, his ask 2026-11-06).
pub fn shots() -> Vec<Saved> {
    newest(&shots_folder(), "png", |_| "Screenshot")
}

/// `folder`'s files ending `ext`, newest first, each row "what at when".
fn newest(folder: &Path, ext: &str, what: impl Fn(&str) -> &'static str) -> Vec<Saved> {
    let mut files: Vec<(SystemTime, PathBuf)> = fs::read_dir(folder).into_iter().flatten().flatten().filter(|e| e.path().extension().is_some_and(|x| x == ext)).filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path()))).collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    files
        .into_iter()
        .map(|(t, path)| {
            let what = what(path.file_name().and_then(|n| n.to_str()).unwrap_or_default());
            Saved { when: format!("{what} at {}", when(t)), path }
        })
        .collect()
}

pub fn play(path: &Path) {
    niri::act(json!({ "Spawn": { "command": ["mpv", path] } }));
}

/// A screenshot in mpv, held up till closed (mpv shows a picture 1 s by default; his
/// pick 2026-11-06 over Firefox).
pub fn view(path: &Path) {
    niri::act(json!({ "Spawn": { "command": ["mpv", "--image-display-duration=inf", path] } }));
}

/// A folder in mp-files (it shows the open window when one runs).
pub fn show(folder: &Path) {
    niri::act(json!({ "Spawn": { "command": ["mp-files", folder.to_string_lossy()] } }));
}

/// To the bin (his call 2026-11-03: no question).
pub fn trash(path: &Path) -> bool {
    Command::new("gio").args(["trash", "--"]).arg(path).status().is_ok_and(|s| s.success())
}

/// "Nov 3, 9:45 PM".
fn when(t: SystemTime) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let now = clock::at(t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64));
    let ((h, half), t) = (now.twelve(), now.0);
    format!("{} {}, {h}:{:02} {half}", MONTHS[t.tm_mon as usize % 12], t.tm_mday, t.tm_min)
}

/// Starts recording screen `output`, or an `area` of it, with or without the PC's
/// `sound`: inside the replay when it films that screen with that sound, else on a
/// recorder of its own. An area is picked first with slurp (Esc = nothing recorded),
/// run here on a side thread and waited for, so the recorder's start in /proc is the
/// recording's own; slurp in our colours: the border Accent, the rest under the frame's
/// colour at the faded 40%.
pub fn start(output: &str, area: bool, sound: bool, accent: Color, frame: Color) {
    if !area && let Some(r) = look().replay.filter(|r| r.screen == output && r.sound == sound) {
        thread::spawn(move || {
            if let Err(e) = cli(&r.sock, &["start-replay-recording"]) {
                eprintln!("mp-shell: recording: {e}");
            }
        });
        return;
    }
    let spawn = move |target: &str| {
        let dir = folder();
        let _ = fs::create_dir_all(&dir);
        let file = dir.join(format!("Recording from {}.mp4", stamp()));
        let mut command: Vec<String> = ["gpu-screen-recorder", "-w", target, "-f", "60", "-k", "hevc_vulkan", "-v", "no"].map(String::from).into();
        if sound {
            command.extend(["-a".into(), "default_output".into()]);
        }
        command.extend(["-o".into(), file.to_string_lossy().into_owned()]);
        niri::act(json!({ "Spawn": { "command": command } }));
    };
    if !area {
        return spawn(output);
    }
    let hex = |c: Color, a: f32| {
        let [r, g, b, _] = c.into_rgba8();
        format!("#{r:02x}{g:02x}{b:02x}{:02x}", (a * 255.0).round() as u8)
    };
    let (dim, border) = (hex(frame, mp_ui::style::FADED), hex(accent, 1.0));
    thread::spawn(move || {
        let picked = Command::new("slurp").args(["-f", "%wx%h+%x+%y", "-b", &dim, "-c", &border]).stdin(Stdio::null()).stderr(Stdio::null()).output();
        if let Ok(out) = picked
            && out.status.success()
        {
            let area = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !area.is_empty() {
                spawn(&area);
            }
        }
    });
}

fn want_path() -> PathBuf {
    crate::apps::state("replay")
}

/// His replay choices: `on 30 mute DP-1`; none saved yet = on, 30 s, no sound, the
/// biggest screen.
pub fn want() -> Want {
    let text = fs::read_to_string(want_path()).unwrap_or_default();
    let mut w = text.split_whitespace();
    let (on, secs, sound, screen) = (w.next(), w.next().and_then(|s| s.parse().ok()), w.next(), w.next());
    Want {
        on: on != Some("off"),
        secs: secs.filter(|s| LENGTHS.contains(s)).unwrap_or(LENGTHS[0]),
        sound: sound == Some("sound"),
        screen: screen.map(String::from).unwrap_or_else(|| niri::screens().into_iter().max_by_key(|s| s.2).map(|s| s.0).unwrap_or_default()),
    }
}

/// Keeps his new choices, then brings the replay in line with them.
pub fn set_want(w: &Want) {
    let text = format!("{} {} {} {}\n", if w.on { "on" } else { "off" }, w.secs, if w.sound { "sound" } else { "mute" }, w.screen);
    let path = want_path();
    if let Err(e) = path.parent().map_or(Ok(()), fs::create_dir_all).and_then(|()| fs::write(&path, text)) {
        eprintln!("mp-shell: replay: {}: {e}", path.display());
    }
    thread::spawn(sync);
}

/// The last replay asked for, so a second look within `SETTLE` waits for it to show.
static ASKED: Mutex<Option<Instant>> = Mutex::new(None);

/// Brings the running replay in line with `want`: started when none runs, stopped
/// when Off, or swapped for a new one when a setting differs (the kept stretch goes
/// with the old one). Put off while a recording runs inside it: its stop calls this
/// again. Blocks: run it off the drawing thread.
pub fn sync() {
    let mut asked = ASKED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(left) = asked.map(|t| SETTLE.saturating_sub(t.elapsed())) {
        thread::sleep(left);
    }
    let w = want();
    let replays: Vec<Replay> = recorders().filter(|pid| fs::read_to_string(format!("/proc/{pid}/comm")).is_ok_and(|c| c.trim_end() == COMM)).filter_map(replay_of).collect();
    let fits = |r: &Replay| w.on && r.secs == w.secs && r.sound == w.sound && r.screen == w.screen;
    if replays.iter().any(|r| inside(r).is_some()) {
        return;
    }
    let mut kept = false;
    for r in &replays {
        if fits(r) && !kept {
            kept = true;
        } else {
            // In replay mode SIGINT ends it without saving.
            // SAFETY: a signal to a recorder's own pid, just read live.
            unsafe { libc::kill(r.pid, libc::SIGINT) };
        }
    }
    if w.on && !kept && !w.screen.is_empty() {
        let dir = folder();
        let _ = fs::create_dir_all(&dir);
        let (dir, sock) = (dir.to_string_lossy().into_owned(), runtime().join(format!("mp-replay-{}.sock", now_ms())).to_string_lossy().into_owned());
        let secs = w.secs.to_string();
        let mut command: Vec<String> = ["gpu-screen-recorder", "-w", &w.screen, "-f", "60", "-k", "hevc_vulkan", "-c", "mp4", "-r", &secs, "-ro", &dir, "-ipc", &sock, "-v", "no"].map(String::from).into();
        if w.sound {
            command.extend(["-a".into(), "default_output".into()]);
        }
        command.extend(["-o".into(), dir]);
        niri::act(json!({ "Spawn": { "command": command } }));
        *asked = Some(Instant::now());
    }
}

/// Saves what the replay keeps, then says so: the replay picture's check (`SAVED`) and
/// a notice with the clip's name, or a notice saying why there is none.
pub fn save() {
    thread::spawn(|| {
        let saved = match look().replay {
            None => Err("Instant replay is off.".to_string()),
            Some(r) => cli(&r.sock, &["save-replay"]).map(|path| rename(&path, "Clip")),
        };
        match saved {
            Ok(clip) => {
                SAVED.store(now_ms(), Relaxed);
                let name = clip.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                notices::post("Instant replay", "Clip saved", &name);
            }
            Err(e) => notices::post("Instant replay", "No clip saved", &e),
        }
    });
}

/// Where niri saves screenshots: its `screenshot-path`'s folder (his config), else
/// niri's default.
pub fn shots_folder() -> PathBuf {
    let home = apps::home();
    let config = std::env::var_os("NIRI_CONFIG").map(PathBuf::from).unwrap_or_else(|| apps::xdg("XDG_CONFIG_HOME", ".config").join("niri/config.kdl"));
    let set = fs::read_to_string(config).ok().and_then(|text| text.lines().map(str::trim).find_map(|l| l.strip_prefix("screenshot-path")).and_then(|v| v.trim().strip_prefix('"')?.split('"').next().map(String::from)));
    let path = set.map_or_else(|| home.join("Pictures/Screenshots/x"), |p| p.strip_prefix("~/").map_or_else(|| PathBuf::from(&p), |rest| home.join(rest)));
    path.parent().map_or(path.clone(), Path::to_path_buf)
}

/// Now, as niri's screenshot names: `2026-11-03 21-45-10`.
fn stamp() -> String {
    let t = clock::at((now_ms() / 1000) as i64).0;
    format!("{}-{:02}-{:02} {:02}-{:02}-{:02}", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec)
}

/// "1:05" (Windows' `clock`): hours only once there are any.
pub fn clock(ms: u64) -> String {
    let s = ms / 1000;
    let (h, m, sec) = (s / 3600, s / 60 % 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{sec:02}") } else { format!("{m}:{sec:02}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clocks() {
        assert_eq!(clock(0), "0:00");
        assert_eq!(clock(65_999), "1:05");
        assert_eq!(clock(3_661_000), "1:01:01");
    }

    #[test]
    fn filmed_holds_while_paused() {
        let live = Live { pid: 1, since: 1000, paused_ms: 200, paused_at: 0, inside: false };
        assert_eq!(live.filmed(5000), 3800);
        assert_eq!(Live { paused_at: 3000, ..live }.filmed(5000), 1800);
        // A clock set back: never below zero.
        assert_eq!(live.filmed(500), 0);
    }

    #[test]
    fn renames_as_niri_names_its_shots() {
        let dir = std::env::temp_dir().join(format!("mp-shell-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let from = dir.join("Replay_2026-11-04_13-12-43.mp4");
        fs::write(&from, b"").unwrap();
        let to = rename(from.to_str().unwrap(), "Clip");
        assert_eq!(to, dir.join("Clip from 2026-11-04 13-12-43.mp4"));
        assert!(to.exists() && !from.exists());
        // No `_` to cut at, or nothing to rename: the name it came with.
        assert_eq!(rename("/nowhere/plain.mp4", "Clip"), PathBuf::from("/nowhere/plain.mp4"));
        assert_eq!(rename("/nowhere/Replay_1.mp4", "Clip"), PathBuf::from("/nowhere/Replay_1.mp4"));
        fs::remove_dir_all(&dir).unwrap();
    }
}

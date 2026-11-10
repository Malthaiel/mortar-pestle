//! Songs not on this PC (M&P Library plan, step 5 piece C): played as they arrive
//! (his pick), never kept. A song's address (YouTube's own file, found by the makers'
//! yt-dlp) is handed over by the Library, which looks it up ahead; else it is looked
//! up here (~2 s). curl fetches it into `~/.cache/mp-player/` in 10 MiB ranges
//! (without a range, or with a bigger one, YouTube sends at about twice play speed,
//! chats 34 and 43), and the song is read while it comes. The folder is emptied when
//! the player starts and quits.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::os::fd::RawFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use symphonia::core::io::MediaSource;

use crate::Ask;

/// YouTube's Opus, the download's pick.
const FORMAT: &str = "bestaudio[ext=webm][acodec=opus]/bestaudio";
/// What a look-up prints, a line each; the Library hands over the same lines.
pub const PRINT: [&str; 5] = ["url", "duration", "id", "title", "%(channel,uploader)s"];
/// Bytes in before the song is opened: its head and a few seconds of sound, so the
/// playing thread never waits on the first read.
const START: u64 = 64 * 1024;
/// Bytes a song still arriving must hold unread before the playing thread decodes from
/// it (`Song::starved`): more than any one read of it asks for (an Opus packet is under
/// 2 KB), so that read never sleeps on the internet. About 1 s of YouTube's Opus.
pub const MARGIN: u64 = 16 * 1024;
/// YouTube sends a range of up to 10 MiB at full speed, a bigger one (or none) at about
/// twice play speed: a 1-hour song's 63.7 MB came in 1.7 s as 7 pieces, ~30 min as one
/// (chat 43). yt-dlp's own `http_chunk_size`.
const PIECE: u64 = 10 * 1024 * 1024;
/// Addresses a song gets before it can't be had: YouTube tags some (a trial since about
/// 2026-11-05, yt-dlp issue 17989: a pass token bound to the video) to give out only the
/// first ~1 MB without that token, so the first piece is refused (403); another look-up
/// mostly comes back untagged (5 of 6 for one song, 2026-11-10).
const TRIES: usize = 3;

/// A song's address and what YouTube calls it.
#[derive(Clone, Debug, Default)]
pub struct Found {
    pub url: String,
    pub length: Option<f64>,
    pub id: String,
    pub title: String,
    pub artist: String,
}

impl Found {
    pub fn parse(text: &str) -> Option<Found> {
        let mut lines = text.lines().map(str::trim);
        let url = lines.next().filter(|u| u.starts_with("http"))?.to_string();
        let length = lines.next()?.parse().ok();
        let mut next = || lines.next().filter(|l| *l != "NA").unwrap_or_default().to_string();
        Some(Found { url, length, id: next(), title: next(), artist: next() })
    }

    /// The address stops working at its `expire` (about 6 h after the look-up): one
    /// this close to it is looked up again.
    fn fresh(&self) -> bool {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        self.param("expire").is_some_and(|e| now + 600 < e)
    }

    /// A number in the address (`expire`, `clen`).
    fn param(&self, name: &str) -> Option<u64> {
        self.url.split(['?', '&']).find_map(|p| p.strip_prefix(name)?.strip_prefix('=')).and_then(|s| s.parse().ok())
    }

    /// The ranges curl asks for, `PIECE` each, by the file size the address holds
    /// (`clen`); without it, one for the whole file.
    fn pieces(&self) -> Vec<String> {
        let Some(size) = self.param("clen").filter(|&n| n > 0) else { return vec!["0-".into()] };
        (0..size).step_by(PIECE as usize).map(|a| format!("{a}-{}", (a + PIECE).min(size) - 1)).collect()
    }
}

/// A song on its way into the temporary folder.
#[derive(Clone, Debug)]
pub struct Fetched {
    pub path: PathBuf,
    /// curl is done: the file is whole (or as whole as it will get).
    pub done: Arc<AtomicBool>,
    /// How far into the file its reader is (`Growing`).
    pub read: Arc<AtomicU64>,
    pub found: Found,
    pub picture: Option<PathBuf>,
}

pub fn is_link(key: &str) -> bool {
    key.starts_with("https://") || key.starts_with("http://")
}

/// Where a song plays from: a link is its own, else the one `sources` keeps for it.
pub fn link(key: &str) -> Option<String> {
    if is_link(key) {
        return Some(key.into());
    }
    let lines = fs::read_to_string(crate::saved::library("sources")).ok()?;
    lines.lines().find_map(|l| l.split_once('\t').filter(|(k, _)| *k == key).map(|(_, url)| url.to_string()))
}

pub fn temp() -> PathBuf {
    let cache = std::env::var_os("XDG_CACHE_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| crate::saved::home().join(".cache"));
    cache.join("mp-player")
}

/// Empties the temporary folder (start, quit): played songs are not kept (his pick).
pub fn clear() {
    let _ = fs::remove_dir_all(temp());
}

/// A child that dies with the player. Its signals are unblocked first: it inherits the
/// player's SIGTERM / SIGINT block (they go to the signalfd), and the death signal
/// would wait blocked for good (chat 43: a curl outlived the player by 20 min).
fn child(cmd: &mut Command) -> &mut Command {
    // SAFETY: async-signal-safe calls only between fork and exec. The signal comes when
    // the thread that started it ends, and that thread waits for it first.
    unsafe {
        cmd.pre_exec(|| {
            let mut none: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut none);
            libc::sigprocmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        })
    }
}

fn look_up(link: &str) -> Option<Found> {
    let mut yt = Command::new("yt-dlp");
    yt.args(["--ignore-config", "-f", FORMAT, "--no-playlist"]);
    for p in PRINT {
        yt.args(["--print", p]);
    }
    let out = child(yt.arg("--").arg(link)).output().ok()?;
    if !out.status.success() {
        eprintln!("mp-player: yt-dlp {link}: {}", String::from_utf8_lossy(&out.stderr).trim().lines().last().unwrap_or_default());
    }
    Found::parse(&String::from_utf8_lossy(&out.stdout))
}

static FILES: AtomicU64 = AtomicU64::new(0);

/// curl fetching `found`'s pieces one after another into `path`; the first that fails
/// ends it, so no later piece lands in a gap's place.
fn pieces(found: &Found, path: &PathBuf) -> io::Result<Child> {
    let mut curl = Command::new("curl");
    curl.arg("--fail-early");
    for (i, range) in found.pieces().iter().enumerate() {
        if i > 0 {
            curl.arg("--next");
        }
        curl.args(["-sLf", "--connect-timeout", "10", "--speed-limit", "1024", "--speed-time", "15", "-r", range]).arg(&found.url);
    }
    File::create(path).and_then(|file| child(&mut curl).stdin(Stdio::null()).stdout(file).spawn())
}

/// Fetches the song `key` on a thread of its own (the address handed over while it is
/// good, else a look-up; a fresh look-up when YouTube refuses one, `TRIES` in all) and
/// tells the playing thread once its start is in, or that it can't be had. `picture`:
/// YouTube's picture too (the song has no album cover).
pub fn fetch(key: String, found: Option<Found>, picture: bool, asks: Sender<Ask>, wake: RawFd) {
    std::thread::spawn(move || {
        let tell = |got: Option<Fetched>| {
            let _ = asks.send(Ask::Fetched(key.clone(), got));
            let one = 1u64;
            // SAFETY: 8 readable bytes, what an eventfd write takes; `wake` stays open
            // for the life of the program.
            unsafe { libc::write(wake, (&raw const one).cast(), 8) };
        };
        let n = FILES.fetch_add(1, Ordering::Relaxed);
        let path = temp().join(format!("{n}.webm"));
        let _ = fs::create_dir_all(temp());
        let mut handed = found.filter(Found::fresh);
        // YouTube's 16:9 picture with no bars round it; jpeg, as the top bar reads.
        // Fetched once, on the first try, while the song's start comes.
        let mut shot: Option<Option<PathBuf>> = None;
        for _ in 0..TRIES {
            let Some(found) = handed.take().or_else(|| look_up(&link(&key)?)) else { break };
            let Ok(mut song) = pieces(&found, &path) else { break };
            let picture = shot
                .get_or_insert_with(|| {
                    picture.then(|| temp().join(format!("{n}.jpg"))).filter(|to| {
                        let url = format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", found.id);
                        child(Command::new("curl").args(["-sLf", "--max-time", "10", "-o"]).arg(to).arg(url)).status().is_ok_and(|s| s.success())
                    })
                })
                .clone();
            let ended = loop {
                if let Ok(Some(status)) = song.try_wait() {
                    break Some(status);
                }
                if fs::metadata(&path).is_ok_and(|m| m.len() >= START) {
                    break None;
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            if let Some(s) = ended.filter(|s| !s.success()) {
                eprintln!("mp-player: fetching {key}: curl {s}");
                continue;
            }
            let done = Arc::new(AtomicBool::new(ended.is_some()));
            let got = Fetched { path, done: done.clone(), read: Arc::default(), found, picture };
            tell(Some(got.clone()));
            if ended.is_none() {
                if let Ok(s) = song.wait()
                    && !s.success()
                {
                    eprintln!("mp-player: fetching {key}: curl {s}");
                }
                done.store(true, Ordering::Release);
                // Told again: a jump held for the whole song goes now (`Player::jump`).
                tell(Some(got));
            }
            return;
        }
        tell(None)
    });
}

/// The song file while curl writes it: a read at its end waits for more until curl is
/// done, so the song plays as it comes and a seek ahead waits for that part.
pub struct Growing {
    file: File,
    done: Arc<AtomicBool>,
    /// Where the next read starts, told to `Fetched::read`.
    read: Arc<AtomicU64>,
}

impl Growing {
    pub fn open(got: &Fetched) -> Option<Growing> {
        got.read.store(0, Ordering::Relaxed);
        Some(Growing { file: File::open(&got.path).ok()?, done: got.done.clone(), read: got.read.clone() })
    }
}

impl Read for Growing {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            // Done before the read: then the read sees every byte curl wrote.
            let done = self.done.load(Ordering::Acquire);
            let n = self.file.read(buf)?;
            if n > 0 || done || buf.is_empty() {
                self.read.fetch_add(n as u64, Ordering::Relaxed);
                return Ok(n);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Seek for Growing {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let at = self.file.seek(to)?;
        self.read.store(at, Ordering::Relaxed);
        Ok(at)
    }
}

impl MediaSource for Growing {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        self.done.load(Ordering::Acquire).then(|| self.file.metadata().ok().map(|m| m.len())).flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn found_reads_a_look_up() {
        let f = Found::parse("https://x/v?expire=99&clen=25000000&a=1\n212.5\nabc\nA title\nNA\n").unwrap();
        assert_eq!((f.length, f.id.as_str(), f.title.as_str(), f.artist.as_str()), (Some(212.5), "abc", "A title", ""));
        assert_eq!((f.param("expire"), f.param("clen"), f.param("len"), f.param("a")), (Some(99), Some(25_000_000), None, Some(1)));
        // Long past its `expire`.
        assert!(!f.fresh());
        // A length that isn't a number is no length; the lines after it may be missing.
        assert_eq!(Found::parse("http://x\nNA").unwrap().length, None);
        assert!(Found::parse("ERROR: gone\n1\n").is_none());
        assert!(Found::parse("https://x").is_none());
    }

    #[test]
    fn pieces_cover_the_file_with_no_gap() {
        let found = |url: &str| Found { url: url.into(), ..Default::default() };
        assert_eq!(found("https://x/v?clen=25000000").pieces(), ["0-10485759", "10485760-20971519", "20971520-24999999"]);
        assert_eq!(found("https://x/v?clen=10485760").pieces(), ["0-10485759"]);
        assert_eq!(found("https://x/v").pieces(), ["0-"]);
        assert_eq!(found("https://x/v?clen=0").pieces(), ["0-"]);
    }
}

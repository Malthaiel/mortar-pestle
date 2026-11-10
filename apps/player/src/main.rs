//! mp-player: plays songs from `~/Music` in the background (M&P Library plan, step 1).
//! It runs only while a song is loaded: the session bus starts it on the first call
//! (its `.service` file), it quits on Stop or at the end of the list. The Library window
//! and the shell's top bar control it over MPRIS (`bus.rs`).
//!
//! Two threads. This one plays: one `poll` over the sound server's socket, an eventfd
//! the bus thread rings after each request, and a signalfd for SIGTERM / SIGINT (saved,
//! then gone). The bus thread answers the bus and reads what this one shows. A song
//! not on this PC is fetched on a thread of its own and played as it arrives (`web.rs`).

mod bus;
mod out;
mod saved;
mod song;
mod web;

use std::collections::{HashMap, HashSet};
use std::os::fd::RawFd;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use out::{Heard, Out};
use saved::{Repeat, Spot};
use song::{Song, Tags};
use web::{Fetched, Found};

/// A listen is a song heard this long or more (his pick 2026-10-30, as Spotify).
const LISTEN_SECONDS: f64 = 30.0;

/// What the bus asks for.
pub enum Ask {
    Play,
    Pause,
    Toggle,
    Stop,
    Next,
    Previous,
    /// Seconds forward (or back).
    Seek(f64),
    /// To seconds in, if that song is still the one playing.
    Position(u64, f64),
    Volume(f64),
    Shuffle(bool),
    Repeat(Repeat),
    /// A new list of song keys, from this place in it, with the addresses the Library
    /// looked up ahead (the Library window's own call).
    Load(Vec<String>, usize, HashMap<String, Found>),
    /// Songs to add after the list, with their addresses (Send to Queue).
    Add(Vec<String>, HashMap<String, Found>),
    /// A name-only song of the list (the Library's stand-in key) has its link now, and
    /// its address when that was looked up too.
    Named(String, String, Option<Found>),
    /// A song not on this PC: its start is in, or it can't be had (`web.rs`).
    Fetched(String, Option<Fetched>),
}

/// The song shown is on its way from the internet: what it shows meanwhile, and how
/// `go` was asked for it (`base` holds the seconds in).
struct Wait {
    step: isize,
    cut: bool,
    tags: Tags,
}

/// What the bus shows, kept by this thread.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shown {
    pub playing: bool,
    pub tags: Option<Tags>,
    /// Counts up with every song change: the song's MPRIS track id.
    pub track: u64,
    pub volume: f64,
    pub shuffle: bool,
    pub repeat: Repeat,
    /// Seconds in, as of `since` (set while playing; later than now until the sound from
    /// `at` reaches the speakers).
    pub at: f64,
    pub since: Option<Instant>,
}

impl Shown {
    pub fn position(&self) -> f64 {
        self.at + self.since.map_or(0.0, |s| s.elapsed().as_secs_f64())
    }
}

pub static SHOWN: Mutex<Option<Shown>> = Mutex::new(None);

pub fn shown() -> Shown {
    SHOWN.lock().unwrap().clone().unwrap_or_default()
}

struct Player {
    out: Out,
    notices: zruntime::mpmc::Sender<bus::Notice>,
    /// For the fetching threads: where they tell, and the bell they ring.
    asks: Sender<Ask>,
    wake: RawFd,
    /// Songs not on this PC: addresses handed over, songs in the temporary folder,
    /// those on their way, those that couldn't be had (since the last Load), and the
    /// one waited for.
    found: HashMap<String, Found>,
    fetched: HashMap<String, Fetched>,
    fetching: HashSet<String>,
    failed: HashSet<String>,
    waiting: Option<Wait>,
    list: Vec<String>,
    /// Play order: places in `list`; shuffled once when shuffle goes on, so going back
    /// goes back the same way.
    order: Vec<usize>,
    /// Place in `order`.
    at: usize,
    song: Option<Song>,
    playing: bool,
    volume: f64,
    shuffle: bool,
    repeat: Repeat,
    track: u64,
    /// Decoded and not yet sent, as little-endian f32.
    pending: Vec<u8>,
    samples: Vec<f32>,
    /// Seconds in at the last open or seek, and frames sent since.
    base: f64,
    /// A jump ahead into a song still arriving, held until all of it is in (`jump`):
    /// nothing plays meanwhile and the clock waits at the spot.
    held: Option<f64>,
    sent: u64,
    /// Frames of this song sent, less what seeks and skips dropped: what was heard, for
    /// the listens.
    heard: u64,
    /// The song ran out and a drain is in flight: before a song with another rate, or
    /// at the end of the list.
    ending: bool,
    done: bool,
    /// Songs that ran out in a row since the last sound decoded (`ended`).
    silent: usize,
    /// The song is still arriving and too little of it is in to decode without waiting
    /// on the internet (`fill`): the main loop asks again every `STARVED_MS`.
    starved: bool,
    /// Told to play since it started: a call that only reads (it starts the player too)
    /// doesn't keep it here.
    played: bool,
}

impl Player {
    fn key(&self) -> Option<&str> {
        self.order.get(self.at).and_then(|&i| self.list.get(i)).map(String::as_str)
    }

    /// Seconds of sound sent since `base`, less what is still on its way to the speakers:
    /// below zero until the first of it is heard.
    fn since_base(&self) -> f64 {
        self.song.as_ref().map_or(0.0, |s| self.sent as f64 / s.rate as f64) - self.out.ahead
    }

    /// Seconds in, as heard.
    fn position(&self) -> f64 {
        self.base + self.since_base().max(0.0)
    }

    /// Frames sent since `base` and not heard yet: what a seek or a skip drops.
    fn unheard(&self) -> u64 {
        self.song.as_ref().map_or(0, |s| self.sent.min((self.out.ahead * s.rate as f64) as u64))
    }

    fn show(&self, seeked: bool) {
        let shown = Shown {
            playing: self.playing,
            tags: self.song.as_ref().map(|s| s.tags.clone()).or_else(|| self.waiting.as_ref().map(|w| w.tags.clone())),
            track: self.track,
            volume: self.volume,
            shuffle: self.shuffle,
            repeat: self.repeat,
            at: self.position(),
            // The clock starts with the sound (his pick for a song on its way).
            since: (self.playing && self.song.is_some() && self.held.is_none()).then(|| Instant::now() + Duration::from_secs_f64((-self.since_base()).max(0.0))),
        };
        *SHOWN.lock().unwrap() = Some(shown);
        let _ = self.notices.try_send(if seeked { bus::Notice::Seeked } else { bus::Notice::Changed });
    }

    fn save(&self) {
        let Some(&current) = self.order.get(self.at) else { return };
        let order = if self.shuffle { self.order.clone() } else { Vec::new() };
        saved::save(&Spot { list: self.list.clone(), order, current, seconds: self.position(), volume: self.volume, shuffle: self.shuffle, repeat: self.repeat });
    }

    /// The song is left: a listen if it was heard long enough. `cut`: the sound still on
    /// its way is dropped (a skip, a quit), so it was never heard.
    fn leave(&mut self, cut: bool) {
        if cut {
            self.heard = self.heard.saturating_sub(self.unheard());
        }
        let heard = self.song.as_ref().map_or(0.0, |s| self.heard as f64 / s.rate as f64);
        if heard >= LISTEN_SECONDS
            && let Some(key) = self.key()
        {
            saved::listened(heard, key);
        }
        self.heard = 0;
    }

    /// Opens the song at `place` in the play order, or the next one that opens going
    /// `step` (unavailable songs skipped); `seconds` in. `cut` drops the sound still
    /// waiting (a skip); without it the old song plays out first (one song into the next).
    fn go(&mut self, place: usize, step: isize, seconds: f64, cut: bool) -> bool {
        let n = self.order.len() as isize;
        for i in 0..n {
            let at = place as isize + step * i;
            // Past either end the search goes round only when the list repeats.
            if !(0..n).contains(&at) && self.repeat != Repeat::Playlist {
                break;
            }
            let p = at.rem_euclid(n) as usize;
            let Some(key) = self.list.get(self.order[p]).cloned() else { continue };
            let song = Song::open(&key).or_else(|| Song::open_web(&key, self.fetched.get(&key)?));
            let Some(song) = song else {
                // Not on this PC: fetched, then played as it arrives.
                if self.fetched.contains_key(&key) || self.failed.contains(&key) || web::link(&key).is_none() {
                    continue;
                }
                self.wait(p, step, seconds, cut, &key);
                return true;
            };
            if song.channels > 2 {
                eprintln!("mp-player: {}: more than 2 channels", song.tags.path.display());
                continue;
            }
            self.at = p;
            self.sent = 0;
            self.track += 1;
            if cut {
                self.pending.clear();
                self.out.flush();
            }
            let (rate, channels) = (song.rate, song.channels);
            self.song = Some(song);
            if seconds > 0.0 {
                self.jump(seconds);
            } else {
                (self.base, self.held) = (0.0, None);
            }
            if self.out.stream.is_some_and(|s| s.rate != rate || s.channels != channels) {
                if cut {
                    self.out.open(rate, channels, self.volume, !self.playing);
                } else {
                    // The old song plays out, then the stream is remade (`Drained`).
                    self.ending = self.out.drain();
                }
            } else if self.playing {
                self.out.open(rate, channels, self.volume, false);
            }
            self.waiting = None;
            self.save();
            self.show(false);
            self.ahead();
            return true;
        }
        self.song = None;
        self.waiting = None;
        false
    }

    /// The song at `place` is on its way from the internet: shown at once with its
    /// place's names at `seconds`, heard when it arrives (his pick: the pill moves, no
    /// words). `go` is asked again then.
    fn wait(&mut self, place: usize, step: isize, seconds: f64, cut: bool, key: &str) {
        (self.at, self.base, self.sent, self.held) = (place, seconds.max(0.0), 0, None);
        self.track += 1;
        if cut {
            self.pending.clear();
            self.out.flush();
        }
        self.song = None;
        self.waiting = Some(Wait { step, cut, tags: song::web_tags(key, self.found.get(key), None) });
        self.fetch(key);
        self.save();
        self.show(false);
    }

    /// Fetches a song not on this PC, unless it is in or on its way. YouTube's picture
    /// comes too when no album cover is on this PC for it.
    fn fetch(&mut self, key: &str) {
        if self.fetched.contains_key(key) || !self.fetching.insert(key.into()) {
            return;
        }
        let picture = web::is_link(key) || song::cover(&song::music().join(key)).is_none();
        web::fetch(key.into(), self.found.get(key).cloned(), picture, self.asks.clone(), self.wake);
    }

    /// The song playing is still arriving from the internet.
    fn coming(&self) -> bool {
        let (Some(song), Some(key)) = (self.song.as_ref(), self.key()) else { return false };
        self.fetched.get(key).is_some_and(|f| f.path == song.tags.path && !f.done.load(Ordering::Acquire))
    }

    /// Jumps to `seconds` in. A jump past what has been read, in a song still arriving,
    /// is held until all of it is in (`Ask::Fetched` comes again then): the jump reads
    /// up to the spot, and this thread must never wait on the internet (chat 43: a jump
    /// 5 min into a 1-hour song left it deaf and silent for 2.5 min).
    fn jump(&mut self, seconds: f64) {
        let ahead = self.song.as_ref().is_some_and(|s| seconds > s.at) && self.coming();
        self.held = ahead.then_some(seconds);
        self.base = match self.song.as_mut() {
            Some(song) if !ahead => song.seek(seconds),
            _ => seconds,
        };
    }

    /// The next song, when it is off the internet, fetched while this one plays.
    fn ahead(&mut self) {
        let next = if self.repeat == Repeat::Track { None } else { self.step(1) };
        let Some(key) = next.and_then(|p| self.order.get(p)).and_then(|&i| self.list.get(i)).cloned() else { return };
        if !self.failed.contains(&key) && !song::on_disk(&key) && web::link(&key).is_some() {
            self.fetch(&key);
        }
    }

    /// The place after (or before) this one, as repeat says; none past the end.
    fn step(&self, by: isize) -> Option<usize> {
        step(self.at, self.order.len(), self.repeat, by)
    }

    /// The list played out: the next Play starts it over from its first song (his pick
    /// 2026-11-09, as Spotify; it was the last song again).
    fn rewind(&mut self) {
        (self.at, self.base, self.song) = (0, 0.0, None);
    }

    /// The song ran out on its own.
    fn ended(&mut self) {
        self.leave(false);
        // A file that opens but holds no sound runs out at once: the one song on repeat,
        // or a whole pass of such a list, would turn here for good (each turn saving and
        // telling the bus).
        self.silent += 1;
        let spun = self.silent > if self.repeat == Repeat::Track { 1 } else { self.order.len() };
        let next = match self.repeat {
            _ if spun => None,
            Repeat::Track => Some(self.at),
            _ => self.step(1),
        };
        if next.is_none_or(|p| !self.go(p, 1, 0.0, false)) {
            // The end of the list: let the last sound play, then quit (`Drained`).
            self.rewind();
            self.ending = self.out.drain();
            self.done = !self.ending;
        }
    }

    /// Sends what the stream is owed, decoding as needed.
    fn fill(&mut self) {
        self.starved = false;
        while self.pending.len() < self.out.owed && !self.ending && !self.done && self.held.is_none() {
            let Some(song) = self.song.as_mut() else { break };
            // This thread never waits on the internet: a read past what has arrived
            // sleeps until curl gives up (15 s of dead buttons on a dropped connection).
            self.starved = song.starved();
            if self.starved {
                break;
            }
            if song.next(&mut self.samples) {
                self.silent = 0;
                self.pending.extend(self.samples.iter().flat_map(|s| s.to_le_bytes()));
            } else {
                self.ended();
            }
        }
        let Some(stream) = self.out.stream else { return };
        let frame = 4 * stream.channels as usize;
        let n = self.out.owed.min(self.pending.len()) / frame * frame;
        if n > 0 {
            self.out.write(&self.pending[..n]);
            self.pending.drain(..n);
            self.sent += (n / frame) as u64;
            self.heard += (n / frame) as u64;
        }
    }

    fn play(&mut self) {
        if self.song.is_none() && self.waiting.is_none() && (self.order.is_empty() || !self.go(self.at, 1, 0.0, true)) {
            return;
        }
        self.playing = true;
        let Some(s) = self.song.as_ref() else {
            // On its way: it plays when it arrives.
            return self.show(false);
        };
        let (rate, channels) = (s.rate, s.channels);
        self.out.open(rate, channels, self.volume, false);
        self.out.cork(false);
        self.fill();
        self.show(false);
    }

    fn pause(&mut self) {
        self.playing = false;
        self.out.cork(true);
        self.save();
        self.show(false);
    }

    fn seek(&mut self, seconds: f64) {
        if self.waiting.is_some() {
            self.base = seconds.max(0.0);
            return self.show(true);
        }
        let Some(length) = self.song.as_ref().map(|s| s.tags.length) else { return };
        if length.is_some_and(|l| seconds >= l) {
            return self.answer(Ask::Next);
        }
        self.heard = self.heard.saturating_sub(self.unheard());
        self.jump(seconds);
        self.sent = 0;
        self.pending.clear();
        self.out.flush();
        self.show(true);
    }

    fn answer(&mut self, ask: Ask) {
        match ask {
            Ask::Play => self.play(),
            Ask::Pause => self.pause(),
            Ask::Toggle if self.playing => self.pause(),
            Ask::Toggle => self.play(),
            Ask::Stop => self.done = true,
            Ask::Next | Ask::Previous => {
                let by = if matches!(ask, Ask::Next) { 1 } else { -1 };
                self.leave(true);
                match self.step(by) {
                    Some(p) if self.go(p, by, 0.0, true) => {}
                    _ => {
                        self.rewind();
                        self.done = true;
                    }
                }
            }
            Ask::Seek(by) => self.seek(self.position() + by),
            Ask::Position(track, to) if track == self.track => self.seek(to),
            Ask::Position(..) => {}
            Ask::Volume(v) => {
                self.volume = v.clamp(0.0, 1.0);
                self.out.volume(self.volume);
                self.show(false);
            }
            Ask::Shuffle(on) => {
                let current = self.order.get(self.at).copied().unwrap_or(0);
                self.shuffle = on;
                self.order = order(self.list.len(), on.then_some(current));
                self.at = self.order.iter().position(|&i| i == current).unwrap_or(0);
                self.save();
                self.show(false);
            }
            Ask::Repeat(r) => {
                self.repeat = r;
                self.save();
                self.show(false);
            }
            Ask::Fetched(key, got) => {
                self.fetching.remove(&key);
                match got {
                    Some(got) => _ = self.fetched.insert(key.clone(), got),
                    None => _ = self.failed.insert(key.clone()),
                }
                // The song waited for: its sound now, or the next one (as a missing file).
                if self.waiting.is_some() && self.key() == Some(key.as_str()) {
                    let w = self.waiting.take().unwrap();
                    if !self.go(self.at, w.step, self.base, w.cut) {
                        self.done = true;
                    } else if self.song.is_some() {
                        if self.playing {
                            self.fill();
                        }
                        // The top bar re-reads the position: its clock starts now.
                        self.show(true);
                    }
                }
                // A jump held for the whole song: it is in now.
                if let Some(seconds) = self.held
                    && !self.coming()
                {
                    self.jump(seconds);
                    if self.playing {
                        self.fill();
                    }
                    self.show(true);
                }
            }
            Ask::Load(list, start, found) => {
                self.leave(true);
                // The list before and its spot: back in place when no song of the new
                // list opens, so the saved spot is not written over by a list that can't
                // play (a call with made-up songs did that to his, 2026-11-09).
                let seconds = self.position();
                let before = (std::mem::replace(&mut self.list, list), std::mem::take(&mut self.order), self.at);
                (self.found, self.failed) = (found, HashSet::new());
                let start = start.min(self.list.len().saturating_sub(1));
                self.order = order(self.list.len(), self.shuffle.then_some(start));
                self.playing = true;
                let place = self.order.iter().position(|&i| i == start).unwrap_or(0);
                if !self.go(place, 1, 0.0, true) {
                    (self.list, self.order, self.at) = before;
                    (self.base, self.playing, self.done) = (seconds, false, true);
                } else {
                    // A stream paused before stays paused through `go` (it changes the
                    // song, not that): a new list plays.
                    self.out.cork(false);
                }
            }
            Ask::Add(songs, found) => {
                // After the list, in play order too (shuffled or not): nothing playing
                // changes; with nothing loaded they wait in the saved list for Play.
                let n = self.list.len();
                self.found.extend(found);
                self.list.extend(songs);
                self.order.extend(n..self.list.len());
                self.save();
                // The next song may now be one of these, off the internet.
                if self.song.is_some() {
                    self.ahead();
                }
            }
            Ask::Named(was, link, found) => {
                let mut hit = false;
                for key in self.list.iter_mut().filter(|k| **k == was) {
                    *key = link.clone();
                    hit = true;
                }
                if hit {
                    self.found.extend(found.map(|f| (link, f)));
                    self.save();
                    // The next song may be this one.
                    if self.song.is_some() {
                        self.ahead();
                    }
                }
            }
        }
    }
}

/// The place `by` after (or before) `at` among `n`, as `repeat` says; none past the end.
fn step(at: usize, n: usize, repeat: Repeat, by: isize) -> Option<usize> {
    let (next, n) = (at as isize + by, n as isize);
    match next {
        _ if (0..n).contains(&next) => Some(next as usize),
        _ if repeat == Repeat::Playlist && n > 0 => Some(next.rem_euclid(n) as usize),
        _ if by < 0 => Some(0),
        _ => None,
    }
}

/// How often a song that ran ahead of its own arrival is asked again (`Player::starved`).
const STARVED_MS: i32 = 10;

/// Play order for `n` songs: list order, or shuffled with `first` first.
fn order(n: usize, first: Option<usize>) -> Vec<usize> {
    let mut order: Vec<usize> = (0..n).collect();
    let Some(first) = first.filter(|&f| f < n) else { return order };
    order.swap(0, first);
    // xorshift, seeded by the clock: no random crate for one shuffle.
    let mut x = SystemTime::now().duration_since(UNIX_EPOCH).map_or(1, |d| d.as_nanos() as u64) | 1;
    for i in (2..n).rev() {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        order.swap(i, 1 + (x % i as u64) as usize);
    }
    order
}

fn main() {
    // SIGTERM / SIGINT come to the poll below, on every thread's mask before the bus
    // thread starts.
    // SAFETY: `set` is a zeroed sigset_t that sigemptyset then fills before any call
    // reads it; the calls take no other memory of ours.
    let sig = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        libc::signalfd(-1, &set, libc::SFD_CLOEXEC)
    };
    // SAFETY: eventfd takes no memory of ours.
    let wake = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC) };
    if sig < 0 || wake < 0 {
        // Without the bell no button would ever be heard.
        return eprintln!("mp-player: signalfd / eventfd: {}", std::io::Error::last_os_error());
    }
    let out = match Out::connect() {
        Ok(o) => o,
        Err(e) => return eprintln!("mp-player: sound server: {e}"),
    };
    let (asks, asked) = mpsc::channel();
    let (notices, noticed) = zruntime::mpmc::unbounded();
    // The name first: a second player must end before it touches what the first one
    // holds (its songs on their way, its saved spot).
    if !bus::start(asks.clone(), wake, noticed) {
        return;
    }
    // Songs fetched by the last run, if it didn't get to empty its folder.
    web::clear();
    let mut p = Player {
        out,
        notices,
        asks,
        wake,
        found: HashMap::new(),
        fetched: HashMap::new(),
        fetching: HashSet::new(),
        failed: HashSet::new(),
        waiting: None,
        list: Vec::new(),
        order: Vec::new(),
        at: 0,
        song: None,
        playing: false,
        volume: 1.0,
        shuffle: false,
        repeat: Repeat::None,
        track: 0,
        pending: Vec::new(),
        samples: Vec::new(),
        base: 0.0,
        held: None,
        sent: 0,
        heard: 0,
        ending: false,
        done: false,
        silent: 0,
        starved: false,
        played: false,
    };
    // The last spot, loaded paused: a cold Play resumes it.
    if let Some(spot) = saved::load() {
        p.order = if spot.shuffle && spot.order.len() == spot.list.len() { spot.order } else { (0..spot.list.len()).collect() };
        p.list = spot.list;
        (p.volume, p.shuffle, p.repeat) = (spot.volume, spot.shuffle, spot.repeat);
        let place = p.order.iter().position(|&i| i == spot.current).unwrap_or(0);
        p.go(place, 1, spot.seconds, true);
    }
    p.show(false);

    let started = Instant::now();
    let mut fds = [p.out.fd(), wake, sig].map(|fd| libc::pollfd { fd, events: libc::POLLIN, revents: 0 });
    while !p.done {
        // Nothing loaded, or nothing asked to play yet: wait a little for the call that
        // started us, then go.
        p.played |= p.playing;
        let idle = (p.song.is_none() && p.waiting.is_none() || !p.played) && !p.ending;
        let wait = match idle {
            true => 5000u128.saturating_sub(started.elapsed().as_millis()) as i32,
            false if p.starved && p.playing => STARVED_MS,
            false => -1,
        };
        // Cleared every turn, polled or not: a turn that skips the poll (a message already
        // read in) must not read the bell again, which waits for good when nothing rang
        // (chat 43: clicks answered one at a time, the speakers never fed).
        fds.iter_mut().for_each(|f| f.revents = 0);
        if !p.out.waiting() {
            // SAFETY: `fds` is a live array of `fds.len()` pollfds for the whole call.
            let n = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as _, wait) };
            if n == 0 && idle {
                break;
            }
        }
        if p.starved && p.playing {
            p.fill();
        }
        if fds[2].revents != 0 {
            break;
        }
        if fds[1].revents != 0 {
            let mut count = 0u64;
            // SAFETY: `count` is 8 writable bytes, what an eventfd read fills.
            unsafe { libc::read(wake, (&raw mut count).cast(), 8) };
            while let Ok(ask) = asked.try_recv() {
                p.answer(ask);
            }
        }
        if p.out.waiting() || fds[0].revents != 0 {
            match p.out.read() {
                Ok(Heard::Wants) if p.playing => p.fill(),
                // The clock waits for the speakers' delay too.
                Ok(Heard::Timed) => p.show(false),
                // The server ended or refused the stream: shown paused, not "playing" in
                // silence; Play makes a new one.
                Ok(Heard::Killed) => p.pause(),
                Ok(Heard::Drained) if p.done || p.song.is_none() && p.waiting.is_none() => break,
                Ok(Heard::Drained) => {
                    // One song into the next with another rate: a new stream for it (a
                    // song on its way makes its own when it arrives).
                    p.ending = false;
                    if let Some(s) = p.song.as_ref() {
                        let (rate, channels) = (s.rate, s.channels);
                        p.out.close();
                        p.out.open(rate, channels, p.volume, !p.playing);
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("mp-player: sound server: {e}");
                    break;
                }
            }
        }
    }
    p.leave(true);
    p.save();
    web::clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_holds_every_song_once_with_the_first_first() {
        assert_eq!(order(4, None), [0, 1, 2, 3]);
        assert_eq!(order(0, Some(0)), [0usize; 0]);
        // A first past the end: list order.
        assert_eq!(order(3, Some(3)), [0, 1, 2]);
        for first in [0, 7, 49] {
            let mut o = order(50, Some(first));
            assert_eq!(o[0], first);
            o.sort_unstable();
            assert_eq!(o, (0..50).collect::<Vec<_>>());
        }
    }

    #[test]
    fn step_follows_repeat() {
        assert_eq!(step(1, 3, Repeat::None, 1), Some(2));
        assert_eq!(step(2, 3, Repeat::None, 1), None);
        assert_eq!(step(2, 3, Repeat::Track, 1), None);
        assert_eq!(step(2, 3, Repeat::Playlist, 1), Some(0));
        assert_eq!(step(0, 3, Repeat::Playlist, -1), Some(2));
        // Back from the first song: the first song again.
        assert_eq!(step(0, 3, Repeat::None, -1), Some(0));
        assert_eq!(step(0, 0, Repeat::Playlist, 1), None);
    }
}

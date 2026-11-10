//! The player on the session bus: MPRIS (`org.mpris.MediaPlayer2` + `.Player`, the
//! shared "now playing" line the top bar, media keys and any MPRIS tool use) and two
//! calls of our own for the Library window: play this list from song N, and add these
//! songs after it. zbus on its own
//! one-thread runtime; requests go to the playing thread, its changes come back as
//! notices and go out as `PropertiesChanged`.

use std::collections::HashMap;
use std::os::fd::RawFd;
use std::sync::mpsc::{self, Sender};
use std::thread;

use zbus::object_server::SignalEmitter;
use zbus::{ObjectPath, OwnedVariant, Variant};

use crate::saved::Repeat;
use crate::{Ask, SHOWN, shown};

pub const NAME: &str = "org.mpris.MediaPlayer2.mp_player";
const PATH: &str = "/org/mpris/MediaPlayer2";

pub enum Notice {
    Changed,
    Seeked,
}

#[derive(Clone)]
struct Asker {
    asks: Sender<Ask>,
    wake: RawFd,
}

impl Asker {
    fn ask(&self, ask: Ask) {
        let _ = self.asks.send(ask);
        let one = 1u64;
        // SAFETY: 8 readable bytes, what an eventfd write takes; `wake` stays open for
        // the life of the program.
        unsafe { libc::write(self.wake, (&raw const one).cast(), 8) };
    }
}

/// Shows a change at once, before the playing thread takes it: zbus sends a set
/// property's new value as soon as the setter returns.
fn guess(change: impl FnOnce(&mut crate::Shown)) {
    if let Some(s) = SHOWN.lock().unwrap().as_mut() {
        change(s);
    }
}

fn micros(seconds: f64) -> i64 {
    (seconds * 1e6) as i64
}

fn track_id(track: u64) -> ObjectPath<'static> {
    ObjectPath::try_from(format!("/dev/malthaiel/MortarPestle/Track/{track}")).unwrap()
}

fn owned<'a>(v: impl Into<Variant<'a>>) -> OwnedVariant {
    v.into().try_to_owned().unwrap()
}

/// A file path as a `file://` address, unsafe bytes escaped.
fn file_url(path: &std::path::Path) -> String {
    let mut url = String::from("file://");
    for &b in path.as_os_str().as_encoded_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => url.push(b as char),
            _ => url.push_str(&format!("%{b:02X}")),
        }
    }
    url
}

struct Root(Asker);

#[zbus::interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    fn raise(&self) {}

    fn quit(&self) {
        self.0.ask(Ask::Stop);
    }

    #[zbus(property)]
    fn can_quit(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_raise(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn identity(&self) -> &str {
        "Music"
    }

    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<String> {
        Vec::new()
    }

    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<String> {
        Vec::new()
    }
}

struct Player(Asker);

#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    fn next(&self) {
        self.0.ask(Ask::Next);
    }

    fn previous(&self) {
        self.0.ask(Ask::Previous);
    }

    fn pause(&self) {
        self.0.ask(Ask::Pause);
    }

    fn play_pause(&self) {
        self.0.ask(Ask::Toggle);
    }

    fn stop(&self) {
        self.0.ask(Ask::Stop);
    }

    fn play(&self) {
        self.0.ask(Ask::Play);
    }

    fn seek(&self, offset: i64) {
        self.0.ask(Ask::Seek(offset as f64 / 1e6));
    }

    fn set_position(&self, track_id: ObjectPath<'_>, position: i64) {
        let track = track_id.rsplit('/').next().and_then(|n| n.parse().ok()).unwrap_or(u64::MAX);
        self.0.ask(Ask::Position(track, position as f64 / 1e6));
    }

    fn open_uri(&self, _uri: &str) {}

    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;

    #[zbus(property)]
    fn playback_status(&self) -> &str {
        let s = shown();
        match (s.playing, s.tags.is_some()) {
            (true, _) => "Playing",
            (false, true) => "Paused",
            _ => "Stopped",
        }
    }

    #[zbus(property)]
    fn loop_status(&self) -> &str {
        shown().repeat.word()
    }

    #[zbus(property)]
    fn set_loop_status(&self, word: &str) {
        if let Some(r) = Repeat::from_word(word) {
            guess(|s| s.repeat = r);
            self.0.ask(Ask::Repeat(r));
        }
    }

    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn set_rate(&self, _rate: f64) {}

    #[zbus(property)]
    fn shuffle(&self) -> bool {
        shown().shuffle
    }

    #[zbus(property)]
    fn set_shuffle(&self, on: bool) {
        guess(|s| s.shuffle = on);
        self.0.ask(Ask::Shuffle(on));
    }

    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedVariant> {
        let s = shown();
        let mut m = HashMap::new();
        m.insert("mpris:trackid".into(), owned(track_id(s.track)));
        let Some(t) = s.tags else { return m };
        m.insert("xesam:title".into(), owned(t.title.as_str()));
        if !t.artist.is_empty() {
            m.insert("xesam:artist".into(), owned(vec![t.artist.as_str()]));
        }
        if !t.album.is_empty() {
            m.insert("xesam:album".into(), owned(t.album.as_str()));
        }
        if let Some(l) = t.length {
            m.insert("mpris:length".into(), owned(micros(l)));
        }
        let url = t.link.clone().unwrap_or_else(|| file_url(&t.path));
        m.insert("xesam:url".into(), owned(url.as_str()));
        if let Some(cover) = &t.cover {
            m.insert("mpris:artUrl".into(), owned(file_url(cover).as_str()));
        }
        m
    }

    #[zbus(property)]
    fn volume(&self) -> f64 {
        shown().volume
    }

    #[zbus(property)]
    fn set_volume(&self, volume: f64) {
        guess(|s| s.volume = volume.clamp(0.0, 1.0));
        self.0.ask(Ask::Volume(volume));
    }

    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        micros(shown().position())
    }

    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }

    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_play(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_pause(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_seek(&self) -> bool {
        true
    }

    #[zbus(property(emits_changed_signal = "const"))]
    fn can_control(&self) -> bool {
        true
    }
}

/// Our own call: the MPRIS line has no "play this list".
struct Queue(Asker);

#[zbus::interface(name = "dev.malthaiel.MortarPestle.Queue")]
impl Queue {
    /// Plays these song keys (paths under ~/Music without the ending, or a web link)
    /// from `start`. `found`: for a song not on this PC, the address the Library looked
    /// up ahead (yt-dlp's `web::PRINT` lines), or empty; may be shorter than `songs`.
    fn play(&self, songs: Vec<String>, start: u32, found: Vec<String>) {
        let found = songs.iter().zip(found).filter_map(|(k, text)| Some((k.clone(), crate::web::Found::parse(&text)?))).collect();
        self.0.ask(Ask::Load(songs, start as usize, found));
    }

    /// Adds these song keys after the list playing (Windows' Send to Queue): nothing
    /// stops, nothing starts. `found` as `play`'s.
    fn add(&self, songs: Vec<String>, found: Vec<String>) {
        let found = songs.iter().zip(found).filter_map(|(k, text)| Some((k.clone(), crate::web::Found::parse(&text)?))).collect();
        self.0.ask(Ask::Add(songs, found));
    }

    /// A name-only song handed over earlier (`was`, the Library's stand-in key) is
    /// `link` from now on; `found` as `play`'s, for that one song.
    fn named(&self, was: String, link: String, found: String) {
        self.0.ask(Ask::Named(was, link, crate::web::Found::parse(&found)));
    }
}

/// Takes the player's name on the bus and serves it from a thread of its own. Waits for
/// the name: false when it can't be had (another player holds it, or no bus).
pub fn start(asks: Sender<Ask>, wake: RawFd, notices: zruntime::mpmc::Receiver<Notice>) -> bool {
    let asker = Asker { asks, wake };
    let (named, name) = mpsc::channel();
    thread::spawn(move || {
        // `named` is dropped after the error is printed: `start` returns only then.
        if let Err(e) = zbus::block_on(serve(asker, notices, &named)) {
            eprintln!("mp-player: session bus: {e}");
            // Without the bus nobody can reach the player: stop it.
            // SAFETY: a signal to ourselves; it takes no memory of ours.
            unsafe { libc::kill(libc::getpid(), libc::SIGTERM) };
        }
    });
    // An error before the name drops the sender.
    name.recv().is_ok()
}

async fn serve(asker: Asker, notices: zruntime::mpmc::Receiver<Notice>, named: &mpsc::Sender<()>) -> zbus::Result<()> {
    // zbus's default asks "take it, and let it be taken": a second start stole the
    // name (found in mp-files 2026-11-03). Neither: a second player stops (`start`).
    let conn =
        zbus::connection::Builder::session().allow_name_replacements(false).replace_existing_names(false).serve_at(PATH, Root(asker.clone())).serve_at(PATH, Player(asker.clone())).serve_at(PATH, Queue(asker)).name(NAME).build().await?;
    let _ = named.send(());
    let player = conn.object_server().interface::<_, Player>(PATH).await?;
    let mut last = shown();
    while let Ok(notice) = notices.recv().await {
        let now = shown();
        let (p, e) = (player.get().await, player.signal_emitter());
        if (now.playing, now.tags.is_some()) != (last.playing, last.tags.is_some()) {
            p.playback_status_changed(e).await?;
        }
        if now.track != last.track || now.tags != last.tags {
            p.metadata_changed(e).await?;
        }
        if now.volume != last.volume {
            p.volume_changed(e).await?;
        }
        if now.shuffle != last.shuffle {
            p.shuffle_changed(e).await?;
        }
        if now.repeat != last.repeat {
            p.loop_status_changed(e).await?;
        }
        if let Notice::Seeked = notice {
            Player::seeked(e, micros(now.position())).await?;
        }
        last = now;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_escapes_what_an_address_can_t_hold() {
        assert_eq!(file_url(std::path::Path::new("/home/a/Music/A B/01 é?#.mp3")), "file:///home/a/Music/A%20B/01%20%C3%A9%3F%23.mp3");
        assert_eq!(file_url(std::path::Path::new("/a-b_c.d~e/1")), "file:///a-b_c.d~e/1");
    }
}

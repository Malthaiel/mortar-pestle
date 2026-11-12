//! The song mp-player is on, read live for the album page's pill (Windows'
//! `TrackList` rests it on the playing song) and the main page's song, buttons and
//! seek bar (Music Tab Redesign step 3, the shell's old `mpris.rs` for one player:
//! the picker went with Firefox and Spotify). One connection on its own thread: the
//! player's name owner is asked first, so a closed player is never woken (a call to
//! its name would start it by bus activation); the buttons' asks go out on it too.

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;

use iced::Subscription;
use iced::futures::channel::mpsc;
use iced::futures::{SinkExt, StreamExt, stream};
use iced::time::Instant;
use zbus::message::{Flags, Type};
use zbus::{Connection, MatchRule, Message, MessageStream, ObjectPath, OwnedVariant, Variant};

use crate::music::library;

const OURS: &str = "org.mpris.MediaPlayer2.mp_player";
const PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Repeat {
    #[default]
    None,
    Track,
    Playlist,
}

/// The song (a key as `Artist/Album/NN Title`, or a YouTube song's link) and whether
/// it plays; none while the player is closed or has no song. `link`: where it plays
/// from when it comes off the internet. The rest as the player tells it (MPRIS).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Now {
    pub song: Option<String>,
    pub link: Option<String>,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// `xesam:url`: a song file's place (`file://`), where its words are kept, or its link.
    pub url: String,
    track: String,
    /// Seconds. The position as last read, at `at`, moving while it plays (MPRIS sends
    /// no position changes, only jumps: `Seeked`).
    pub length: f64,
    position: f64,
    at: Option<Instant>,
    pub shuffle: bool,
    pub repeat: Repeat,
    pub volume: f64,
}

impl Now {
    /// Where the song is at `now`, in seconds.
    pub fn position(&self, now: Instant) -> f64 {
        let ran = match (self.playing, self.at) {
            (true, Some(at)) => now.saturating_duration_since(at).as_secs_f64(),
            _ => 0.0,
        };
        let p = self.position + ran;
        if self.length > 0.0 { p.clamp(0.0, self.length) } else { p.max(0.0) }
    }

    /// A song loaded.
    pub fn loaded(&self) -> bool {
        self.song.is_some() || !self.title.is_empty()
    }
}

/// What the main page asks of the player.
#[derive(Debug, Clone, Copy)]
pub enum Command {
    /// Play or pause; with no player running it starts and picks up where it stopped.
    Toggle,
    Next,
    Previous,
    /// Seconds into the song.
    Seek(f64),
    Shuffle(bool),
    Repeat(Repeat),
    Volume(f64),
}

static COMMANDS: Mutex<Option<mpsc::UnboundedSender<Command>>> = Mutex::new(None);

pub fn send(command: Command) {
    if let Some(tx) = COMMANDS.lock().unwrap().as_ref() {
        let _ = tx.unbounded_send(command);
    }
}

pub fn events() -> Subscription<Now> {
    Subscription::run(|| {
        crate::listener(|tx| {
            // A bus error ends one run: begun again, or the box would be deaf to the
            // player until the strip restarts.
            while let Err(e) = zbus::block_on(run(tx.clone())) {
                eprintln!("mp-shell: music: now playing: {e}");
                thread::sleep(std::time::Duration::from_secs(5));
            }
        })
    })
}

enum Heard {
    Bus(zbus::Result<Message>),
    Ask(Command),
}

async fn run(mut out: mpsc::Sender<Now>) -> zbus::Result<()> {
    let conn = Connection::session().await?;
    let signal = |interface: &'static str, member: &'static str| MatchRule::builder().msg_type(Type::Signal).interface(interface).member(member);
    // Listening first, then the owner, so a start can't slip in between.
    let owners = signal("org.freedesktop.DBus", "NameOwnerChanged").sender("org.freedesktop.DBus").arg(0, OURS).build()?;
    let changes = signal(PROPERTIES, "PropertiesChanged").path(PATH).build()?;
    let seeks = signal(PLAYER, "Seeked").path(PATH).build()?;
    let mut streams = Vec::new();
    for rule in [owners, changes, seeks] {
        streams.push(MessageStream::for_match_rule(rule, &conn, None).await?);
    }
    let (tx, rx) = mpsc::unbounded();
    *COMMANDS.lock().unwrap() = Some(tx);
    let mut bus = stream::select(stream::select_all(streams).map(Heard::Bus), rx.map(Heard::Ask));

    let mut owner = conn.call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "GetNameOwner", &(OURS,)).await.ok().and_then(|reply| reply.body().deserialize::<String>().ok()).unwrap_or_default();
    let mut now = Now::default();
    if !owner.is_empty() {
        read(&conn, &owner, &mut now).await;
    }
    if out.send(now.clone()).await.is_err() {
        return Ok(());
    }

    while let Some(heard) = bus.next().await {
        let msg = match heard {
            Heard::Bus(Ok(msg)) => msg,
            Heard::Bus(Err(_)) => continue,
            Heard::Ask(c) => {
                if let Err(e) = ask(&conn, &now, c).await {
                    eprintln!("mp-shell: music: player: {e}");
                }
                continue;
            }
        };
        let was = now.clone();
        if !changed(&conn, &msg, &mut owner, &mut now).await || now == was {
            continue;
        }
        if out.send(now.clone()).await.is_err() {
            break;
        }
    }
    Ok(())
}

/// One signal; true if it was the player's.
async fn changed(conn: &Connection, msg: &Message, owner: &mut String, now: &mut Now) -> bool {
    let header = msg.header();
    match header.member().map(|m| m.as_str()) {
        Some("NameOwnerChanged") => {
            let Ok((_, _, new)) = msg.body().deserialize::<(String, String, String)>() else { return false };
            *owner = new;
            *now = Now::default();
            if !owner.is_empty() {
                read(conn, owner, now).await;
            }
            true
        }
        Some("PropertiesChanged") => {
            if owner.is_empty() || header.sender().map(|s| s.as_str()) != Some(owner.as_str()) {
                return false;
            }
            let Ok((_, props, _)) = msg.body().deserialize::<(String, HashMap<String, OwnedVariant>, Vec<String>)>() else { return false };
            apply(now, &props);
            // A new song or a pause: where it is now (the player sends no position).
            if ["Metadata", "PlaybackStatus"].iter().any(|k| props.contains_key(*k)) {
                reposition(conn, owner, now).await;
            }
            true
        }
        Some("Seeked") => {
            if owner.is_empty() || header.sender().map(|s| s.as_str()) != Some(owner.as_str()) {
                return false;
            }
            let Ok((us,)) = msg.body().deserialize::<(i64,)>() else { return false };
            (now.position, now.at) = (us as f64 / 1e6, Some(Instant::now()));
            true
        }
        _ => false,
    }
}

async fn reposition(conn: &Connection, owner: &str, now: &mut Now) {
    if let Ok(reply) = conn.call_method(Some(owner), PATH, Some(PROPERTIES), "Get", &(PLAYER, "Position")).await
        && let Ok(v) = reply.body().deserialize::<OwnedVariant>()
        && let Ok(us) = i64::try_from(v)
    {
        (now.position, now.at) = (us as f64 / 1e6, Some(Instant::now()));
    }
}

/// One ask, wanting no answer so a stuck player can't hold the thread. Only Play
/// starts a closed player (`Toggle` with nothing loaded); the rest leave it closed.
async fn ask(conn: &Connection, now: &Now, c: Command) -> zbus::Result<()> {
    let call = |interface: &'static str, method: &'static str, wake: bool| {
        let b = Message::method_call(PATH, method).destination(OURS).interface(interface).with_flags(Flags::NO_REPLY_EXPECTED);
        if wake { b } else { b.with_flags(Flags::NO_AUTO_START) }
    };
    let set = |key: &'static str, value: Variant<'static>| call(PROPERTIES, "Set", false).build(&(PLAYER, key, value));
    let msg = match c {
        Command::Toggle if !now.loaded() => call(PLAYER, "Play", true).build(&())?,
        Command::Toggle => call(PLAYER, "PlayPause", false).build(&())?,
        Command::Next => call(PLAYER, "Next", false).build(&())?,
        Command::Previous => call(PLAYER, "Previous", false).build(&())?,
        Command::Seek(to) => {
            let us = (to * 1e6) as i64;
            match ObjectPath::try_from(now.track.as_str()) {
                Ok(track) if !now.track.is_empty() => call(PLAYER, "SetPosition", false).build(&(track, us))?,
                // No track id: a jump by the difference instead.
                _ => call(PLAYER, "Seek", false).build(&(us - (now.position(Instant::now()) * 1e6) as i64,))?,
            }
        }
        Command::Shuffle(on) => set("Shuffle", Variant::from(on))?,
        Command::Repeat(r) => set(
            "LoopStatus",
            Variant::from(match r {
                Repeat::None => "None",
                Repeat::Track => "Track",
                Repeat::Playlist => "Playlist",
            }),
        )?,
        Command::Volume(v) => set("Volume", Variant::from(v.clamp(0.0, 1.0)))?,
    };
    conn.send(&msg).await
}

async fn read(conn: &Connection, owner: &str, now: &mut Now) {
    if let Ok(reply) = conn.call_method(Some(owner), PATH, Some(PROPERTIES), "GetAll", &(PLAYER,)).await
        && let Ok(props) = reply.body().deserialize::<HashMap<String, OwnedVariant>>()
    {
        apply(now, &props);
        now.at = Some(Instant::now());
    }
}

/// Seconds from microseconds sent signed or unsigned (players differ).
fn seconds(props: &HashMap<String, OwnedVariant>, key: &str) -> Option<f64> {
    get::<i64>(props, key).or_else(|| get::<u64>(props, key).map(|u| u as i64)).map(|us| us as f64 / 1e6)
}

fn get<T: TryFrom<OwnedVariant>>(props: &HashMap<String, OwnedVariant>, key: &str) -> Option<T> {
    props.get(key)?.try_clone().ok()?.try_into().ok()
}

fn apply(now: &mut Now, props: &HashMap<String, OwnedVariant>) {
    if let Some(v) = get::<String>(props, "PlaybackStatus") {
        now.playing = v == "Playing";
    }
    if let Some(m) = get::<HashMap<String, OwnedVariant>>(props, "Metadata") {
        let text = |k| get::<String>(&m, k).unwrap_or_default();
        let url = get::<String>(&m, "xesam:url");
        now.song = url.as_deref().and_then(key);
        now.link = url.clone().filter(|u| u.starts_with("http"));
        now.url = url.unwrap_or_default();
        now.title = text("xesam:title");
        now.artist = get::<Vec<String>>(&m, "xesam:artist").map(|a| a.join(", ")).unwrap_or_default();
        now.album = text("xesam:album");
        now.track = get::<ObjectPath>(&m, "mpris:trackid").map(|o| o.to_string()).unwrap_or_default();
        now.length = seconds(&m, "mpris:length").unwrap_or(0.0);
    }
    if let Some(p) = seconds(props, "Position") {
        now.position = p;
    }
    if let Some(v) = get(props, "Shuffle") {
        now.shuffle = v;
    }
    if let Some(v) = get::<String>(props, "LoopStatus") {
        now.repeat = match v.as_str() {
            "Track" => Repeat::Track,
            "Playlist" => Repeat::Playlist,
            _ => Repeat::None,
        };
    }
    if let Some(v) = get(props, "Volume") {
        now.volume = v;
    }
}

/// `file:///home/<you>/Music/Artist/Album/NN Title.opus` -> `Artist/Album/NN Title`.
/// A song streamed (the player shows its link): the song whose `sources` line has
/// that link, else the link itself (a YouTube song's key).
fn key(url: &str) -> Option<String> {
    if url.starts_with("http") {
        return Some(library::links().into_iter().find(|(_, u)| u == url).map_or_else(|| url.into(), |(k, _)| k));
    }
    let path = std::path::PathBuf::from(mp_ui::portal::unescape(url.strip_prefix("file://")?));
    let under = path.strip_prefix(library::music()).ok()?.with_extension("");
    Some(under.to_string_lossy().into_owned())
}

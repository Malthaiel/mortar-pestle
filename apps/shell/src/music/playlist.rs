//! Playlists (M&P Library plan, step 4): Downloaded Songs (his ask 2026-10-31: every
//! song in a `<channel>/Singles/` folder, read from the folders) and your own (files
//! in `playlists/`, piece A). Their tiles on the wall, behind the Albums / Playlists /
//! Both switch, and their page as Windows' `PlaylistDetail` (its `RecordPage`: the
//! tag "Playlist", the name, the fact line, the bar, numbered rows), the backdrop as
//! an album's when it has a picture: your own, else its first song's (Windows'
//! `CollageCover`). Your own playlist's name is typed in place on its page. Songs go
//! in and out through a menu (piece B): a right-click on any song row, the plus on a
//! hovered row, an album bar's Save to Playlist; Send to Queue hands songs to the
//! player after what plays. Your own playlist's rows are held and dragged into a new
//! order (piece C). A playlist comes in from a file (Import, piece D); its songs not
//! on this PC are downloaded, and sent to the bin once all are in (piece D). A page
//! builds its rows 50 at a time as it scrolls (Windows' `useColumnPages`, piece D).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use iced::widget::{Id, container, image, mouse_area, space, text_input};
use iced::{Color, Element, Length, Task, border, mouse};
use mp_ui::MEDIUM;

use mp_ui::style::{CORNER, LINE_TIGHT, TITLE};

use crate::music::download::{Job, Want};
use crate::music::library::{self, Album, Playlist, Row};
use crate::music::page;
use crate::music::release::{self, Track};
use crate::music::web::Video;
use crate::music::{Library, Look, Message, Place, download, import, now, off, web};

/// Downloaded Songs' name, and its tile's hover key (no album key lacks a '/').
pub const NAME: &str = "Downloaded Songs";
/// The heart list (Windows' `SAVED_TITLE`, found by its name): first on the wall,
/// a heart for a face, never deleted or renamed; made on the first save.
pub const SAVED: &str = "Saved Tracks";

pub fn is_saved(p: &Playlist) -> bool {
    p.name == SAVED
}
/// Rows whose addresses are looked up when a page opens (Windows' `streamCache`).
const AHEAD: usize = 30;
/// Name-only rows after the playing song whose links are found while it plays.
const NEXT: usize = 3;
/// Rows a page builds at a time, and how near the bottom of the view the end of
/// those built comes before the next are (Windows' `useColumnPages` and its
/// `useInView` margin, 250 px).
pub const ROWS: usize = 50;
pub const MORE: f32 = 250.0;

/// Your own playlist's download part (Windows' `PlaylistDetail`), now the cover's
/// menu: Download while songs are missing (failed or not), none while it downloads
/// or waits, Uninstall once every song is in.
pub enum Slot {
    Download,
    Busy,
    Uninstall,
    None,
}

/// A playlist's key on the wall (its hover, its face): its name after a '/', which
/// no album key (`Artist/Album`) or Downloaded Songs starts with.
pub fn tile_key(name: &str) -> String {
    format!("/{name}")
}

/// A name-only row's stand-in song while its link is looked for: starts with a tab,
/// which no song key holds (`sources` and `listens` are split on tabs).
fn named(r: &Row) -> String {
    format!("\t{}\t{}", r.artist, r.title)
}

pub fn is_named(key: &str) -> bool {
    key.starts_with('\t')
}

/// What the player takes for a row: from this PC when it is here; a name-only row
/// its stand-in until its link is found.
fn song_of(r: &Row) -> String {
    r.here.clone().or_else(|| r.key.clone()).or_else(|| r.link.clone()).unwrap_or_else(|| named(r))
}

/// Songs a menu or a bar button acts on (Save to Playlist, Send to Queue, Remove
/// from Playlist), read off the page when picked.
#[derive(Debug, Clone)]
pub enum Target {
    /// The open album's song at this place in its list (`album_songs`).
    Song(usize),
    /// The open album, every song (its bar).
    Album,
    /// A row of the playlist shown (Downloaded Songs or yours).
    Row(usize),
    /// The playlist shown, every row (its bar).
    Playlist,
    /// A search's YouTube song.
    Tube(Video),
    /// The song playing (the playing box's right-click).
    Playing,
}

/// A song picked: its row as a playlist keeps it, and what the player takes.
pub struct Pick {
    row: Row,
    song: String,
}

/// The id in a YouTube link (`watch?v=<id>`, `youtu.be/<id>`).
pub fn youtube_id(link: &str) -> Option<&str> {
    let id = link.split(['?', '&']).find_map(|p| p.strip_prefix("v=")).or_else(|| link.split_once("youtu.be/").map(|(_, rest)| rest))?;
    id.split(['&', '?', '#']).next().filter(|id| !id.is_empty())
}

pub fn name_id() -> Id {
    Id::new("playlist-name")
}

/// Where a playlist's picture comes from: a file here, or a YouTube song's picture.
#[derive(PartialEq)]
pub enum Pic {
    File(PathBuf),
    Tube(String),
}

impl Pic {
    /// The file, a YouTube picture fetched first (waits: off the window's thread).
    pub fn fetch(self) -> Option<PathBuf> {
        match self {
            Pic::File(path) => Some(path),
            Pic::Tube(id) => web::thumb(&id),
        }
    }

    /// The file when it is here already.
    fn kept(self) -> Option<PathBuf> {
        match self {
            Pic::File(path) => Some(path),
            Pic::Tube(id) => Some(web::thumb_at(&id)).filter(|p| p.is_file()),
        }
    }
}

/// A song on a playlist's page: what the player takes, its names, and the keys its
/// plays and the playing song are matched by (its key, its download, its link).
struct Entry<'a> {
    song: String,
    title: &'a str,
    artist: &'a str,
    length: Option<u32>,
    keys: Vec<String>,
}

impl Library {
    /// The playlist whose page shows.
    pub fn open_playlist(&self) -> Option<&Playlist> {
        let Place::Playlist(name) = &self.place else { return None };
        self.playlists.iter().find(|p| &p.name == name)
    }

    /// The open playlist when it may be renamed, given a picture or deleted: not
    /// Saved Tracks.
    pub fn open_own(&self) -> Option<&Playlist> {
        self.open_playlist().filter(|p| !is_saved(p))
    }

    /// Whether the wall shows Downloaded Songs' tile: as it would an album of that
    /// name with no status (his pick 2026-10-31).
    pub fn playlist_shown(&self) -> bool {
        let q = self.query.trim().to_lowercase();
        (q.is_empty() || NAME.to_lowercase().contains(&q)) && self.status.is_none() && self.files.is_none_or(|on| !self.downloaded.is_empty() == on)
    }

    /// Whether the wall shows one of yours: by its name; a status hides it (a
    /// playlist has none); Downloaded = a song of it on this PC.
    pub fn own_shown(&self, p: &Playlist) -> bool {
        let q = self.query.trim().to_lowercase();
        (q.is_empty() || p.name.to_lowercase().contains(&q)) && self.status.is_none() && self.files.is_none_or(|on| p.rows.iter().any(|r| r.here.is_some()) == on)
    }

    pub fn playlist_tile(&self) -> Element<'_, Message> {
        let side = self.side;
        let play = (!self.downloaded.is_empty()).then_some(Message::PlayPlaylist(None));
        self.card(NAME, self.square(side, Some(&self.pictures.youtube)), play, Message::Playlist(None), side)
    }

    pub fn own_tile<'a>(&'a self, p: &'a Playlist) -> Element<'a, Message> {
        let side = self.side;
        let key = tile_key(&p.name);
        let face = match self.covers.get(&key) {
            _ if is_saved(p) => self.square(side, Some(&self.pictures.heart)),
            Some(cover) => self.face(Some(cover), side),
            None => self.square(side, None),
        };
        let play = (!p.rows.is_empty()).then(|| Message::PlayPlaylist(Some(p.name.clone())));
        self.card(&key, self.with_bar(face, &key, side), play, Message::Playlist(Some(p.name.clone())), side)
    }

    /// A playlist's picture: your own, else its first song's (its album's cover, or
    /// YouTube's picture of it); Saved Tracks has none, its heart is its face.
    pub fn playlist_picture(&self, p: &Playlist) -> Option<Pic> {
        if is_saved(p) {
            return None;
        }
        if let Some(cover) = &p.cover {
            return Some(Pic::File(cover.clone()));
        }
        let first = p.rows.first()?;
        let key = first.here.as_ref().or(first.key.as_ref());
        let album = key.and_then(|k| k.rsplit_once('/')).and_then(|(dir, _)| self.albums.iter().find(|a| a.key == dir));
        if let Some(cover) = album.and_then(|a| a.cover.clone()) {
            return Some(Pic::File(cover));
        }
        let link = first.link.clone().or_else(|| key.and_then(|k| self.link_of(k)))?;
        youtube_id(&link).map(|id| Pic::Tube(id.into()))
    }

    /// The page's picture as a file here: the open album's cover, or the open
    /// playlist's picture once fetched. Keyed as its art is.
    pub fn picture(&self) -> Option<(String, PathBuf)> {
        match &self.place {
            Place::Album(_) => self.open_album().and_then(|a| Some((a.key.clone(), a.cover.clone()?))),
            Place::Playlist(_) => self.open_playlist().and_then(|p| Some((tile_key(&p.name), self.playlist_picture(p)?.kept()?))),
            _ => None,
        }
    }

    /// Your playlists' faces not asked for yet, cut as the wall's covers; YouTube
    /// pictures fetched first, kept for the next time.
    pub fn faces(&mut self) -> Task<Message> {
        let side = self.side;
        let wanted: Vec<(String, Pic)> = self.playlists.iter().filter_map(|p| Some((tile_key(&p.name), self.playlist_picture(p)?))).filter(|(key, _)| !self.facing.contains(key)).collect();
        if wanted.is_empty() {
            return Task::none();
        }
        self.facing.extend(wanted.iter().map(|(key, _)| key.clone()));
        let cut = move || wanted.into_iter().filter_map(|(key, pic)| Some((key, mp_ui::cover::square(&std::fs::read(pic.fetch()?).ok()?, side as u32)?))).collect();
        off(cut, |c| Message::Covers(c.unwrap_or_default()))
    }

    /// A playlist's face changed (a new picture, a new name, gone): asked for again.
    pub fn forget_face(&mut self, name: &str) {
        let key = tile_key(name);
        self.covers.remove(&key);
        self.facing.remove(&key);
        if self.art.as_ref().is_some_and(|art| art.key == key) {
            self.art = None;
        }
    }

    /// Downloaded Songs' songs (`None`) or a playlist's, in order; the keys their
    /// plays and the playing song are matched by only for the first `keyed` (those
    /// built: an import may hold thousands), and only the first `upto` of them (a
    /// page draws those built, not a copy of every row's song on every draw).
    fn entries<'a>(&'a self, list: Option<&'a Playlist>, keyed: usize, upto: usize) -> Vec<Entry<'a>> {
        match list {
            None => {
                self.downloaded.iter().take(upto).enumerate().map(|(i, s)| Entry { song: s.key.clone(), title: &s.title, artist: &s.artist, length: s.length, keys: if i < keyed { self.keys(&[Some(&s.key)]) } else { Vec::new() } }).collect()
            }
            Some(p) => p.rows.iter().take(upto).enumerate().map(|(i, r)| Entry { keys: if i < keyed { self.row_keys(r) } else { Vec::new() }, song: song_of(r), title: &r.title, artist: &r.artist, length: r.length }).collect(),
        }
    }

    /// A song's keys, each with its link: what its plays, the playing song and a
    /// playlist's rows are matched by.
    fn keys(&self, own: &[Option<&String>]) -> Vec<String> {
        let mut keys: Vec<String> = Vec::new();
        for k in own.iter().flatten() {
            for k in [Some((*k).clone()), self.link_of(k)].into_iter().flatten() {
                if !keys.contains(&k) {
                    keys.push(k);
                }
            }
        }
        keys
    }

    /// A row's keys (its key, its link, its download); a name-only row's names stand in.
    fn row_keys(&self, r: &Row) -> Vec<String> {
        let keys = self.keys(&[r.here.as_ref(), r.key.as_ref(), r.link.as_ref()]);
        if keys.is_empty() { vec![named(r)] } else { keys }
    }

    /// The songs a target names, as rows and as the player takes them.
    pub fn picks(&self, t: &Target) -> Vec<Pick> {
        match t {
            Target::Song(i) => self.album_picks().into_iter().nth(*i).into_iter().collect(),
            Target::Album => self.album_picks(),
            Target::Row(i) => self.list_picks().into_iter().nth(*i).into_iter().collect(),
            Target::Playlist => self.list_picks(),
            // A link row (the plan's), played from this PC once downloaded.
            Target::Tube(v) => {
                let link = web::watch(&v.id);
                let here = self.have.contains(&v.id).then(|| download::single_key(v));
                let row = Row { key: None, link: Some(link.clone()), title: v.title.clone(), artist: v.channel.clone(), length: v.length, here: here.clone() };
                vec![Pick { row, song: here.unwrap_or(link) }]
            }
            // A key row (as an album's song) or a link row (as a YouTube song's).
            Target::Playing => {
                let Some(song) = self.now.song.clone() else { return Vec::new() };
                let web = song.starts_with("http");
                let length = (self.now.length > 0.0).then(|| self.now.length.round() as u32);
                let row = Row { key: (!web).then(|| song.clone()), link: web.then(|| song.clone()), title: self.now.title.clone(), artist: self.now.artist.clone(), length, here: None };
                vec![Pick { row, song }]
            }
        }
    }

    /// The open album's songs as key rows (on this PC or not: a download gives a song
    /// that key), named by its list.
    fn album_picks(&self) -> Vec<Pick> {
        let Some(a) = self.open_album() else { return Vec::new() };
        let tracks = self.release(a).map_or(&[][..], |r| &r.tracks);
        let pick = |(i, key): (usize, String)| {
            let t = tracks.get(i);
            let row = Row { key: Some(key.clone()), link: None, title: t.map(|t| t.title.clone()).unwrap_or_default(), artist: t.map_or_else(|| a.artist.clone(), |t| t.artist.clone()), length: t.and_then(|t| t.length), here: None };
            Pick { row, song: key }
        };
        self.album_songs(a).into_iter().enumerate().map(pick).collect()
    }

    /// The playlist shown as rows: yours as they are, Downloaded Songs' as keys.
    fn list_picks(&self) -> Vec<Pick> {
        if let Some(p) = self.open_playlist() {
            return p.rows.iter().map(|r| Pick { song: song_of(r), row: r.clone() }).collect();
        }
        if self.place != Place::Downloaded {
            return Vec::new();
        }
        let pick = |s: &library::Song| Pick { row: Row { key: Some(s.key.clone()), link: None, title: s.title.clone(), artist: s.artist.clone(), length: s.length, here: Some(s.key.clone()) }, song: s.key.clone() };
        self.downloaded.iter().map(pick).collect()
    }

    /// Whether the playlist holds every one of the songs: a menu's check.
    pub fn holds(&self, p: &Playlist, picks: &[Pick]) -> bool {
        let rows: Vec<Vec<String>> = p.rows.iter().map(|r| self.row_keys(r)).collect();
        !picks.is_empty() && picks.iter().all(|pk| self.row_keys(&pk.row).iter().any(|k| rows.iter().any(|r| r.contains(k))))
    }

    /// A playlist picked in a menu (his pick): holding them all, they come out (every
    /// row of them); else those it lacks go in at its end.
    pub fn save_to(&mut self, name: &str) -> Task<Message> {
        let picks = self.target.as_ref().map(|t| self.picks(t)).unwrap_or_default();
        let Some(mut p) = self.playlists.iter().find(|p| p.name == name).cloned() else { return Task::none() };
        let before = self.playlist_picture(&p);
        let picked: Vec<Vec<String>> = picks.iter().map(|pk| self.row_keys(&pk.row)).collect();
        let rows: Vec<Vec<String>> = p.rows.iter().map(|r| self.row_keys(r)).collect();
        let meets = |a: &[String], b: &[String]| a.iter().any(|k| b.contains(k));
        if self.holds(&p, &picks) {
            let mut keep = rows.iter().map(|r| !picked.iter().any(|k| meets(k, r)));
            p.rows.retain(|_| keep.next().unwrap_or(true));
        } else {
            let lacking = picks.into_iter().zip(&picked).filter(|(_, k)| !rows.iter().any(|r| meets(k, r)));
            p.rows.extend(lacking.map(|(pk, _)| pk.row));
        }
        library::save_playlist(&p);
        self.playlist_changed(name, before)
    }

    /// A new playlist holding `rows` (none from the wall's plus), its page opened with
    /// the name ready to type.
    pub fn new_playlist(&mut self, rows: Vec<Row>) -> Task<Message> {
        match library::new_playlist("New Playlist") {
            Ok(name) => {
                if !rows.is_empty() {
                    library::save_playlist(&Playlist { name: name.clone(), rows, cover: None, added: SystemTime::now() });
                }
                self.playlists = library::playlists(&self.links);
                let go = self.go(Place::Playlist(name.clone()));
                Task::batch([go, self.start_naming(name)])
            }
            Err(e) => {
                eprintln!("mp-shell: music: a new playlist: {e}");
                Task::none()
            }
        }
    }

    /// New Playlist in a song's menu: made with the songs in it.
    pub fn save_new(&mut self) -> Task<Message> {
        let rows = self.target.as_ref().map(|t| self.picks(t)).unwrap_or_default().into_iter().map(|pk| pk.row).collect();
        self.new_playlist(rows)
    }

    /// Remove from Playlist: the open playlist's row at `i`.
    pub fn unlist(&mut self, i: usize) -> Task<Message> {
        let Some(mut p) = self.open_playlist().cloned().filter(|p| i < p.rows.len()) else { return Task::none() };
        let before = self.playlist_picture(&p);
        p.rows.remove(i);
        library::save_playlist(&p);
        self.playlist_changed(&p.name, before)
    }

    /// A row of the open playlist dragged to another place (his ask on Windows
    /// 2026-10-18): saved in that order.
    pub fn move_row(&mut self, from: usize, to: usize) -> Task<Message> {
        let Some(mut p) = self.open_playlist().cloned().filter(|p| from != to && from < p.rows.len() && to < p.rows.len()) else { return Task::none() };
        let before = self.playlist_picture(&p);
        let row = p.rows.remove(from);
        p.rows.insert(to, row);
        library::save_playlist(&p);
        self.playlist_changed(&p.name, before)
    }

    /// Send to Queue: the songs after the list playing, nothing stopping (his pick),
    /// with the addresses looked up ahead. A name-only row has no link for the player
    /// to find yet: it is looked for first, and it and the songs after it wait for it,
    /// so the order holds (his ask, chat 39).
    pub fn send(&mut self, t: &Target) -> Task<Message> {
        let picks = self.picks(t);
        let mut looks: Vec<Look> = Vec::new();
        for pk in picks.iter().filter(|pk| is_named(&pk.song)) {
            let key = &pk.song;
            if !self.looking.contains(key) && !self.gone(key) && !self.looks.iter().chain(&looks).any(|l| &l.key == key) {
                looks.push(self.look_of(&pk.row));
            }
        }
        self.sending.extend(picks.into_iter().map(|pk| pk.song));
        for l in looks.into_iter().rev() {
            self.looks.push_front(l);
        }
        self.flush_send();
        self.look()
    }

    /// Hands the player the songs waiting to be sent, in order, up to the first
    /// name-only row still looked for; one whose link wasn't found is left out.
    pub fn flush_send(&mut self) {
        let mut ready = Vec::new();
        while let Some(song) = self.sending.front() {
            if is_named(song) && !self.gone(song) {
                break;
            }
            let song = self.sending.pop_front().unwrap_or_default();
            if !is_named(&song) {
                ready.push(song);
            }
        }
        if !ready.is_empty() {
            let found = self.addresses_of(&ready);
            library::queue(ready, found);
        }
    }

    /// A playlist's rows were written: read again; its face asked for again only when
    /// its picture's source moved (its first song changed).
    fn playlist_changed(&mut self, name: &str, before: Option<Pic>) -> Task<Message> {
        self.playlists = library::playlists(&self.links);
        if self.playlists.iter().find(|p| p.name == name).and_then(|p| self.playlist_picture(p)) != before {
            self.forget_face(name);
        }
        let mut tasks = vec![self.faces(), self.cut_art()];
        if self.open_playlist().is_some_and(|p| p.name == name) {
            tasks.push(self.look_playlist());
            tasks.push(self.want_row_pics());
        }
        Task::batch(tasks)
    }

    /// A playlist row's picture (his ask 2026-11-06): its album's cover as the wall cut
    /// it, else YouTube's picture of it (`row_pics`); and the YouTube id to fetch when
    /// that isn't asked for yet. Only built rows have the keys to tell.
    fn row_pic(&self, e: &Entry) -> (Option<&image::Handle>, Option<String>) {
        let album = e.keys.iter().filter(|k| !k.starts_with("http")).find_map(|k| self.album_of(k));
        if let Some(cover) = album.and_then(|a| self.covers.get(&a.key)) {
            return (Some(cover), None);
        }
        let Some(id) = e.keys.iter().find_map(|k| youtube_id(k)) else { return (None, None) };
        match self.row_pics.get(id) {
            Some(pic) => (pic.as_ref(), None),
            None => (None, Some(id.to_string())),
        }
    }

    /// The row's cover, `ROW_COVER` square: the wall's covers drawn smaller, so every
    /// one's corner is theirs scaled (YouTube's cut to match); none, a Raised square.
    fn row_cover(&self, pic: Option<&image::Handle>) -> Element<'_, Message> {
        let side = page::ROW_COVER;
        match pic {
            Some(p) => image(p.clone()).width(side).height(side).into(),
            None => {
                let (c, corner) = (self.colours, self.row_corner());
                container(space()).width(side).height(side).style(move |_| container::Style { background: Some(c.raised.into()), border: border::rounded(corner), ..Default::default() }).into()
            }
        }
    }

    /// The wall's corner at a row cover's size.
    fn row_corner(&self) -> f32 {
        CORNER * page::ROW_COVER / self.side.max(1.0)
    }

    /// Fetches the pictures the playlist shown's built rows lack, four lots at once
    /// (each a YouTube picture's fetch, ~0.1-0.3 s, then kept on this PC), each cut
    /// once and kept small while the strip runs.
    pub fn want_row_pics(&mut self) -> Task<Message> {
        let list = match &self.place {
            Place::Downloaded => None,
            Place::Playlist(_) => match self.open_playlist() {
                Some(p) => Some(p),
                None => return Task::none(),
            },
            _ => return Task::none(),
        };
        let mut ids: Vec<String> = self.entries(list, self.built, self.built).iter().filter_map(|e| self.row_pic(e).1).collect();
        ids.sort();
        ids.dedup();
        if ids.is_empty() {
            return Task::none();
        }
        for id in &ids {
            self.row_pics.insert(id.clone(), None);
        }
        let corner = self.row_corner();
        let lots = ids.len().div_ceil(4);
        let tasks = ids.chunks(lots).map(|lot| {
            let lot = lot.to_vec();
            let cut = move || {
                lot.into_iter()
                    .map(|id| {
                        let pic = web::thumb(&id).and_then(|p| std::fs::read(p).ok()).and_then(|data| mp_ui::cover::square_file(&data, page::ROW_COVER as u32, corner));
                        (id, pic)
                    })
                    .collect()
            };
            off(cut, |pics| Message::RowPics(pics.unwrap_or_default()))
        });
        Task::batch(tasks)
    }

    /// Whether the song `now` (a key or a link, as the player shows it) is this one.
    fn is_now(&self, e: &Entry, now: Option<&String>) -> bool {
        now.is_some_and(|now| e.keys.contains(now) || self.link_of(now).is_some_and(|l| e.keys.contains(&l)))
    }

    /// What Play hands the player for Downloaded Songs (`None`) or a playlist.
    pub fn playlist_songs(&self, name: Option<&str>) -> Vec<String> {
        let list = name.and_then(|n| self.playlists.iter().find(|p| p.name == n));
        if name.is_some() && list.is_none() {
            return Vec::new();
        }
        self.entries(list, 0, usize::MAX).into_iter().map(|e| e.song).collect()
    }

    /// A row on the page shown: pauses or resumes it when it plays, else plays the
    /// playlist from it.
    pub fn playlist_song(&mut self, i: usize) -> Task<Message> {
        let list = self.open_playlist();
        let entries = self.entries(list, i + 1, usize::MAX);
        let Some(e) = entries.get(i) else { return Task::none() };
        if self.is_now(e, self.now.song.as_ref()) {
            now::send(now::Command::Toggle);
            return Task::none();
        }
        let songs = entries.into_iter().map(|e| e.song).collect();
        self.play(songs, i)
    }

    /// The open playlist's first rows not on this PC, looked up ahead (Windows'
    /// `streamCache`, the first 30): a name-only row's link found by its names first.
    pub fn look_playlist(&mut self) -> Task<Message> {
        let Some(p) = self.open_playlist() else { return Task::none() };
        let looks = p.rows.iter().filter(|r| r.here.is_none()).take(AHEAD).map(|r| self.look_of(r)).collect();
        self.look_ahead(looks)
    }

    /// A row's look-up: its link (its own, or `sources`' for its key), else its names
    /// to find one by.
    fn look_of(&self, r: &Row) -> Look {
        let link = r.link.clone().or_else(|| r.key.as_ref().and_then(|k| self.link_of(k)));
        let find = (link.is_none() && r.key.is_none()).then(|| (r.artist.clone(), Track { recording: String::new(), disc: 1, n: 0, title: r.title.clone(), artist: r.artist.clone(), lead: String::new(), length: r.length }));
        Look { key: r.key.clone().or_else(|| r.link.clone()).unwrap_or_else(|| named(r)), link, find }
    }

    /// A name-only song's look-up, by its stand-in: the first row of those names.
    pub fn named_look(&self, stand_in: &str) -> Option<Look> {
        self.playlists.iter().flat_map(|p| &p.rows).find(|r| r.key.is_none() && r.link.is_none() && named(r) == stand_in).map(|r| self.look_of(r))
    }

    /// The next name-only rows after the playing song, in the first playlist that holds
    /// both, looked up while it plays: the player skips a song with no link, and the
    /// page's look-ahead stops at its first rows (243 of his 273 imported songs never
    /// played, Fable Sweep H1). Added to the look-ups waiting, never in their place.
    pub fn look_next(&mut self) -> Task<Message> {
        let Some(now) = self.now.song.as_ref() else { return Task::none() };
        let is_now = |r: &Row| [&r.here, &r.key, &r.link].into_iter().flatten().any(|k| k == now || self.now.link.as_ref() == Some(k));
        let name_only = |r: &&Row| r.key.is_none() && r.link.is_none();
        let next = self.playlists.iter().find_map(|p| {
            let after = &p.rows[p.rows.iter().position(is_now)? + 1..];
            let next: Vec<Look> = after.iter().filter(name_only).take(NEXT).map(|r| self.look_of(r)).collect();
            (!next.is_empty()).then_some(next)
        });
        for l in next.unwrap_or_default() {
            if !self.looking.contains(&l.key) && !self.gone(&l.key) && !self.looks.iter().any(|w| w.key == l.key) {
                self.looks.push_back(l);
            }
        }
        self.look()
    }

    /// A name-only row's link was found (Windows' `music-stream-picked`): kept in
    /// every row of those names, which plays by it from now on.
    pub fn found_named(&mut self, stand_in: &str, link: &str) {
        let mut changed = Vec::new();
        for p in &mut self.playlists {
            let mut hit = false;
            for r in p.rows.iter_mut().filter(|r| r.key.is_none() && r.link.is_none()) {
                if named(r) == stand_in {
                    r.link = Some(link.into());
                    hit = true;
                }
            }
            if hit {
                crate::music::library::save_playlist(p);
                changed.push(p.name.clone());
            }
        }
        for name in changed {
            self.forget_face(&name);
        }
        if let Some((songs, _)) = self.pending.as_mut() {
            for s in songs.iter_mut().filter(|s| s.as_str() == stand_in) {
                *s = link.into();
            }
        }
        for s in self.sending.iter_mut().filter(|s| s.as_str() == stand_in) {
            *s = link.into();
        }
    }

    /// The page's rows: every row built once the end of those built nears the
    /// bottom of the view, the next 50 (Windows' `useColumnPages`).
    pub fn more_rows(&mut self) {
        let rows = match &self.place {
            Place::Downloaded => self.downloaded.len(),
            Place::Playlist(_) => self.open_playlist().map_or(0, |p| p.rows.len()),
            _ => 0,
        };
        if self.built < rows {
            self.built += ROWS;
        }
    }

    /// Import (piece D): a playlist from a `.csv` or `.txt` file, named after it, its
    /// page opened. A song already on this PC by its artist and name comes in as that
    /// song (his ask, chat 41); the rest by name, their links found when they play
    /// or are looked up ahead.
    pub fn import(&mut self, path: &Path) -> Task<Message> {
        let songs = import::read(path);
        if songs.is_empty() {
            eprintln!("mp-shell: music: {}: no songs found in it", path.display());
            return Task::none();
        }
        let here = self.songs_here();
        let row = |s: import::Song| {
            let key = here.get(&(web::plain(&s.artist), web::plain(&s.title))).cloned();
            Row { here: key.clone(), key, link: None, title: s.title, artist: s.artist, length: s.length }
        };
        let rows = songs.into_iter().map(row).collect();
        match library::new_playlist(&import::name(path)) {
            Ok(name) => {
                library::save_playlist(&Playlist { name: name.clone(), rows, cover: None, added: SystemTime::now() });
                self.playlists = library::playlists(&self.links);
                self.go(Place::Playlist(name))
            }
            Err(e) => {
                eprintln!("mp-shell: music: importing {}: {e}", path.display());
                Task::none()
            }
        }
    }

    /// Every song on this PC by its squashed artist and name: your albums' (their
    /// artist, the file's name without its number), then Downloaded Songs'.
    fn songs_here(&self) -> HashMap<(String, String), String> {
        let mut here = HashMap::new();
        for a in &self.albums {
            for k in &a.songs {
                here.entry((web::plain(&a.artist), web::plain(library::bare(k.rsplit('/').next().unwrap_or(k))))).or_insert_with(|| k.clone());
            }
        }
        for s in &self.downloaded {
            here.entry((web::plain(&s.artist), web::plain(&s.title))).or_insert_with(|| s.key.clone());
        }
        here
    }

    /// One of your albums holding the song `key`.
    fn album_of(&self, key: &str) -> Option<&Album> {
        let (dir, _) = key.rsplit_once('/')?;
        self.albums.iter().find(|a| a.key == dir)
    }

    /// Where a row not on this PC downloads to, its key: a song of one of your albums
    /// into that album (Windows' song Download: that album's job for the song); a
    /// Downloaded Song back to its place; any other on its own into Downloaded Songs
    /// (his pick, chat 37).
    fn dest(&self, r: &Row) -> (Option<&Album>, String) {
        if let Some(key) = &r.key {
            if let Some(a) = self.album_of(key).filter(|_| library::place(key).is_some()) {
                return (Some(a), key.clone());
            }
            if key.rsplit_once('/').is_some_and(|(dir, _)| dir.ends_with("/Singles")) {
                return (None, key.clone());
            }
        }
        (None, download::alone_key(&r.artist, &r.title))
    }

    /// Whether Uninstall Playlist sends the row's song to the bin: on this PC and able
    /// to come back, by a link or as one of your albums' (Windows': a song with
    /// neither stays, its row could never play again).
    fn comes_back(&self, r: &Row) -> bool {
        r.here.as_ref().is_some_and(|here| r.link.is_some() || self.link_of(here).is_some() || r.key.as_ref().is_some_and(|k| self.link_of(k).is_some()) || self.album_of(here).is_some())
    }

    pub fn slot(&self, p: &Playlist) -> Slot {
        let key = tile_key(&p.name);
        if self.loading.as_ref().is_some_and(|f| f.key == key) || self.queue.contains(&key) {
            return Slot::Busy;
        }
        if p.rows.iter().any(|r| r.here.is_none()) {
            return Slot::Download;
        }
        if p.rows.iter().any(|r| self.comes_back(r)) { Slot::Uninstall } else { Slot::None }
    }

    /// Download Playlist (piece D): its songs not on this PC, those in the bin back
    /// first (his call 2026-10-31), the rest waiting their turn behind any album.
    pub fn download_playlist(&mut self) -> Task<Message> {
        let Some(p) = self.open_playlist() else { return Task::none() };
        let key = tile_key(&p.name);
        if self.loading.as_ref().is_some_and(|f| f.key == key) || self.queue.contains(&key) {
            return Task::none();
        }
        let wanted: Vec<String> = p.rows.iter().filter(|r| r.here.is_none()).map(|r| self.dest(r).1).collect();
        let back = library::restore_songs(&wanted);
        if !back.is_empty() {
            self.landed(&back);
        }
        if self.open_playlist().is_some_and(|p| p.rows.iter().any(|r| r.here.is_none())) {
            self.failed.remove(&key);
            self.queue.push_back(key);
            return self.start();
        }
        Task::none()
    }

    /// What a playlist's download fetches: each song not on this PC once, an album's
    /// in a job for that album (its details from its song list when kept), the rest
    /// in one job of songs on their own.
    pub fn playlist_jobs(&mut self, name: &str) -> Vec<Job> {
        let lists: Vec<String> = match self.playlists.iter().find(|p| p.name == name) {
            Some(p) => p.rows.iter().filter(|r| r.here.is_none()).filter_map(|r| self.dest(r).0).map(|a| a.release.clone()).filter(|id| !id.is_empty() && !self.releases.contains_key(id)).collect(),
            None => return Vec::new(),
        };
        for id in lists {
            if let Some(r) = release::saved(&id) {
                self.releases.insert(id, r);
            }
        }
        let Some(p) = self.playlists.iter().find(|p| p.name == name) else { return Vec::new() };
        let mut jobs: Vec<Job> = Vec::new();
        let mut alone = Job { key: String::new(), artist: String::new(), album: String::new(), year: 0, several: false, alone: true, songs: Vec::new() };
        let mut seen = HashSet::new();
        for r in p.rows.iter().filter(|r| r.here.is_none()) {
            let (album, key) = self.dest(r);
            if !seen.insert(key.clone()) {
                continue;
            }
            let saved = r.link.clone().or_else(|| r.key.as_ref().and_then(|k| self.link_of(k)));
            let mut track = Track { recording: String::new(), disc: 1, n: 0, title: r.title.clone(), artist: r.artist.clone(), lead: String::new(), length: r.length };
            let Some(a) = album else {
                alone.songs.push(Want { track, name: key, saved });
                continue;
            };
            let (disc, n) = library::place(&key).unwrap_or((1, 0));
            match self.release(a).and_then(|list| list.tracks.iter().find(|t| (t.disc, t.n) == (disc, n))) {
                Some(t) => track = t.clone(),
                None => (track.disc, track.n) = (disc, n),
            }
            let name = key.rsplit('/').next().unwrap_or_default().to_string();
            let several = name.split(' ').next().is_some_and(|n| n.contains('-'));
            let want = Want { track, name, saved };
            match jobs.iter_mut().find(|j| j.key == a.key) {
                Some(j) => j.songs.push(want),
                None => jobs.push(Job { key: a.key.clone(), artist: a.artist.clone(), album: a.title.clone(), year: a.year, several, alone: false, songs: vec![want] }),
            }
        }
        jobs.push(alone);
        jobs
    }

    /// A song of a playlist's download came (piece D): the rows it is for that had
    /// no link to find it by keep it (a name-only row in its row, as a look-up
    /// finding it; an internet album's song in `sources` under its own key), and it
    /// lands.
    pub fn playlist_got(&mut self, name: &str, song: &str, url: &str) -> Task<Message> {
        let rows: Vec<Row> = self.playlists.iter().find(|p| p.name == name).map(|p| p.rows.iter().filter(|r| r.here.is_none() && self.dest(r).1 == song).cloned().collect()).unwrap_or_default();
        for r in &rows {
            match &r.key {
                None if r.link.is_none() => self.found_named(&named(r), url),
                Some(k) if k != song && self.link_of(k).is_none() => library::link(k, url),
                _ => {}
            }
        }
        self.links = library::links();
        self.landed(&[song.to_string()]);
        self.faces()
    }

    /// Songs that came onto this PC (downloaded, or back from the bin): into their
    /// albums; Downloaded Songs and the playlists read again.
    fn landed(&mut self, keys: &[String]) {
        for key in keys {
            if let Some((dir, _)) = key.rsplit_once('/')
                && let Some(a) = self.albums.iter_mut().find(|a| a.key == dir)
                && !a.songs.contains(key)
            {
                a.songs.push(key.clone());
                a.songs.sort();
            }
        }
        self.downloaded = library::downloaded();
        self.playlists = library::playlists(&self.links);
    }

    /// Uninstall Playlist (Windows'): once every song is in, those that can come back
    /// go to the bin, an album's too; every row stays and plays off the internet. No
    /// asking, the bin is the undo (his pick for albums, 2026-10-31).
    pub fn uninstall_playlist(&mut self) {
        let Some(p) = self.open_playlist() else { return };
        let key = tile_key(&p.name);
        if self.loading.as_ref().is_some_and(|f| f.key == key) || self.queue.contains(&key) {
            return;
        }
        let mut keys: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for here in p.rows.iter().filter(|r| self.comes_back(r)).filter_map(|r| r.here.clone()) {
            if seen.insert(here.clone()) {
                keys.push(here);
            }
        }
        if let Err(e) = library::trash_songs(&keys) {
            eprintln!("mp-shell: music: uninstalling {}: {e}", p.name);
            return;
        }
        for a in &mut self.albums {
            a.songs.retain(|k| !seen.contains(k));
        }
        self.downloaded = library::downloaded();
        self.playlists = library::playlists(&self.links);
    }

    /// Whether the playlist shown holds `song` (the player's key or link), among its
    /// rows built.
    pub fn playlist_holds(&self, song: &String) -> bool {
        let list = self.open_playlist();
        if list.is_none() && self.place != Place::Downloaded {
            return false;
        }
        self.entries(list, self.built, self.built).iter().any(|e| self.is_now(e, Some(song)))
    }

    /// The playlist shown's fact line (Windows'): its top two artists (here channels),
    /// then its songs and length. Counted in a table: an import may hold thousands of
    /// songs by hundreds.
    pub fn playlist_facts(&self) -> (String, String) {
        // Each song's artist and length, nothing copied.
        let entries: Vec<(&str, Option<u32>)> = match self.open_playlist() {
            Some(p) => p.rows.iter().map(|r| (r.artist.as_str(), r.length)).collect(),
            None => self.downloaded.iter().map(|s| (s.artist.as_str(), s.length)).collect(),
        };
        let mut seen: HashMap<&str, (usize, usize)> = HashMap::new();
        for (i, e) in entries.iter().enumerate() {
            seen.entry(e.0).or_insert((0, i)).0 += 1;
        }
        // Most songs first, ties as they first came (the list's order).
        let mut by: Vec<(&str, (usize, usize))> = seen.into_iter().collect();
        by.sort_by_key(|(_, (n, first))| (std::cmp::Reverse(*n), *first));
        let more = if by.len() > 2 { format!(" + {} more", by.len() - 2) } else { String::new() };
        let artists = by.iter().take(2).map(|(a, _)| *a).collect::<Vec<_>>().join(", ") + &more;
        let mut facts = vec![format!("{} track{}", entries.len(), if entries.len() == 1 { "" } else { "s" })];
        let secs: u32 = entries.iter().filter_map(|e| e.1).sum();
        if secs > 0 {
            facts.push(format!("{}m", (secs as f32 / 60.0).round()));
        }
        (artists, facts.join(" · "))
    }

    /// The playlist shown's name: Saved Tracks and Downloaded Songs as they are; yours
    /// typed in place on a click (approved: no pop-up).
    pub fn playlist_title(&self) -> Element<'_, Message> {
        match self.open_playlist() {
            None => self.title(NAME),
            Some(l) if is_saved(l) => self.title(&l.name),
            Some(_) if self.naming.is_some() => self.name_field(),
            Some(l) => mouse_area(self.title(&l.name)).on_press(Message::Name).interaction(mouse::Interaction::Text).into(),
        }
    }

    /// The playlist shown's rows (the big box's Tracks), built 50 at a time as it
    /// scrolls (Windows' `useColumnPages`); yours held and dragged into a new order
    /// (piece C), Downloaded Songs newest first.
    pub fn playlist_rows(&self) -> Element<'_, Message> {
        let p = &self.page_pictures;
        let list = self.open_playlist();
        let entries = self.entries(list, self.built, self.built);
        if entries.is_empty() {
            return self.note(match list {
                None => "Empty playlist. Download songs with the arrow on a search's songs.",
                Some(l) if is_saved(l) => "Empty playlist. Save songs with Save to Saved Tracks on any song.",
                Some(_) => "Empty playlist. Add songs with Save to Playlist on any song or album.",
            });
        }
        let playing = self.playing();
        let built = entries.len().min(self.built);
        let rest = entries.iter().take(built).position(|e| self.is_now(e, playing));
        // A song's listens while it streamed count too (its link), as Windows'.
        let plays = |e: &Entry| e.keys.iter().filter_map(|k| self.song_plays.get(k)).sum::<u32>();
        let face = |i: usize, lit: bool| {
            let e = &entries[i];
            self.line(Some(i as u32 + 1), Some(self.row_cover(self.row_pic(e).0)), e.title, e.artist, vec![(&p.ear, plays(e).to_string()), (&p.clock, page::clock(e.length))], Vec::new(), lit)
        };
        self.list(built, rest, face, |i| Some(Message::PlaylistSong(i)), |i| Some(Message::SongMenu(Target::Row(i))), list.is_some())
    }

    /// The name being typed, at the title's size in its place (approved new part):
    /// Enter keeps it, Esc or a click off leaves it as it was.
    fn name_field(&self) -> Element<'_, Message> {
        let c = self.colours;
        text_input("Name", self.naming.as_deref().unwrap_or_default())
            .id(name_id())
            .on_input(Message::Naming)
            .on_submit(Message::Rename)
            .size(TITLE)
            .font(MEDIUM)
            .line_height(LINE_TIGHT)
            .padding(0)
            .width(Length::Fill)
            .style(move |_, _| text_input::Style { background: Color::TRANSPARENT.into(), border: border::rounded(0), icon: Color::TRANSPARENT, placeholder: c.text_faint, value: c.text, selection: c.accent.scale_alpha(0.3) })
            .into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_youtube_links_id() {
        assert_eq!(youtube_id("https://www.youtube.com/watch?v=abc123&t=5"), Some("abc123"));
        assert_eq!(youtube_id("https://www.youtube.com/watch?list=x&v=abc123"), Some("abc123"));
        assert_eq!(youtube_id("https://youtu.be/abc123?t=5"), Some("abc123"));
        assert_eq!(youtube_id("https://example.com/song"), None);
        assert_eq!(youtube_id("https://www.youtube.com/watch?v="), None);
    }

    #[test]
    fn a_name_only_rows_stand_in_is_no_song_key() {
        let r = Row { key: None, link: None, title: "T".into(), artist: "A".into(), length: None, here: None };
        assert!(is_named(&named(&r)) && is_named(&song_of(&r)));
        let linked = Row { link: Some("https://x".into()), ..r.clone() };
        assert_eq!(song_of(&linked), "https://x");
        // On this PC wins over its link.
        assert_eq!(song_of(&Row { here: Some("A/Singles/T".into()), ..linked }), "A/Singles/T");
    }
}

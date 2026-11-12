//! Your albums, read fresh on each open: one folder per album in
//! `~/Music/<Artist>/<Album>/` (songs named by their own tags, one `cover.jpg`)
//! and its line in `~/.local/share/mp-library/albums` (status, rating, year, ...;
//! the plan's Storage section). `Singles` and `Unsorted` are no albums: their
//! songs come with the playlists (step 4; `Singles` = Downloaded Songs). Your own
//! playlists are files in `~/.local/share/mp-library/playlists/`.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Plan,
    Now,
    Done,
    Dropped,
}

impl Status {
    pub const ALL: [Status; 4] = [Status::Plan, Status::Now, Status::Done, Status::Dropped];

    /// The stored word (Windows' schema verb).
    fn word(self) -> &'static str {
        match self {
            Status::Plan => "Plan-to-Listen",
            Status::Now => "Currently-Listening",
            Status::Done => "Listened",
            Status::Dropped => "Dropped",
        }
    }

    fn parse(word: &str) -> Option<Status> {
        Some(match word {
            "Plan-to-Listen" => Status::Plan,
            "Currently-Listening" => Status::Now,
            "Listened" => Status::Done,
            "Dropped" => Status::Dropped,
            _ => return None,
        })
    }

    /// What it shows as (Windows' `statusLabel`).
    pub fn label(self) -> &'static str {
        match self {
            Status::Plan => "Planned",
            Status::Now => "Currently",
            Status::Done => "Listened",
            Status::Dropped => "Dropped",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Album {
    /// `Artist/Album`: the folder under `~/Music`, the `albums` line's key.
    pub key: String,
    pub artist: String,
    pub title: String,
    pub status: Option<Status>,
    pub rating: u8,
    pub year: u32,
    /// When its folder was made.
    pub added: SystemTime,
    /// The songs on disk, by file name (they start with their number): keys as
    /// the player takes them, paths under `~/Music` without the ending.
    pub songs: Vec<String>,
    pub cover: Option<PathBuf>,
    /// Its MusicBrainz release, where its song list comes from; empty = none.
    pub release: String,
    /// Its MusicBrainz release group: a search's album is this one; empty = none.
    pub group: String,
}

pub fn music() -> PathBuf {
    crate::apps::home().join("Music")
}

/// `~/.local/share`: the Library's own files and the bin live under it.
fn share() -> PathBuf {
    crate::apps::xdg("XDG_DATA_HOME", ".local/share")
}

fn data() -> PathBuf {
    share().join("mp-library")
}

pub fn read() -> Vec<Album> {
    let lines = fs::read_to_string(data().join("albums")).unwrap_or_default();
    let mut albums = Vec::new();
    for artist in folders(&music()) {
        let artist_name = name(&artist);
        if artist_name == "Unsorted" {
            continue;
        }
        for dir in folders(&artist) {
            let title = name(&dir);
            if title == "Singles" {
                continue;
            }
            let key = format!("{artist_name}/{title}");
            // folder, status, rating, year, release-group id, release id, notes
            let line = lines.lines().map(|l| l.split('\t').collect::<Vec<_>>()).find(|f| f[0] == key);
            let field = |i: usize| line.as_ref().and_then(|f| f.get(i).copied()).unwrap_or("");
            albums.push(Album {
                status: Status::parse(field(1)),
                rating: field(2).parse().unwrap_or(0),
                year: field(3).parse().unwrap_or(0),
                added: fs::metadata(&dir).and_then(|m| m.created()).unwrap_or(SystemTime::UNIX_EPOCH),
                songs: songs(&dir, &key),
                // Windows kept some as `cover.png`.
                cover: ["cover.jpg", "cover.png"].iter().map(|f| dir.join(f)).find(|p| p.is_file()),
                release: field(5).to_string(),
                group: field(4).to_string(),
                artist: artist_name.clone(),
                title,
                key,
            });
        }
    }
    albums
}

/// A name as a folder: a '/' would start another (Windows' `sanitize_segment`).
pub fn folder(name: &str) -> String {
    let name = name.replace('/', "-");
    match name.trim() {
        "" | "." | ".." => "Untitled".into(),
        name => name.into(),
    }
}

fn folders(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    found.sort();
    found
}

fn name(path: &Path) -> String {
    path.file_name().unwrap_or_default().to_string_lossy().into_owned()
}

/// Every file but the cover and words, as the player finds a song (`song.rs` `find`).
fn is_song(p: &Path) -> bool {
    p.is_file() && !matches!(p.extension().and_then(|e| e.to_str()), Some("jpg" | "png" | "lrc"))
}

fn songs(dir: &Path, key: &str) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| is_song(p)).filter_map(|p| p.file_stem().map(|s| format!("{key}/{}", s.to_string_lossy()))).collect();
    found.sort();
    found
}

/// A song outside any album: a YouTube upload downloaded on its own.
#[derive(Debug, Clone)]
pub struct Song {
    /// As the player takes it: `<channel>/Singles/<title>`.
    pub key: String,
    pub title: String,
    /// Its channel.
    pub artist: String,
    /// Seconds.
    pub length: Option<u32>,
}

/// Every song in a `<channel>/Singles/` folder (the Downloaded Songs playlist: read
/// from the folders, nothing saved, his call 2026-10-31), newest first by the file's
/// change time (Windows' copy kept its download day there; both were born the same
/// second here), named by its own tags as the player shows them.
pub fn downloaded() -> Vec<Song> {
    let mut found: Vec<(SystemTime, Song)> = Vec::new();
    for dir in folders(&music()) {
        let channel = name(&dir);
        for path in fs::read_dir(dir.join("Singles")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| is_song(p)) {
            let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
            let (title, artist, length) = tags(&path);
            let at = fs::metadata(&path).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            let song = Song { key: format!("{channel}/Singles/{stem}"), title: title.unwrap_or(stem), artist: artist.unwrap_or_else(|| channel.clone()), length };
            found.push((at, song));
        }
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    found.into_iter().map(|(_, s)| s).collect()
}

/// A song file's title, artist and length as the player reads them.
fn tags(path: &Path) -> (Option<String>, Option<String>, Option<u32>) {
    use lofty::prelude::*;
    let file = lofty::read_from_path(path).ok();
    let tag = file.as_ref().and_then(|f| f.primary_tag().or(f.first_tag()));
    let title = tag.and_then(|t| t.title()).map(|t| t.into_owned());
    let artist = tag.and_then(|t| t.artist()).map(|t| t.into_owned());
    let length = file.as_ref().map(|f| f.properties().duration().as_secs_f64().round() as u32).filter(|s| *s > 0);
    (title, artist, length)
}

/// The song's file in `~/Music`, whatever its ending (as the player finds it).
fn file(key: &str) -> Option<PathBuf> {
    let full = music().join(key);
    let (dir, name) = (full.parent()?, full.file_name()?);
    fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).find(|p| p.file_stem() == Some(name) && is_song(p))
}

pub fn on_disk(key: &str) -> bool {
    file(key).is_some()
}

/// One of your playlists (step 4): a file in `playlists/`, a song a line, in order;
/// its picture beside it as `<name>.jpg` or `.png`.
#[derive(Debug, Clone)]
pub struct Playlist {
    pub name: String,
    pub rows: Vec<Row>,
    pub cover: Option<PathBuf>,
    /// When its file was made.
    pub added: SystemTime,
}

/// A playlist's song: a song key (a line with no tab), else a web link with its
/// names (`url \t title \t artist \t m:ss`), else names alone (an empty url: an
/// import's row, its link found when it plays).
#[derive(Debug, Clone)]
pub struct Row {
    pub key: Option<String>,
    pub link: Option<String>,
    pub title: String,
    pub artist: String,
    pub length: Option<u32>,
    /// The song's key on this PC when it is here: its own, or a link's download
    /// (by `sources`). Read, never saved.
    pub here: Option<String>,
}

fn playlists_dir() -> PathBuf {
    data().join("playlists")
}

/// A playlist's own file: its name is the file's whole name (dots and all).
fn playlist_file(name: &str) -> PathBuf {
    playlists_dir().join(name)
}

/// Its picture, either ending.
fn playlist_cover(name: &str) -> Option<PathBuf> {
    ["jpg", "png"].iter().map(|e| playlists_dir().join(format!("{name}.{e}"))).find(|p| p.is_file())
}

/// Endings of the files beside the playlists: their pictures, a save under way.
const NOT_A_PLAYLIST: [&str; 3] = [".jpg", ".png", ".new"];

/// A playlist's name as its file's: a folder-safe name that doesn't end as a picture
/// or a save does, or `playlists` would take it for one and never show it.
fn playlist_name(name: &str) -> String {
    let mut name = folder(name);
    while let Some(cut) = NOT_A_PLAYLIST.iter().find_map(|e| name.strip_suffix(e)) {
        name = folder(cut);
    }
    name
}

/// Every playlist, by name. `links`: `sources`, to find a link's download.
pub fn playlists(links: &[(String, String)]) -> Vec<Playlist> {
    let mut found = Vec::new();
    for entry in fs::read_dir(playlists_dir()).into_iter().flatten().flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !path.is_file() || NOT_A_PLAYLIST.iter().any(|e| name.ends_with(e)) {
            continue;
        }
        let rows = fs::read_to_string(&path).unwrap_or_default().lines().filter(|l| !l.trim().is_empty()).map(|l| row(l, links)).collect();
        let added = fs::metadata(&path).and_then(|m| m.created()).unwrap_or(SystemTime::UNIX_EPOCH);
        found.push(Playlist { cover: playlist_cover(&name), name, rows, added });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn row(line: &str, links: &[(String, String)]) -> Row {
    let Some((url, rest)) = line.split_once('\t') else {
        // A song key: named by its file's tags, else by its key (`Artist/Album/NN Title`).
        let path = file(line);
        let (title, artist, length) = path.as_deref().map(tags).unwrap_or_default();
        let last = line.rsplit('/').next().unwrap_or(line);
        let bare = bare(last);
        // Not here: downloaded on its own from its link (an internet album's song a
        // playlist downloaded, piece D).
        let here = match path {
            Some(_) => Some(line.to_string()),
            None => links.iter().find(|(k, _)| k == line).and_then(|(_, u)| download_of(u, links)),
        };
        return Row { title: title.unwrap_or_else(|| if bare.is_empty() { last } else { bare }.into()), artist: artist.unwrap_or_else(|| line.split('/').next().unwrap_or_default().into()), length, link: None, here, key: Some(line.into()) };
    };
    let mut fields = rest.split('\t');
    let mut next = || fields.next().unwrap_or_default().to_string();
    let (title, artist, length) = (next(), next(), seconds(&next()));
    let link = (!url.is_empty()).then(|| url.to_string());
    let here = link.as_ref().and_then(|u| download_of(u, links));
    Row { key: None, link, title, artist, length, here }
}

/// The song on this PC that came from `url` (by `sources`), its key.
fn download_of(url: &str, links: &[(String, String)]) -> Option<String> {
    links.iter().find(|(k, l)| l == url && on_disk(k)).map(|(k, _)| k.clone())
}

/// A song's file name without its number (`NN Title`, `D-NN Title`): its title.
pub fn bare(name: &str) -> &str {
    name.trim_start_matches(|c: char| c.is_ascii_digit() || c == '-').trim_start()
}

/// `m:ss` (or `h:mm:ss`) as seconds.
fn seconds(s: &str) -> Option<u32> {
    s.split(':').try_fold(0u32, |total, part| Some(total * 60 + part.trim().parse::<u32>().ok()?)).filter(|s| *s > 0)
}

/// Writes the playlist's rows in order.
pub fn save_playlist(p: &Playlist) {
    let lines: String = p
        .rows
        .iter()
        .map(|r| match &r.key {
            Some(key) => format!("{key}\n"),
            None => {
                let length = r.length.map(|s| if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }).unwrap_or_default();
                // A line a song, its fields split on tabs: a name holds neither.
                let plain = |s: &str| s.replace(['\t', '\n', '\r'], " ");
                format!("{}\t{}\t{}\t{length}\n", r.link.as_deref().unwrap_or(""), plain(&r.title), plain(&r.artist))
            }
        })
        .collect();
    write(&playlist_file(&p.name), lines);
}

/// A new empty playlist named `base` ("New Playlist", an import's file name), or
/// the first "`base` N" not taken (Windows'); its name.
pub fn new_playlist(base: &str) -> std::io::Result<String> {
    fs::create_dir_all(playlists_dir())?;
    let base = playlist_name(base);
    let name = (1..).map(|n| if n == 1 { base.clone() } else { format!("{base} {n}") }).find(|n| !playlist_file(n).exists()).unwrap_or_default();
    fs::File::create_new(playlist_file(&name))?;
    Ok(name)
}

/// Renames a playlist and its picture; refused when the name is taken. The name
/// it has now.
pub fn rename_playlist(old: &str, new: &str) -> std::io::Result<String> {
    let new = playlist_name(new);
    if new == old {
        return Ok(new);
    }
    if playlist_file(&new).exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "name taken"));
    }
    fs::rename(playlist_file(old), playlist_file(&new))?;
    if let Some(cover) = playlist_cover(old) {
        let ending = cover.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        fs::rename(&cover, playlists_dir().join(format!("{new}.{ending}")))?;
    }
    Ok(new)
}

/// Delete (Windows'): the playlist and its picture to the bin, no asking, as an
/// album's Remove (his pick); its songs stay.
pub fn delete_playlist(name: &str) -> std::io::Result<()> {
    trash([Some(playlist_file(name)), playlist_cover(name)].into_iter().flatten().collect())
}

/// Your own picture for a playlist (Windows' Edit Details), copied in keeping its
/// ending; the one it had goes to the bin. Where it now is.
pub fn set_cover(name: &str, from: &Path) -> std::io::Result<PathBuf> {
    let ending = match from.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("png") => "png",
        _ => "jpg",
    };
    trash(playlist_cover(name).into_iter().collect())?;
    let to = playlists_dir().join(format!("{name}.{ending}"));
    fs::copy(from, &to)?;
    Ok(to)
}

/// Songs to the bin, by key (Uninstall Playlist, piece D); their words go with them.
pub fn trash_songs(keys: &[String]) -> std::io::Result<()> {
    let mut files = Vec::new();
    for key in keys {
        let full = music().join(key);
        let (Some(dir), Some(name)) = (full.parent(), full.file_name()) else { continue };
        files.extend(fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file() && p.file_stem() == Some(name) && !matches!(p.extension().and_then(|e| e.to_str()), Some("jpg" | "png"))));
    }
    trash(files)
}

/// Files to the bin (`gio trash`, so they can come back).
fn trash(files: Vec<PathBuf>) -> std::io::Result<()> {
    if files.is_empty() || std::process::Command::new("gio").args(["trash", "--"]).args(&files).status()?.success() { Ok(()) } else { Err(std::io::Error::other("gio trash failed")) }
}

/// A song's place on its album, from its file name: `NN Title` = disc 1, track NN;
/// `D-NN Title` on an album with several discs (a download names them so). A file on
/// disk and a play in `listens` belong to a song by album folder + this place
/// (Windows' own match, `AlbumDetail.jsx` `fileKeys`, with the disc added).
pub fn place(key: &str) -> Option<(u32, u32)> {
    let name = key.rsplit('/').next()?;
    let digits = |s: &str| s.len() - s.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let first = digits(name);
    let n = name[..first].parse().ok()?;
    match name[first..].strip_prefix('-').filter(|rest| digits(rest) > 0) {
        Some(rest) => Some((n, rest[..digits(rest)].parse().ok()?)),
        None => Some((1, n)),
    }
}

/// A downloaded song's name in its album folder (no ending): `NN Title`, or
/// `D-NN Title` when the album has several discs (Windows gave them all `NN`).
pub fn song_name(disc: u32, n: u32, title: &str, several: bool) -> String {
    if several { format!("{disc}-{n:02} {}", folder(title)) } else { format!("{n:02} {}", folder(title)) }
}

/// `listens`, one finished play a line: time, seconds, song key.
pub fn listens() -> String {
    fs::read_to_string(data().join("listens")).unwrap_or_default()
}

/// Finished listens of each song of the album at `key`, by place.
pub fn plays(key: &str) -> HashMap<(u32, u32), u32> {
    let folder = format!("{key}/");
    let mut plays = HashMap::new();
    for line in listens().lines() {
        // time, seconds, song
        if let Some(at) = line.split('\t').nth(2).filter(|song| song.starts_with(&folder)).and_then(place) {
            *plays.entry(at).or_insert(0) += 1;
        }
    }
    plays
}

/// Finished listens by song key (a song outside an album has no place to match by;
/// a streamed one's key is its link).
pub fn song_plays() -> HashMap<String, u32> {
    let mut plays = HashMap::new();
    for line in listens().lines() {
        if let Some(song) = line.split('\t').nth(2) {
            *plays.entry(song.to_string()).or_insert(0) += 1;
        }
    }
    plays
}

/// The wall's Custom order (step 4 piece C, `order`): a tile a line, an album's
/// folder key or '/' + a playlist's name.
pub fn order() -> Vec<String> {
    fs::read_to_string(data().join("order")).unwrap_or_default().lines().filter(|l| !l.is_empty()).map(String::from).collect()
}

pub fn save_order(keys: &[String]) {
    write(&data().join("order"), keys.iter().map(|k| format!("{k}\n")).collect());
}

/// The record the main page showed as the box last closed and its big box's tab
/// (`shown`: the record's tile key, then the tab, a line each), opened again after the
/// program restarts (his picks, chat 58).
pub fn shown() -> (String, String) {
    let text = fs::read_to_string(data().join("shown")).unwrap_or_default();
    let mut lines = text.lines();
    (lines.next().unwrap_or_default().into(), lines.next().unwrap_or_default().into())
}

/// Written only when it changed.
pub fn save_shown(key: &str, tab: &str) {
    if shown() != (key.to_string(), tab.to_string()) {
        write(&data().join("shown"), format!("{key}\n{tab}\n"));
    }
}

/// The web link each song came from or plays from (`sources`: song key, link).
pub fn links() -> Vec<(String, String)> {
    let lines = fs::read_to_string(data().join("sources")).unwrap_or_default();
    lines.lines().filter_map(|l| l.split_once('\t')).map(|(k, u)| (k.to_string(), u.to_string())).collect()
}

/// Saves the link a song came from, in place of any older one for the same song
/// (the same album folder and place; a single only by its own key: "21 Guns" has
/// no place among singles).
pub fn link(key: &str, url: &str) {
    let path = data().join("sources");
    let album = key.rsplit_once('/').map(|p| p.0).filter(|dir| !dir.ends_with("/Singles"));
    let same = |k: &str| k == key || (album.is_some() && k.rsplit_once('/').map(|p| p.0) == album && place(k).is_some() && place(k) == place(key));
    let mut out: String = fs::read_to_string(&path).unwrap_or_default().lines().filter(|l| !same(l.split('\t').next().unwrap_or(""))).map(|l| format!("{l}\n")).collect();
    out.push_str(&format!("{key}\t{url}\n"));
    write(&path, out);
}

/// Writes the album's status and rating to its `albums` line (a new line with its
/// year, release group and release if it had none), the rest of the line kept as
/// it was.
pub fn save(album: &Album) {
    let path = data().join("albums");
    let old = fs::read_to_string(&path).unwrap_or_default();
    let status = album.status.map(Status::word).unwrap_or("");
    let rating = if album.rating == 0 { String::new() } else { album.rating.to_string() };
    let mut found = false;
    let mut out = String::new();
    for line in old.lines() {
        let mut fields: Vec<&str> = line.split('\t').collect();
        if fields[0] == album.key {
            found = true;
            fields.resize(fields.len().max(7), "");
            fields[1] = status;
            fields[2] = &rating;
            out.push_str(&fields.join("\t"));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    if !found {
        let year = if album.year == 0 { String::new() } else { album.year.to_string() };
        out.push_str(&[album.key.as_str(), status, &rating, &year, &album.group, &album.release, ""].join("\t"));
        out.push('\n');
    }
    write(&path, out);
}

/// A whole new file, then swapped in: a crash mid-write leaves the old one. The new
/// one is `<name>.new` (a playlist's name may hold dots). Every save in the music box.
pub fn write(path: &Path, text: String) {
    let mut new = path.as_os_str().to_owned();
    new.push(".new");
    let dir = path.parent().unwrap_or(path);
    if let Err(e) = fs::create_dir_all(dir).and_then(|_| fs::write(&new, text)).and_then(|_| fs::rename(&new, path)) {
        eprintln!("mp-shell: music: saving {}: {e}", path.display());
    }
}

/// Keeps a fetched cover as the album's `cover.jpg`; where it now is.
pub fn keep_cover(album: &Album, from: &Path) -> Option<PathBuf> {
    let to = music().join(&album.key).join("cover.jpg");
    fs::copy(from, &to).map_err(|e| eprintln!("mp-shell: music: {}: {e}", to.display())).ok()?;
    Some(to)
}

/// Puts an album off the internet in your library (Windows' Add to Library): its
/// folder, its cover, its `albums` line, no songs yet, so the wall shows it as Not
/// Downloaded.
pub fn add(album: &Album) -> std::io::Result<()> {
    let dir = music().join(&album.key);
    fs::create_dir_all(&dir)?;
    if let Some(cover) = album.cover.as_ref().filter(|p| p.is_file()) {
        fs::copy(cover, dir.join("cover.jpg"))?;
    }
    save(album);
    Ok(())
}

/// Uninstall (Windows'): the album's songs and their words go to the bin (`gio
/// trash`, so they can come back); its folder, cover and `albums` line stay (his
/// pick 2026-10-31: no asking, the bin is the undo).
pub fn uninstall(album: &Album) -> std::io::Result<()> {
    trash(fs::read_dir(music().join(&album.key))?.flatten().map(|e| e.path()).filter(|p| p.is_file() && p.file_stem().is_none_or(|s| s != "cover")).collect())
}

/// The album's uninstalled songs still in the bin go back where they were, the
/// newest copy of each, so a Download after an Uninstall fetches nothing it has
/// (his call 2026-10-31). Reads the bin as `gio trash` writes it (freedesktop:
/// `Trash/info/<name>.trashinfo` says where `Trash/files/<name>` came from). The
/// songs' keys.
pub fn restore(album: &Album) -> Vec<String> {
    let dir = music().join(&album.key);
    restore_where(|from| from.parent() == Some(dir.as_path()))
}

/// The songs (by key) still in the bin go back where they were, with their words
/// (Download Playlist after its Uninstall, piece D); the keys back.
pub fn restore_songs(keys: &[String]) -> Vec<String> {
    let wanted: Vec<PathBuf> = keys.iter().map(|k| music().join(k)).collect();
    restore_where(|from| wanted.iter().any(|w| from.parent() == w.parent() && from.file_stem() == w.file_name()))
}

/// Files in the bin that came from where `wanted` says go back, the newest copy of
/// each. Reads the bin as `gio trash` writes it (freedesktop: `Trash/info/<name>.
/// trashinfo` says where `Trash/files/<name>` came from). The songs' keys back.
fn restore_where(wanted: impl Fn(&Path) -> bool) -> Vec<String> {
    let bin = share().join("Trash");
    // Where each file came from: its newest copy's deletion time and name in the bin.
    let mut newest: HashMap<PathBuf, (String, String)> = HashMap::new();
    for entry in fs::read_dir(bin.join("info")).into_iter().flatten().flatten() {
        let info = fs::read_to_string(entry.path()).unwrap_or_default();
        let field = |k: &str| info.lines().find_map(|l| l.strip_prefix(k)).map(str::to_string);
        let (Some(from), Some(when), Some(name)) = (field("Path="), field("DeletionDate="), entry.file_name().to_string_lossy().strip_suffix(".trashinfo").map(str::to_string)) else { continue };
        let from = PathBuf::from(mp_ui::portal::unescape(&from));
        if wanted(&from) && !from.exists() && newest.get(&from).is_none_or(|(at, _)| *at < when) {
            newest.insert(from, (when, name));
        }
    }
    let music = music();
    let mut back = Vec::new();
    for (to, (_, name)) in newest {
        if let Err(e) = fs::create_dir_all(to.parent().unwrap_or(&music)).and_then(|_| fs::rename(bin.join("files").join(&name), &to)) {
            eprintln!("mp-shell: music: restoring {}: {e}", to.display());
            continue;
        }
        let _ = fs::remove_file(bin.join("info").join(format!("{name}.trashinfo")));
        if !matches!(to.extension().and_then(|e| e.to_str()), Some("jpg" | "png" | "lrc"))
            && let Ok(key) = to.with_extension("").strip_prefix(&music)
        {
            back.push(key.to_string_lossy().into_owned());
        }
    }
    back
}

/// Remove from Library (his ask 2026-10-31): the album's folder, songs and cover,
/// to the bin; its `albums` line (status, rating) deleted; no asking (his pick).
pub fn remove(album: &Album) -> std::io::Result<()> {
    let dir = music().join(&album.key);
    if !std::process::Command::new("gio").args(["trash", "--"]).arg(&dir).status()?.success() {
        return Err(std::io::Error::other("gio trash failed"));
    }
    // Its artist's folder, when this was the last album in it.
    if let Some(artist) = dir.parent() {
        let _ = fs::remove_dir(artist);
    }
    let path = data().join("albums");
    let kept: String = fs::read_to_string(&path).unwrap_or_default().lines().filter(|l| l.split('\t').next() != Some(album.key.as_str())).map(|l| format!("{l}\n")).collect();
    write(&path, kept);
    Ok(())
}

/// Plays `songs` from `start`: one call to the player (`Queue.Play`), which the
/// bus starts if it isn't running. No answer is waited for. `found`: each song's
/// address looked up ahead when it is not on this PC (step 5 piece C), "" for none.
pub fn play(songs: Vec<String>, start: u32, found: Vec<String>) {
    tell("dev.malthaiel.MortarPestle.Queue", "Play", (songs, start, found));
}

/// Adds `songs` after the list playing (`Queue.Add`, Windows' Send to Queue): nothing
/// stops, nothing starts. `found` as `play`'s.
pub fn queue(songs: Vec<String>, found: Vec<String>) {
    tell("dev.malthaiel.MortarPestle.Queue", "Add", (songs, found));
}

/// A name-only song the player may hold (`was`, its stand-in) plays by `link` from now
/// on (`Queue.Named`); `found` as `play`'s. The one call that never starts the player.
pub fn named(was: String, link: String, found: String) {
    tell("dev.malthaiel.MortarPestle.Queue", "Named", (was, link, found));
}

fn tell<B: zbus::export::serde::Serialize + zbus::DynamicType + Send + 'static>(interface: &'static str, method: &'static str, body: B) {
    use zbus::message::Flags;
    let flags = if method == "Named" { Flags::NO_REPLY_EXPECTED | Flags::NO_AUTO_START } else { Flags::NO_REPLY_EXPECTED };
    std::thread::spawn(move || {
        let sent = zbus::block_on(async {
            let conn = zbus::Connection::session().await?;
            let msg = zbus::Message::method_call("/org/mpris/MediaPlayer2", method).destination("org.mpris.MediaPlayer2.mp_player").interface(interface).with_flags(flags).build(&body)?;
            conn.send(&msg).await
        });
        if let Err(e) = sent {
            eprintln!("mp-shell: music: {method}: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_songs_place_is_read_off_its_file_name() {
        assert_eq!(place("Artist/Album/03 Title"), Some((1, 3)));
        assert_eq!(place("Artist/Album/2-11 Title"), Some((2, 11)));
        // A title that starts with a number and a dash is still disc 1.
        assert_eq!(place("Artist/Album/07 - Title"), Some((1, 7)));
        assert_eq!(place("Artist/Singles/Title"), None);
        assert_eq!(song_name(1, 3, "A/B", false), "03 A-B");
        assert_eq!(song_name(2, 11, "Title", true), "2-11 Title");
        assert_eq!(place(&song_name(2, 11, "Title", true)), Some((2, 11)));
        assert_eq!(bare("2-11 Title"), "Title");
        assert_eq!(bare("03 Title"), "Title");
    }

    #[test]
    fn names_are_made_safe_for_files() {
        assert_eq!(folder("AC/DC"), "AC-DC");
        assert_eq!(folder(" .. "), "Untitled");
        // A playlist never ends as its picture or a save under way does (H4).
        assert_eq!(playlist_name("Road trip.jpg"), "Road trip");
        assert_eq!(playlist_name("x.png.new"), "x");
        assert_eq!(playlist_name(".jpg"), "Untitled");
        assert_eq!(playlist_name("v1.5 mix"), "v1.5 mix");
    }

    #[test]
    fn a_playlist_line_is_read_as_it_was_written() {
        assert_eq!(seconds("3:05"), Some(185));
        assert_eq!(seconds("1:00:01"), Some(3601));
        assert_eq!(seconds(""), None);
        assert_eq!(seconds("x"), None);
        let r = row("https://youtu.be/a\tTitle\tArtist\t3:05", &[]);
        assert_eq!((r.key, r.link.as_deref(), r.title.as_str(), r.artist.as_str(), r.length, r.here), (None, Some("https://youtu.be/a"), "Title", "Artist", Some(185), None));
        // An import's row: names alone.
        let r = row("\tTitle\tArtist\t", &[]);
        assert_eq!((r.key, r.link, r.title.as_str(), r.length), (None, None, "Title", None));
        // A song key not on this PC is named by its key.
        let r = row("No Such Artist 9f3/Album/04 Song", &[]);
        assert_eq!((r.key.as_deref(), r.title.as_str(), r.artist.as_str(), r.here), (Some("No Such Artist 9f3/Album/04 Song"), "Song", "No Such Artist 9f3", None));
    }
}

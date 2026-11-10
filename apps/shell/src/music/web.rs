//! The internet side of the Library (M&P Library plan, step 5 piece A): MusicBrainz
//! searches and lookups, Cover Art Archive covers, YouTube searches (and piece B's
//! downloads, `download.rs`) through the makers' yt-dlp (`~/.local/bin`, no helper
//! for YouTube's puzzles: his pick); the album page's discography, Spotify plays and
//! artist photo (step 3 piece C) from MusicBrainz, ListenBrainz, kworb and TheAudioDB. Every
//! MusicBrainz ask goes through `ask`, one a second (its rule for programs). All of
//! it blocks, so it runs off the window's thread.

use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use std::{env, fs};

use serde_json::Value;

use crate::music::library;

/// Who asks, as MusicBrainz wants it said: the program and where it lives, never
/// a person's address.
pub const AGENT: &str = "MortarPestle/0.1 ( https://github.com/Malthaiel/mortar-pestle )";
const MB: &str = "https://musicbrainz.org/ws/2";

/// An album (a MusicBrainz release group) as a search or an artist lists it.
#[derive(Debug, Clone)]
pub struct Group {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub year: u32,
}

#[derive(Debug, Clone)]
pub struct Artist {
    pub id: String,
    pub name: String,
    /// Type · area · MusicBrainz's note telling namesakes apart.
    pub about: String,
}

/// A YouTube song.
#[derive(Debug, Clone)]
pub struct Video {
    pub id: String,
    pub title: String,
    pub channel: String,
    /// Seconds.
    pub length: Option<u32>,
    pub views: u64,
}

/// `~/.cache/mp-library`.
pub fn cache() -> PathBuf {
    env::var_os("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".cache")).join("mp-library")
}

/// The last MusicBrainz ask: each one waits a second after it.
static LAST: Mutex<Option<Instant>> = Mutex::new(None);

/// Asks MusicBrainz for `path`, `words` added to it as typed (curl writes them
/// safe for an address); the answer, or none with why printed. A 503 is its whole
/// server being busy ("zone: global", "Retry-After: 0"; 3 of 12 asks a second apart,
/// chat 33): asked again up to four times, a second apart.
pub fn ask(path: &str, words: &[(&str, &str)]) -> Option<String> {
    for tries in 0..5 {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(at) = *last {
            std::thread::sleep(Duration::from_secs(1).saturating_sub(at.elapsed()));
        }
        let mut curl = Command::new("curl");
        curl.args(["-sS", "--max-time", "15", "-A", AGENT, "-w", "\n%{http_code}", "-G"]);
        for (k, v) in words {
            curl.arg("--data-urlencode").arg(format!("{k}={v}"));
        }
        let out = curl.arg(format!("{MB}/{path}")).output();
        *last = Some(Instant::now());
        drop(last);
        let out = out.map_err(|e| eprintln!("mp-shell: music: curl: {e}")).ok()?;
        let body = String::from_utf8_lossy(&out.stdout);
        let (json, code) = body.rsplit_once('\n')?;
        match code {
            "200" => return Some(json.to_string()),
            "503" if tries < 4 => continue,
            _ => {
                eprintln!("mp-shell: music: MusicBrainz {path}: {code} {}", String::from_utf8_lossy(&out.stderr).trim());
                return None;
            }
        }
    }
    None
}

pub fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

/// The artists as credited: "A & B feat. C".
pub fn credit(v: &Value) -> String {
    v["artist-credit"].as_array().into_iter().flatten().map(|a| format!("{}{}", text(&a["name"]), text(&a["joinphrase"]))).collect()
}

/// A release group as MusicBrainz lists it, and its date.
fn group(g: &Value) -> (String, Group) {
    let date = text(&g["first-release-date"]);
    let year = date.get(..4).and_then(|y| y.parse().ok()).unwrap_or(0);
    (date, Group { id: text(&g["id"]), title: text(&g["title"]), artist: credit(g), year })
}

fn groups(json: &str) -> Option<Vec<(String, Group)>> {
    let v: Value = serde_json::from_str(json).ok()?;
    Some(v["release-groups"].as_array()?.iter().map(group).collect())
}

/// Albums named like `q`, best first (`dismax`: plain words over title and artist,
/// Windows' pick: MusicBrainz's default search buries the right album).
pub fn search_albums(q: &str) -> Option<Vec<Group>> {
    Some(groups(&ask("release-group?dismax=true&fmt=json&limit=18", &[("query", q)])?)?.into_iter().map(|g| g.1).collect())
}

pub fn search_artists(q: &str) -> Option<Vec<Artist>> {
    let v: Value = serde_json::from_str(&ask("artist?dismax=true&fmt=json&limit=25", &[("query", q)])?).ok()?;
    let found = v["artists"].as_array()?.iter().map(|a| {
        let about: Vec<String> = [text(&a["type"]), text(&a["area"]["name"]), text(&a["disambiguation"])].into_iter().filter(|s| !s.is_empty()).collect();
        Artist { id: text(&a["id"]), name: text(&a["name"]), about: about.join(" · ") }
    });
    Some(found.collect())
}

/// An artist's albums and EPs, newest first, each with its credited artists (a
/// browse leaves them out unless asked: an album added from here was "Untitled").
pub fn artist_groups(id: &str) -> Option<Vec<Group>> {
    let mut found = groups(&ask(&format!("release-group?artist={id}&type=album%7Cep&inc=artist-credits&fmt=json&limit=100"), &[])?)?;
    found.sort_by(|a, b| b.0.cmp(&a.0));
    Some(found.into_iter().map(|g| g.1).collect())
}

/// The most of an artist's release groups a Discography asks for (Windows' `RG_CAP`):
/// each hundred waits its turn at one ask a second.
const DISCOGRAPHY_MOST: usize = 1000;

fn discography_at(id: &str) -> PathBuf {
    cache().join("discography").join(id)
}

/// A list of release groups as `keep` holds it.
fn lines(groups: &[Group]) -> String {
    groups.iter().map(|g| format!("{}\t{}\t{}\t{}\n", g.id, g.title, g.artist, g.year)).collect()
}

fn live_out(g: &&Value) -> bool {
    !g["secondary-types"].as_array().is_some_and(|t| t.iter().any(|k| k == "Live"))
}

/// The album page's Discography tab (Windows' `ArtistAlbums`): the artist's albums, EPs
/// and singles, no live recordings, most played first, the rest newest first. Asks
/// MusicBrainz, then ListenBrainz, and keeps the list. ListenBrainz refuses some artists
/// without a sign-in (Loathe, Macroblank, ippo.tsk, Sān-Z, chat 45): they stay newest first.
pub fn discography(id: &str) -> Option<Vec<Group>> {
    let mut found = Vec::new();
    let mut asked = 0;
    while asked < DISCOGRAPHY_MOST {
        let v: Value = serde_json::from_str(&ask(&format!("release-group?artist={id}&type=album%7Cep%7Csingle&inc=artist-credits&fmt=json&limit=100&offset={asked}"), &[])?).ok()?;
        let page = v["release-groups"].as_array()?;
        found.extend(page.iter().filter(live_out).map(group));
        asked += 100;
        if page.len() < 100 {
            break;
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    let plays = group_plays(id);
    found.sort_by_key(|g| std::cmp::Reverse(plays.get(&g.1.id).copied().unwrap_or(0)));
    let groups: Vec<Group> = found.into_iter().map(|g| g.1).collect();
    library::write(&discography_at(id), lines(&groups));
    Some(groups)
}

/// The list kept from the last ask, if any.
pub fn saved_discography(id: &str) -> Option<Vec<Group>> {
    saved_groups(&discography_at(id))
}

fn saved_groups(at: &Path) -> Option<Vec<Group>> {
    let kept = fs::read_to_string(at).ok()?;
    let group = |line: &str| {
        let mut f = line.split('\t');
        Some(Group { id: f.next()?.into(), title: f.next()?.into(), artist: f.next()?.into(), year: f.next()?.parse().unwrap_or(0) })
    };
    Some(kept.lines().filter_map(group).collect())
}

/// Runs curl and gives what it printed, or none when it failed or the server refused.
pub(crate) fn curl(args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("curl").args(["-sSLf", "--max-time", "15", "-A", AGENT]).args(args).output().ok()?;
    out.status.success().then_some(out.stdout)
}

/// An artist's release groups' listens on ListenBrainz; none when refused.
fn group_plays(id: &str) -> HashMap<String, u64> {
    let url = format!("https://api.listenbrainz.org/1/popularity/top-release-groups-for-artist/{id}");
    let answer = curl(&[&url]).and_then(|o| serde_json::from_slice::<Value>(&o).ok()).unwrap_or_default();
    answer.as_array().into_iter().flatten().filter_map(|r| Some((text(&r["release_group_mbid"]), r["total_listen_count"].as_u64()?))).collect()
}

/// An artist's kworb page. Their Spotify id is kept for good (an empty file = none, once
/// kworb has answered): each link on MusicBrainz until one has a page (C418's first is
/// dead), else the same name on kworb's list of Spotify's biggest 3,000.
fn kworb_page(id: &str, name: &str) -> Option<String> {
    let page = |spotify: &str| String::from_utf8(curl(&[&format!("https://kworb.net/spotify/artist/{spotify}_songs.html")])?).ok();
    let path = cache().join("spotify").join(id);
    if let Ok(kept) = fs::read_to_string(&path) {
        return if kept.is_empty() { None } else { page(&kept) };
    }
    let v: Value = serde_json::from_str(&ask(&format!("artist/{id}?inc=url-rels&fmt=json"), &[])?).ok()?;
    let links = v["relations"].as_array()?.iter().filter_map(|r| r["url"]["resource"].as_str()).filter_map(|u| u.split("open.spotify.com/artist/").nth(1)?.split(['/', '?']).next());
    for spotify in links {
        if let Some(found) = page(spotify) {
            library::write(&path, spotify.into());
            return Some(found);
        }
    }
    let list = String::from_utf8(curl(&["https://kworb.net/spotify/artists.html"])?).ok()?;
    let named = list.split("/spotify/artist/").skip(1).find(|r| r.split_once("\">").is_some_and(|(_, rest)| rest.split('<').next().is_some_and(|n| n.eq_ignore_ascii_case(name))));
    let spotify = named.and_then(|r| r.split('_').next()).unwrap_or_default();
    library::write(&path, spotify.into());
    if spotify.is_empty() { None } else { page(spotify) }
}

/// A name as compared (Windows' `squash`): letters and digits only, one case.
pub fn plain(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// `songs`' (recording, title) Spotify plays off the artist's kworb page: Spotify's own
/// totals, redone daily, public (`robots.txt` allows all), one small page (4-16 KB, 0.4-0.6
/// s), no key. His pick over ListenBrainz chat 45: its numbers ran 100s of times under
/// Spotify's (Deftones' songs 9-20k against tens of millions). Spotify offers programs no
/// play count. Found by name, exactly but for a kworb row's "(feat. ...)": a song it
/// doesn't list stays unknown (a dash), never another version's number. Most played
/// first on the page, so a repeated name takes its biggest.
pub fn plays(artist: &str, name: &str, songs: &[(String, String)]) -> Option<Vec<(String, u64)>> {
    let page = kworb_page(artist, name)?;
    let mut counts: HashMap<String, u64> = HashMap::new();
    for row in page.split("open.spotify.com/track/").skip(1) {
        let Some((title, rest)) = row.split_once('>').and_then(|(_, r)| r.split_once("</a>")) else { continue };
        let Some(n) = rest.split_once("<td>").and_then(|(_, r)| r.split_once("</td>")).and_then(|(n, _)| n.replace(',', "").parse().ok()) else { continue };
        let title = title.replace("&amp;", "&").replace("&#039;", "'").replace("&#39;", "'").replace("&quot;", "\"");
        counts.entry(plain(&title)).or_insert(n);
        if let Some((short, _)) = title.split_once(" (feat.").or_else(|| title.split_once(" (with ")) {
            counts.entry(plain(short)).or_insert(n);
        }
    }
    Some(songs.iter().filter_map(|(song, title)| Some((song.clone(), *counts.get(&plain(title)).filter(|_| !plain(title).is_empty())?))).collect())
}

/// An artist's photo (Windows' `artistImage`), by their MusicBrainz id so a namesake
/// can't answer: TheAudioDB's small copy (12-27 KB against 110-147 KB whole, measured
/// chat 45), kept for good. An empty file = it has none, asked once ever. The free key
/// Windows used, `2`, now answers 404 for everyone; `123` found 10 of his 11 artists.
pub fn photo(id: &str) -> Option<PathBuf> {
    let path = cache().join("photo").join(format!("{id}.jpg"));
    if let Ok(kept) = fs::metadata(&path) {
        return (kept.len() > 0).then_some(path);
    }
    let answer: Value = serde_json::from_slice(&curl(&[&format!("https://www.theaudiodb.com/api/v1/json/123/artist-mb.php?i={id}")])?).ok()?;
    let Some(thumb) = answer["artists"][0]["strArtistThumb"].as_str().filter(|t| !t.is_empty()) else {
        library::write(&path, String::new());
        return None;
    };
    save(&format!("{thumb}/small"), path)
}

/// Fetches `url` into `path` whole, or not at all.
fn save(url: &str, path: PathBuf) -> Option<PathBuf> {
    // An address out of an answer: one starting with '-' would be read as a switch.
    if !url.starts_with("http") {
        return None;
    }
    fs::create_dir_all(path.parent()?).ok()?;
    // Its own temporary file: two fetches of one picture never write the same one.
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let new = path.with_extension(format!("{}.new", N.fetch_add(1, Ordering::Relaxed)));
    let got = Command::new("curl").args(["-sLf", "--max-time", "30", "-A", AGENT, "-o"]).arg(&new).arg(url).status().is_ok_and(|s| s.success());
    if !got || fs::rename(&new, &path).is_err() {
        let _ = fs::remove_file(&new);
        return None;
    }
    Some(path)
}

/// The release of a release group whose songs it shows (Windows' `pick_canonical`):
/// an official one, the earliest, from Britain, then America, then anywhere.
pub fn pick_release(group: &str) -> Option<String> {
    let v: Value = serde_json::from_str(&ask(&format!("release?release-group={group}&fmt=json&limit=100"), &[])?).ok()?;
    let releases = v["releases"].as_array()?;
    let official: Vec<&Value> = releases.iter().filter(|r| r["status"] == "Official").collect();
    let pool = if official.is_empty() { releases.iter().collect() } else { official };
    let rank = |r: &&Value| {
        let date = Some(text(&r["date"])).filter(|d| !d.is_empty()).unwrap_or_else(|| "9999".into());
        let country = match r["country"].as_str() {
            Some("GB") => 0,
            Some("US") => 1,
            _ => 2,
        };
        (date, country)
    };
    Some(text(&pool.into_iter().min_by_key(rank)?["id"]))
}

/// Where a release group's front cover at `size` is kept.
pub fn cover_at(group: &str, size: u32) -> PathBuf {
    cache().join("cover").join(format!("{group}-{size}.jpg"))
}

/// A release group's front cover at `size` (250 for a tile, 1200 for a page) from
/// the Cover Art Archive, kept for the next time; none when it has none.
pub fn cover(group: &str, size: u32) -> Option<PathBuf> {
    let path = cover_at(group, size);
    if path.is_file() {
        return Some(path);
    }
    save(&format!("https://coverartarchive.org/release-group/{group}/front-{size}"), path)
}

/// Where a YouTube song's picture is kept.
pub fn thumb_at(id: &str) -> PathBuf {
    cache().join("thumb").join(format!("{id}.jpg"))
}

/// A YouTube song's picture (`mqdefault`, 320 x 180, as the player shows it), kept
/// for the next time: a playlist's face when its first song is one (step 4).
pub fn thumb(id: &str) -> Option<PathBuf> {
    let path = thumb_at(id);
    if path.is_file() {
        return Some(path);
    }
    save(&format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"), path)
}

/// yt-dlp updated itself this session (once, after a failed run).
static UPDATED: AtomicBool = AtomicBool::new(false);

/// A pasted YouTube link, not words to search for.
pub fn is_link(q: &str) -> bool {
    q.starts_with("http") && (q.contains("youtube.com/") || q.contains("youtu.be/"))
}

/// What YouTube says of a video gone private, removed or blocked: a newer yt-dlp can't
/// fetch it either (the shell's log 2026-11-05..06: "Video unavailable", "Private
/// video", "This video is not available", "This video is unavailable").
fn gone(error: &str) -> bool {
    ["Video unavailable", "Private video", "This video is not available", "This video is unavailable", "has been removed", "no longer available"].iter().any(|s| error.contains(s))
}

/// Runs the makers' yt-dlp (never his own settings) and gives what it printed. YouTube
/// changes under it, so a failed run may want a newer yt-dlp: it updates itself once
/// a session and tries again (my call), but not for a video that is gone (his pick
/// 2026-11-06). It ends with the strip (`PR_SET_PDEATHSIG`), never with the box.
pub fn yt_dlp(args: &[&str]) -> Option<String> {
    yt_dlp_within(LOOK_UP, args)
}

/// A look-up's time limit, and a download's (seconds): a yt-dlp that hangs is ended
/// (coreutils' `timeout`), so a play waiting on its look-up never waits for ever.
const LOOK_UP: &str = "60";
pub const DOWNLOAD: &str = "1800";

pub fn yt_dlp_within(seconds: &str, args: &[&str]) -> Option<String> {
    let run = || {
        let mut yt = Command::new("timeout");
        yt.args([seconds, "yt-dlp", "--ignore-config"]).args(args);
        // SAFETY: one system call between fork and exec. The signal comes when the
        // thread that started it ends, and that thread waits for it first.
        unsafe {
            yt.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            })
        };
        let out = yt.output().map_err(|e| eprintln!("mp-shell: music: yt-dlp: {e}")).ok()?;
        if !out.status.success() {
            let error = String::from_utf8_lossy(&out.stderr).trim().lines().last().unwrap_or_default().to_string();
            eprintln!("mp-shell: music: yt-dlp: {error}");
            return Some(Err(error));
        }
        Some(Ok(String::from_utf8_lossy(&out.stdout).into_owned()))
    };
    let mut tries = 1;
    loop {
        match run()? {
            Ok(out) => return Some(out),
            // A download handed a tagged address (YouTube's pass-token trial, ~1 in 6
            // look-ups since about 2026-11-05): refused past its first ~1 MB, and yt-dlp
            // never retries a 403. Another run looks it up again (the player's
            // `web::TRIES`, 3 in all).
            Err(e) if e.contains("HTTP Error 403") && tries < 3 => tries += 1,
            Err(e) if !gone(&e) && !UPDATED.swap(true, Ordering::Relaxed) => {
                let _ = Command::new("timeout").args(["120", "yt-dlp", "-U"]).output();
                return run()?.ok();
            }
            Err(_) => return None,
        }
    }
}

/// The uploads yt-dlp lists for `args`, one JSON a line. A search's list also holds
/// channels (`ie_key` `YoutubeTab`): only videos are kept (a channel "R.A.D®" in "rad"
/// was a song row that could not play, its look-up failing on every look-ahead; found
/// 2026-11-05). A full read (a pasted link) has no `ie_key`.
pub fn videos(args: &[&str]) -> Option<Vec<Video>> {
    let out = yt_dlp(&[&["--dump-json"], args].concat())?;
    let only_videos = |v: &Value| v["ie_key"].as_str().is_none_or(|k| k == "Youtube");
    let found = out.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(only_videos).map(|v| Video {
        id: text(&v["id"]),
        title: text(&v["title"]),
        channel: Some(text(&v["channel"])).filter(|c| !c.is_empty()).unwrap_or_else(|| text(&v["uploader"])),
        length: v["duration"].as_f64().map(|d| d.round() as u32),
        views: v["view_count"].as_u64().unwrap_or(0),
    });
    Some(found.collect())
}

/// YouTube's first 15 songs for `q`, or the one a pasted YouTube link names.
pub fn youtube(q: &str) -> Option<Vec<Video>> {
    if is_link(q) { videos(&["--no-playlist", "--", q]) } else { videos(&["--flat-playlist", "--", &format!("ytsearch15:{q}")]) }
}

/// A YouTube song's link, its key when it plays from YouTube.
pub fn watch(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}

/// YouTube's Opus, the download's pick.
pub const FORMAT: &str = "bestaudio[ext=webm][acodec=opus]/bestaudio";

/// The song's address (YouTube's own file) looked up ahead for the player (step 5
/// piece C): the lines its `web::PRINT` asks for, in its order, handed over as printed.
pub fn address(link: &str) -> Option<String> {
    let mut args = vec!["-f", FORMAT, "--no-playlist"];
    for p in ["url", "duration", "id", "title", "%(channel,uploader)s"] {
        args.extend(["--print", p]);
    }
    args.extend(["--", link]);
    yt_dlp(&args).filter(|t| t.starts_with("http"))
}

/// An address still good: it stops working at its `expire` (about 6 h after the
/// look-up); the player looks again within 10 min of it, so this does too.
pub fn fresh(address: &str) -> bool {
    let url = address.lines().next().unwrap_or_default();
    let expire = url.split(['?', '&']).find_map(|p| p.strip_prefix("expire=")).and_then(|s| s.parse::<u64>().ok());
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    expire.is_some_and(|e| now + 600 < e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_fresh_until_ten_minutes_before_it_ends() {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        assert!(fresh(&format!("https://x/videoplayback?expire={}&id=1\n185", now + 3600)));
        assert!(!fresh(&format!("https://x/videoplayback?id=1&expire={}", now + 300)));
        assert!(!fresh("https://x/videoplayback"));
        assert!(!fresh(""));
        assert_eq!(plain("AC/DC - T.N.T. (Live)"), "acdctntlive");
    }
}

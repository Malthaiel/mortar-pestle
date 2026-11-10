//! Downloading an album's songs (M&P Library plan, step 5 piece B): Windows'
//! `download_album.py` without its Python helper, its pages or its two extra tries
//! (his picks 2026-10-31). Each song missing from the album folder comes from the
//! link `sources` keeps for it, else from the YouTube upload Windows' rules pick; as
//! opus with no re-encode (yt-dlp, `bestaudio` + `-x` copies the sound as it is), its
//! details written in by lofty, its length checked against MusicBrainz's, then moved
//! into `~/Music`. Runs off the strip's drawing thread, in the strip: shutting the box
//! doesn't stop it. A YouTube song downloads on its own too,
//! into its channel's `Singles` (piece C); a playlist's songs (step 4 piece D) come
//! as one run of jobs: an album's into that album, the rest each on its own.

use std::cmp::Reverse;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::{fs, thread};

use iced::futures::channel::mpsc::UnboundedSender;

use crate::music::library;
use crate::music::release::Track;
use crate::music::web::{self, Video};

/// Songs fetched at once (his pick: one vs three timed, the faster kept). Without
/// Warning's 10 songs: one at a time 22.8 / 24.0 s, three 9.0 / 10.0 s, the same 7.9 s
/// of processor and none refused (chat 33).
const AT_ONCE: usize = 3;
/// Words in an upload's title that mark another version of the song, unless the
/// song's own title has them (Windows' `EXCLUDE_WORDS`: fan edits pass the length
/// rule when the song is short).
const OTHER: [&str; 15] = ["live", "remix", "cover", "karaoke", "instrumental", "demo", "slowed", "slower", "sped up", "speed up", "reverb", "nightcore", "extended", "bass boosted", "backwards"];
/// Seconds off MusicBrainz's length: farther = another song; this close = as long
/// (Windows': a 345-view rip one second closer beat the 149k-view upload).
const FAR: u32 = 30;
const EVEN: u32 = 3;
/// A downloaded song this far off MusicBrainz's length is thrown away (Windows').
const OFF: f64 = 5.0;

/// A song to fetch: its place and details, its file name, the link saved for it.
pub struct Want {
    pub track: Track,
    pub name: String,
    pub saved: Option<String>,
}

pub struct Job {
    /// The album folder under `~/Music`, its artist, title and year; for songs on
    /// their own (`alone`) none of these: each song's `name` is its whole key and its
    /// track's artist its own.
    pub key: String,
    pub artist: String,
    pub album: String,
    pub year: u32,
    pub several: bool,
    pub alone: bool,
    pub songs: Vec<Want>,
}

#[derive(Debug, Clone)]
pub enum Event {
    /// A song is done: its key and the link it came from, or none when not found.
    Song(Option<(String, String)>),
    End,
}

/// Fetches the jobs' songs, `AT_ONCE` at a time, telling the window each one.
pub fn run(jobs: Vec<Job>, tx: UnboundedSender<Event>) {
    let temp = web::cache().join("download");
    // What a stopped download left behind (one run at a time: nothing else is here).
    let _ = fs::remove_dir_all(&temp);
    if let Err(e) = fs::create_dir_all(&temp) {
        eprintln!("mp-shell: music: {}: {e}", temp.display());
    }
    // Each song's file in the cache is named by its place in the run: a plain name
    // (yt-dlp reads `%` in it as its own, and a title may have one), and two albums'
    // first songs don't meet.
    let all: Vec<(usize, (&Job, &Want))> = jobs.iter().flat_map(|j| j.songs.iter().map(move |w| (j, w))).enumerate().collect();
    let left = Mutex::new(all.into_iter().rev().collect::<Vec<_>>());
    let next = || left.lock().unwrap_or_else(|e| e.into_inner()).pop();
    let (temp, next) = (&temp, &next);
    thread::scope(|s| {
        for _ in 0..AT_ONCE {
            let tx = tx.clone();
            s.spawn(move || {
                while let Some((i, (job, want))) = next() {
                    let base = temp.join(i.to_string());
                    let got = if job.alone { alone(want, &base) } else { fetch(job, want, &base) };
                    let _ = tx.unbounded_send(Event::Song(got));
                }
            });
        }
    });
    let _ = tx.unbounded_send(Event::End);
}

/// One song: the saved link, else (or when it fails) the picked upload; into the
/// album folder once tagged and checked. Its key and link.
fn fetch(job: &Job, want: &Want, base: &Path) -> Option<(String, String)> {
    let t = &want.track;
    let saved = want.saved.as_ref().and_then(|url| Some((take(url, base, job, t)?, url.clone())));
    let (file, url) = match saved {
        Some(got) => got,
        None => {
            let url = find(&job.artist, t)?;
            (take(&url, base, job, t)?, url)
        }
    };
    put(&file, &library::music().join(&job.key).join(format!("{}.opus", want.name)))?;
    Some((format!("{}/{}", job.key, want.name), url))
}

/// Where a YouTube song downloaded on its own goes, its key: `<channel>/Singles/<title>`
/// (his pick, where his two Windows singles are).
pub fn single_key(v: &Video) -> String {
    alone_key(&v.channel, &v.title)
}

/// Where a song on its own goes, in Downloaded Songs: `<artist>/Singles/<title>`.
pub fn alone_key(artist: &str, title: &str) -> String {
    format!("{}/Singles/{}", library::folder(artist), library::folder(title))
}

/// A playlist's song on its own (piece D): its saved link, else (or when it fails)
/// the upload found by its names (the album rules, its own artist); its names and
/// link written in, no length check (as a YouTube song's arrow: the upload is the
/// song); into its place, `name` being its whole key. Its key and link.
fn alone(want: &Want, base: &Path) -> Option<(String, String)> {
    let t = &want.track;
    let saved = want.saved.as_ref().and_then(|url| Some((grab(url, base)?, url.clone())));
    let (file, url) = match saved {
        Some(got) => got,
        None => {
            let url = find(&t.artist, t)?;
            (grab(&url, base)?, url)
        }
    };
    tag(&file, vec![("TITLE", t.title.clone()), ("ARTIST", t.artist.clone()), ("SOURCE_URL", url.clone())])?;
    put(&file, &library::music().join(format!("{}.opus", want.name)))?;
    Some((want.name.clone(), url))
}

/// One YouTube song on its own (the arrow on its row, piece C): its title, its channel
/// as the artist and its link written in, no length check (Windows': the upload is
/// the song). Its key, or none.
pub fn single(v: &Video) -> Option<String> {
    let temp = web::cache().join("single");
    fs::create_dir_all(&temp).ok()?;
    let url = web::watch(&v.id);
    let file = grab(&url, &temp.join(&v.id))?;
    tag(&file, vec![("TITLE", v.title.clone()), ("ARTIST", v.channel.clone()), ("SOURCE_URL", url)])?;
    let key = single_key(v);
    put(&file, &library::music().join(format!("{key}.opus")))?;
    Some(key)
}

/// Moves a finished song into `~/Music` (copied when the cache is on another disk).
fn put(file: &Path, to: &Path) -> Option<()> {
    let moved = fs::create_dir_all(to.parent()?).and_then(|_| fs::rename(file, to).or_else(|_| fs::copy(file, to).and_then(|_| fs::remove_file(file))));
    moved.map_err(|e| eprintln!("mp-shell: music: {}: {e}", to.display())).ok()
}

/// Downloads `url` as opus, writes the song's details in, checks its length; the
/// file, or none (a wrong length is thrown away).
fn take(url: &str, base: &Path, job: &Job, t: &Track) -> Option<PathBuf> {
    let file = grab(url, base)?;
    let length = details(&file, job, t, url);
    let fits = match (length, t.length) {
        (Some(got), Some(want)) => (got - want as f64).abs() <= OFF,
        (got, _) => got.is_some(),
    };
    if !fits {
        eprintln!("mp-shell: music: {url}: {:?} s, MusicBrainz says {:?} s", length, t.length);
        let _ = fs::remove_file(&file);
        return None;
    }
    Some(file)
}

/// The upload at `url` as opus at `base`.opus, its sound copied as it is.
fn grab(url: &str, base: &Path) -> Option<PathBuf> {
    let out = format!("{}.%(ext)s", base.display());
    web::yt_dlp_within(web::DOWNLOAD, &["-q", "-f", web::FORMAT, "-x", "--audio-format", "opus", "--audio-quality", "0", "--no-playlist", "-o", &out, "--", url])?;
    Some(PathBuf::from(format!("{}.opus", base.display())))
}

/// Windows' seven details (the disc only on an album with several), written over
/// whatever came with the file; then its length, read back.
fn details(file: &Path, job: &Job, t: &Track, url: &str) -> Option<f64> {
    let mut fields = vec![("TITLE", t.title.clone()), ("ARTIST", t.artist.clone()), ("ALBUM", job.album.clone()), ("TRACKNUMBER", t.n.to_string())];
    if job.several {
        fields.push(("DISCNUMBER", t.disc.to_string()));
    }
    if job.year > 0 {
        fields.push(("DATE", job.year.to_string()));
    }
    fields.push(("SOURCE_URL", url.to_string()));
    tag(file, fields)
}

/// Writes `fields` over whatever came with the file; its length, read back.
fn tag(file: &Path, fields: Vec<(&str, String)>) -> Option<f64> {
    use lofty::config::WriteOptions;
    use lofty::ogg::tag::VorbisComments;
    use lofty::prelude::*;

    let mut tag = VorbisComments::default();
    for (k, v) in fields.into_iter().filter(|f| !f.1.is_empty()) {
        tag.push(k.into(), v);
    }
    if let Err(e) = tag.save_to_path(file, WriteOptions::default()) {
        eprintln!("mp-shell: music: {}: {e}", file.display());
        return None;
    }
    Some(lofty::read_from_path(file).ok()?.properties().duration().as_secs_f64())
}

/// The upload for a song of `artist`'s album (Windows' `resolve_source` without its
/// two extra tries): a search for its artist and title, then once more with the title
/// in quotes. A download's, and the look-ahead's for a song played off the internet.
pub fn find(artist: &str, t: &Track) -> Option<String> {
    let title = plain(&t.title);
    let who = if t.lead.is_empty() { artist } else { &t.lead };
    let found = web::videos(&["--flat-playlist", "--", &format!("ytsearch10:{who} {title}")])?;
    // Not one upload names the album's artist: the search is junk (Windows'
    // plausibility gate; where it went next is cut, his pick).
    let named = words(artist);
    let names = |v: &Video| {
        let hay = format!("{} {}", v.title, v.channel).to_lowercase();
        named.iter().any(|w| hay.contains(w.as_str()))
    };
    if !found.is_empty() && !named.is_empty() && !found.iter().any(names) {
        eprintln!("mp-shell: music: no upload names {artist} for {title}");
        return None;
    }
    let best = match pick(&found, t.length, &title) {
        Some(v) => v.id.clone(),
        None => pick(&web::videos(&["--flat-playlist", "--", &format!("ytsearch10:\"{title}\" {who}")])?, t.length, &title)?.id.clone(),
    };
    Some(web::watch(&best))
}

/// Windows' `score_candidates`: no other version's words, every word of the title,
/// within 30 s of MusicBrainz's length; then the closest (within 3 s counts as
/// even), a '- Topic' channel (the label's own upload), the most viewed.
fn pick<'a>(found: &'a [Video], length: Option<u32>, title: &str) -> Option<&'a Video> {
    let own = title.to_lowercase();
    let need = words(title);
    let ranked = found.iter().filter_map(|v| {
        let named = v.title.to_lowercase();
        if OTHER.iter().any(|w| named.contains(w) && !own.contains(w)) || !need.iter().all(|w| named.contains(w.as_str())) {
            return None;
        }
        let off = match (length, v.length) {
            (Some(a), Some(b)) if a.abs_diff(b) > FAR => return None,
            (Some(a), Some(b)) => a.abs_diff(b),
            _ => u32::MAX,
        };
        let topic = v.channel.trim_end().ends_with("- Topic");
        Some(((if off > EVEN { off } else { 0 }, !topic, Reverse(v.views)), v))
    });
    ranked.min_by_key(|r| r.0).map(|r| r.1)
}

/// The words of a name that tell it apart: runs of 3+ plain letters or digits
/// (Windows' `tokens_of`; a title in another script has none and passes).
fn words(s: &str) -> Vec<String> {
    s.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| w.len() >= 3).map(String::from).collect()
}

/// MusicBrainz's typographic dashes and quotes as typed ones: a YouTube search
/// matches nothing with them (Windows' `PLAIN_PUNCT`).
fn plain(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\u{2010}'..='\u{2014}' => '-',
            '\u{2018}' | '\u{2019}' => '\'',
            '\u{201C}' | '\u{201D}' => '"',
            c => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(id: &str, title: &str, channel: &str, length: u32, views: u64) -> Video {
        Video { id: id.into(), title: title.into(), channel: channel.into(), length: Some(length), views }
    }

    #[test]
    fn the_upload_picked_is_the_song_itself() {
        let found = [
            video("live", "Change (In the House of Flies) (Live)", "Deftones", 300, 9_000_000),
            video("far", "Change (In the House of Flies)", "Someone", 400, 8_000_000),
            video("fan", "Change (In the House of Flies)", "A fan", 301, 5_000_000),
            video("topic", "Change (In the House of Flies)", "Deftones - Topic", 299, 1_000),
            video("other", "Digital Bath", "Deftones - Topic", 300, 1),
        ];
        // No other version, every word of the title, near its length; then the label's own.
        assert_eq!(pick(&found, Some(300), "Change (In the House of Flies)").map(|v| v.id.as_str()), Some("topic"));
        // A version asked for by name is no "other version".
        assert_eq!(pick(&found[..1], Some(300), "Change (In the House of Flies) (Live)").map(|v| v.id.as_str()), Some("live"));
        // Among evens, the most viewed; nothing fits: none.
        assert_eq!(pick(&found[1..3], None, "Change").map(|v| v.id.as_str()), Some("far"));
        assert!(pick(&found[4..], Some(300), "Change").is_none());
        assert_eq!(words("It's a 7 MILE-long road"), ["mile", "long", "road"]);
    }
}

//! An album's songs as MusicBrainz lists them (M&P Library plan, step 3 piece B):
//! one ask a visit, kept as it came in `~/.cache/mp-library/release/<id>.json`, so
//! the next visit shows it at once and re-checks behind it (his rule: saved copy
//! first, a fresh look every visit). The same ask brings the album's type and
//! genres, and everyone credited (piece C); the songs' Spotify plays come in one
//! more ask, kept the same way. Asked through the system's `curl` (`web::ask`), as the
//! shell asks for words.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::music::library::{self, Album};
use crate::music::web::{self, credit, text};

/// Songs with their artists and the people on
/// the release and its recordings: one ask (Windows made a second for the people;
/// Deftones' private music: 13 -> 80 KB, 0.56 -> 0.90 s, measured chat 45).
const INC: &str = "recordings+artist-credits+artist-rels+recording-level-rels";

#[derive(Debug, Clone, Default)]
pub struct Release {
    pub tracks: Vec<Track>,
    /// Everyone credited, the lead artist first.
    pub credits: Vec<Credit>,
}

/// A person on the album and their jobs (Windows' `AlbumPerformers`).
#[derive(Debug, Clone)]
pub struct Credit {
    /// Their MusicBrainz id; none on an album with no release.
    pub id: String,
    pub name: String,
    /// Up to three, then how many more.
    pub roles: String,
}

#[derive(Debug, Clone)]
pub struct Track {
    /// Its MusicBrainz recording, what its Spotify plays are kept by.
    pub recording: String,
    pub disc: u32,
    pub n: u32,
    pub title: String,
    pub artist: String,
    /// The first artist credited: the one a YouTube search names (Windows' `lead_artist`).
    pub lead: String,
    /// Seconds.
    pub length: Option<u32>,
}

fn saved_at(id: &str) -> PathBuf {
    web::cache().join("release").join(format!("{id}.json"))
}

/// The copy kept from the last ask, if any.
pub fn saved(id: &str) -> Option<Release> {
    parse(&fs::read_to_string(saved_at(id)).ok()?)
}

/// Asks MusicBrainz (waits its turn, blocks), keeps a good answer.
pub fn fetch(id: &str) -> Option<Release> {
    let json = web::ask(&format!("release/{id}?inc={INC}&fmt=json"), &[])?;
    let release = parse(&json)?;
    let path = saved_at(id);
    if fs::read_to_string(&path).ok().as_deref() != Some(json.as_str()) {
        library::write(&path, json.clone());
    }
    Some(release)
}

fn plays_at(id: &str) -> PathBuf {
    web::cache().join("spotify-plays").join(id)
}

/// The album's Spotify plays kept from the last ask, a song's recording and its count
/// a line.
pub fn saved_plays(id: &str) -> Vec<(String, u64)> {
    let kept = fs::read_to_string(plays_at(id)).unwrap_or_default();
    kept.lines().filter_map(|l| l.split_once('\t')).filter_map(|(song, n)| Some((song.to_string(), n.parse().ok()?))).collect()
}

/// Asks for the album's Spotify plays off its lead artist's page (blocks), keeps a good
/// answer.
pub fn fetch_plays(id: &str, artist: &str, name: &str, songs: &[(String, String)]) -> Option<Vec<(String, u64)>> {
    let plays = web::plays(artist, name, songs)?;
    let lines: String = plays.iter().map(|(song, n)| format!("{song}\t{n}\n")).collect();
    library::write(&plays_at(id), lines);
    Some(plays)
}

fn parse(json: &str) -> Option<Release> {
    let v: Value = serde_json::from_str(json).ok()?;
    let mut tracks = Vec::new();
    for medium in v["media"].as_array()? {
        let disc = medium["position"].as_u64().unwrap_or(1) as u32;
        for t in medium["tracks"].as_array().into_iter().flatten() {
            let ms = t["length"].as_u64().or_else(|| t["recording"]["length"].as_u64());
            tracks.push(Track {
                recording: text(&t["recording"]["id"]),
                disc,
                n: t["position"].as_u64().unwrap_or(0) as u32,
                title: text(&t["title"]),
                artist: credit(t),
                lead: text(&t["artist-credit"][0]["name"]),
                length: ms.map(|ms| ((ms + 500) / 1000) as u32),
            });
        }
    }
    Some(Release { tracks, credits: credits(&v) })
}

/// Everyone on the release, one entry a person, their jobs in the order found
/// (Windows' `music_release_personnel` + `AlbumPerformers`): the credited artists, then
/// the release's relations, then each recording's, where most performers are kept.
fn credits(v: &Value) -> Vec<Credit> {
    let mut people: Vec<(String, String, Vec<String>)> = Vec::new();
    let mut add = |id: String, name: String, role: String| {
        if name.is_empty() {
            return;
        }
        let at = people.iter().position(|p| if id.is_empty() { p.1 == name } else { p.0 == id }).unwrap_or_else(|| {
            people.push((id, name, Vec::new()));
            people.len() - 1
        });
        if !people[at].2.contains(&role) {
            people[at].2.push(role);
        }
    };
    for (i, c) in v["artist-credit"].as_array().into_iter().flatten().enumerate() {
        let name = Some(text(&c["artist"]["name"])).filter(|n| !n.is_empty()).unwrap_or_else(|| text(&c["name"]));
        add(text(&c["artist"]["id"]), name, if i == 0 { "Primary artist" } else { "Featured artist" }.into());
    }
    let recordings = v["media"].as_array().into_iter().flatten().flat_map(|m| m["tracks"].as_array().into_iter().flatten()).map(|t| &t["recording"]);
    for holder in std::iter::once(v).chain(recordings) {
        for r in holder["relations"].as_array().into_iter().flatten().filter(|r| r["artist"].is_object()) {
            add(text(&r["artist"]["id"]), text(&r["artist"]["name"]), role(r));
        }
    }
    let shown = |roles: Vec<String>| {
        let first = roles[..roles.len().min(3)].join(" · ");
        if roles.len() > 3 { format!("{first} +{}", roles.len() - 3) } else { first }
    };
    people.into_iter().map(|(id, name, roles)| Credit { id, name, roles: shown(roles) }).collect()
}

/// A relation's job (Windows' `credit_from_relation`): the instrument or voice itself
/// when it names one, else the kind of work and its details.
fn role(r: &Value) -> String {
    let kind = r["type"].as_str().unwrap_or_default();
    let details: Vec<&str> = r["attributes"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let details = details.join(", ");
    let work = match kind {
        "mix" => "Mixing".to_string(),
        "vocal" => "Vocals".to_string(),
        "instrument" => "Performer".to_string(),
        "" => "Contributor".to_string(),
        other => first_big(other),
    };
    match (details.is_empty(), matches!(kind, "instrument" | "vocal")) {
        (true, _) => work,
        (false, true) => first_big(&details),
        (false, false) => format!("{work} ({details})"),
    }
}

fn first_big(s: &str) -> String {
    let mut letters = s.chars();
    letters.next().map(|f| f.to_uppercase().chain(letters).collect()).unwrap_or_default()
}

/// An album with no release to ask for: its files, numbered and named as they are
/// saved (`NN Title`, `D-NN Title`), lengths read off them.
pub fn from_files(album: &Album) -> Release {
    use lofty::prelude::*;
    let files: Vec<PathBuf> = fs::read_dir(library::music().join(&album.key)).into_iter().flatten().flatten().map(|e| e.path()).collect();
    let tracks = album
        .songs
        .iter()
        .map(|key| {
            let name = key.rsplit('/').next().unwrap_or_default();
            let (disc, n) = library::place(name).unwrap_or((1, 0));
            let file = files.iter().find(|p| p.file_stem().is_some_and(|s| s.to_string_lossy() == name));
            let length = file.and_then(|f| lofty::read_from_path(f).ok()).map(|f| f.properties().duration().as_secs_f64().round() as u32);
            let title = library::bare(name).to_string();
            Track { recording: String::new(), disc, n, title, artist: album.artist.clone(), lead: album.artist.clone(), length }
        })
        .collect();
    Release { tracks, credits: vec![Credit { id: String::new(), name: album.artist.clone(), roles: "Primary artist".into() }] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_is_read_into_its_songs() {
        let json = r#"{"media":[{"position":2,"tracks":[{"position":3,"title":"Song","length":185499,
            "artist-credit":[{"name":"A","joinphrase":" & "},{"name":"B"}],"recording":{"id":"rec","length":1}}]},
            {"tracks":[{"title":"No numbers","recording":{"length":2500}}]}]}"#;
        let r = parse(json).unwrap();
        let t = &r.tracks[0];
        assert_eq!((t.disc, t.n, t.title.as_str(), t.lead.as_str(), t.length, t.recording.as_str()), (2, 3, "Song", "A", Some(185), "rec"));
        // No place given: disc 1, no number; the recording's length stands in, rounded.
        assert_eq!((r.tracks[1].disc, r.tracks[1].n, r.tracks[1].length), (1, 0, Some(3)));
        assert!(parse("{}").is_none());
    }

    #[test]
    fn a_job_is_named_as_the_page_shows_it() {
        let role = |json: &str| role(&serde_json::from_str(json).unwrap());
        assert_eq!(role(r#"{"type":"mix"}"#), "Mixing");
        assert_eq!(role(r#"{"type":"instrument","attributes":["bass guitar"]}"#), "Bass guitar");
        assert_eq!(role(r#"{"type":"vocal"}"#), "Vocals");
        assert_eq!(role(r#"{"type":"producer","attributes":["co"]}"#), "Producer (co)");
        assert_eq!(role("{}"), "Contributor");
    }
}

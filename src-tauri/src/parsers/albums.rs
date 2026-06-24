//! Music album + track resolution.
//!
//! Ported from the now-removed Node sidecar (`server/src/vault/music.js`). Sub-feature 7 of the Desktop-Only
//! Migration.
//!
//! Albums live as markdown pages at:
//!   `Knowledge/Music/MusicBrainz Pipeline/Albums/<Title> (by <Artist> - <Year>).md`
//! Track audio files live at:
//!   `Knowledge/Music/MusicBrainz Pipeline/Tracks/<Artist> - <Title>/NN - <Track>.opus`
//!
//! Body-table tracks are canonical (order, titles, durations, wikilinks).
//! Audio files fill in what's actually playable.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::commands::vault::{atomic_write, check_mtime, library_vault_root, mtime_ms, VaultError};
use crate::parsers::frontmatter::{parse_frontmatter, set_frontmatter_field};

const ALBUMS_DIR: &str = "Music/Albums";
const TRACKS_DIR: &str = "Music/Tracks";

static RE_DASH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\u{2010}-\u{2015}\u{2212}]").unwrap());
static RE_SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static RE_WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]$").unwrap());
static RE_DISC_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*###\s+Disc\s+(\d+)\s*$").unwrap());
static RE_TRACK_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([\d:]+)?\s*\|").unwrap());
static RE_CELL_WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]\s*$").unwrap());
static RE_DURATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d+):(\d{1,2})(?::(\d{1,2}))?$").unwrap());
static RE_TRACK_NUM_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d+)\s*-\s*").unwrap());
static RE_AUDIO_EXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.(opus|ogg|mp3|m4a|flac)$").unwrap());

const SENT: char = '\u{0001}';

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSummary {
    pub path: String,
    pub name: String,
    pub title: String,
    pub artist: String,
    pub year: Option<Value>,
    pub image: Option<String>,
    pub status: Option<String>,
    pub personal_rating: f64,
    pub genres: Vec<String>,
    pub release_type: Option<String>,
    pub track_count: Option<Value>,
    pub length: Option<String>,
    pub mtime: f64,
    pub release_id: Option<String>,
    pub provider_id: Option<String>,
    pub tracks_present: i64,
    pub tracks_total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub n: i64,
    pub title: String,
    pub wikilink: Option<String>,
    pub duration: Option<i64>,
    pub disc: i64,
    pub audio_path: Option<String>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub artists: Vec<String>,
    pub year: Option<Value>,
    pub image: Option<String>,
    pub status: Option<String>,
    pub personal_rating: f64,
    pub genres: Vec<String>,
    pub labels: Vec<String>,
    pub country: Option<String>,
    pub release_type: Option<String>,
    pub track_count: Value,
    pub length: Option<String>,
    pub release_id: Option<String>,
    /// MusicBrainz release-group MBID (`Provider ID:`) — the id the download
    /// flow keys on, so a metadata-only card can be downloaded later.
    pub provider_id: Option<String>,
    pub source_url: Option<String>,
    pub tracks: Vec<Track>,
    pub track_folder: Option<String>,
    /// User-owned `## Notes` body section (empty when absent).
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MarkStatusResponse {
    pub ok: bool,
    pub status: String,
    pub mtime: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkRatingResponse {
    pub ok: bool,
    pub personal_rating: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesResponse {
    pub ok: bool,
    pub notes: String,
    pub mtime: f64,
}

fn normalize_for_folder(s: &str) -> String {
    let nfc: String = s.nfc().collect();
    let no_dash = RE_DASH.replace_all(&nfc, "-");
    RE_SPACES.replace_all(&no_dash, " ").trim().to_string()
}

fn as_str_array(v: Option<&Value>) -> Vec<Value> {
    match v {
        None => Vec::new(),
        Some(Value::Null) => Vec::new(),
        Some(Value::String(s)) if s.is_empty() => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(other) => vec![other.clone()],
    }
}

fn as_strings(v: Option<&Value>) -> Vec<String> {
    as_str_array(v)
        .iter()
        .map(|x| match x {
            Value::String(s) => s.clone(),
            other => other.to_string().trim_matches('"').to_string(),
        })
        .collect()
}

fn strip_wikilink(s: &str) -> String {
    if let Some(c) = RE_WIKILINK.captures(s) {
        let target = c
            .get(2)
            .map(|m| m.as_str())
            .unwrap_or_else(|| c.get(1).unwrap().as_str());
        return target.split('/').last().unwrap_or(target).to_string();
    }
    s.to_string()
}

fn first_artist(meta: &Map<String, Value>) -> String {
    let artists: Vec<String> = as_str_array(meta.get("Artists"))
        .iter()
        .filter_map(|v| v.as_str().map(|s| strip_wikilink(s)))
        .collect();
    if let Some(first) = artists.into_iter().find(|s| !s.is_empty()) {
        return first;
    }
    if let Some(s) = meta.get("Artist").and_then(|v| v.as_str()) {
        return strip_wikilink(s);
    }
    String::new()
}

fn track_folder_name(meta: &Map<String, Value>) -> Option<String> {
    let artist = normalize_for_folder(&first_artist(meta));
    let title_raw = meta.get("Title").and_then(|v| v.as_str()).unwrap_or("");
    let title = normalize_for_folder(title_raw);
    if artist.is_empty() || title.is_empty() {
        return None;
    }
    Some(format!("{artist} - {title}"))
}

fn parse_duration_to_seconds(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    let c = RE_DURATION.captures(trimmed)?;
    let a: i64 = c.get(1)?.as_str().parse().ok()?;
    let b: i64 = c.get(2)?.as_str().parse().ok()?;
    if let Some(sec_m) = c.get(3) {
        let s_val: i64 = sec_m.as_str().parse().ok()?;
        return Some(a * 3600 + b * 60 + s_val);
    }
    Some(a * 60 + b)
}

#[derive(Debug, Clone)]
struct TableTrack {
    n: i64,
    title: String,
    wikilink: Option<String>,
    duration: Option<i64>,
    disc: i64,
}

fn parse_track_table(body: &str) -> Vec<TableTrack> {
    let mut out = Vec::new();
    let mut current_disc: i64 = 1;
    for raw in body.split('\n') {
        if let Some(c) = RE_DISC_HEADER.captures(raw) {
            current_disc = c.get(1).unwrap().as_str().parse().unwrap_or(current_disc);
            continue;
        }
        let line = raw.replace("\\|", &SENT.to_string());
        let Some(m) = RE_TRACK_ROW.captures(&line) else {
            continue;
        };
        let Some(n) = m.get(1).and_then(|x| x.as_str().parse::<i64>().ok()) else {
            continue;
        };
        let cell = m.get(2).unwrap().as_str().trim().replace(SENT, "|");
        let (title, wikilink) = if let Some(c) = RE_CELL_WIKILINK.captures(cell.trim()) {
            let wl = c.get(1).unwrap().as_str().trim().to_string();
            let display = c
                .get(2)
                .map(|x| x.as_str().trim().to_string())
                .unwrap_or_else(|| wl.clone());
            (display, Some(wl))
        } else {
            (cell, None)
        };
        let duration = m
            .get(3)
            .and_then(|x| parse_duration_to_seconds(x.as_str()));
        out.push(TableTrack {
            n,
            title,
            wikilink,
            duration,
            disc: current_disc,
        });
    }
    out
}

fn safe_read_dir(p: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(p) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

fn meta_str(meta: &Map<String, Value>, key: &str) -> Option<String> {
    meta.get(key).and_then(|v| match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    })
}

fn meta_clone(meta: &Map<String, Value>, key: &str) -> Option<Value> {
    meta.get(key).and_then(|v| match v {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        other => Some(other.clone()),
    })
}

fn meta_f64(meta: &Map<String, Value>, key: &str) -> f64 {
    meta.get(key)
        .and_then(|v| match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.parse::<f64>().ok(),
            _ => None,
        })
        .filter(|f| f.is_finite())
        .unwrap_or(0.0)
}

fn meta_i64(meta: &Map<String, Value>, key: &str) -> Option<i64> {
    meta.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    })
}

/// Count distinct leading-numbered audio files in an album's track folder — the
/// "tracks present on disk" for the Browse repair badge. Matches the audio-file
/// resolution `read_album` uses (folder name + `NN - …` prefix).
fn count_present_tracks(meta: &Map<String, Value>) -> i64 {
    let Some(folder) = track_folder_name(meta) else {
        return 0;
    };
    let dir = tracks_dir().join(folder);
    let mut nums = std::collections::HashSet::new();
    for f in safe_read_dir(&dir) {
        if !RE_AUDIO_EXT.is_match(&f) {
            continue;
        }
        if let Some(c) = RE_TRACK_NUM_PREFIX.captures(&f) {
            if let Some(n) = c.get(1).and_then(|x| x.as_str().parse::<i64>().ok()) {
                nums.insert(n);
            }
        }
    }
    nums.len() as i64
}

fn albums_dir() -> PathBuf {
    PathBuf::from(library_vault_root()).join(ALBUMS_DIR)
}

fn tracks_dir() -> PathBuf {
    PathBuf::from(library_vault_root()).join(TRACKS_DIR)
}

/// An album's on-disk files for recycling-bin capture: the `.md` card, local
/// cover sidecars (a remote CoverArtArchive URL is skipped — nothing on disk),
/// and the track-audio folder. The card is always present; the cover/folder are
/// optional. Gathered by `collect_album_files`; deletes nothing.
pub struct AlbumFiles {
    pub card_rel: String,
    pub card_abs: PathBuf,
    pub sidecars: Vec<(String, PathBuf)>,
    pub track_folder: Option<(String, PathBuf)>,
}

/// Gather an album's files (card + local cover + track-audio folder) for the
/// recycling bin. All paths are vault-relative under the library mount. Errors
/// only if the card itself is missing.
pub fn collect_album_files(album_path: &str) -> Result<AlbumFiles, VaultError> {
    let card_abs = PathBuf::from(library_vault_root()).join(album_path);
    if !card_abs.exists() {
        return Err(VaultError::NotFound(format!("Album not found: {album_path}")));
    }
    let mut sidecars: Vec<(String, PathBuf)> = Vec::new();
    let mut track_folder: Option<(String, PathBuf)> = None;
    if let Ok(text) = fs::read_to_string(&card_abs) {
        let (meta, _body) = parse_frontmatter(&text);
        // Local cover only — a remote CAA URL has nothing on disk to capture.
        if let Some(img) = meta_str(&meta, "Image") {
            if !img.starts_with("http://") && !img.starts_with("https://") {
                let p = PathBuf::from(library_vault_root()).join(&img);
                if p.exists() {
                    sidecars.push((img, p));
                }
            }
        }
        // The track-audio folder (the bulk of the album).
        if let Some(folder) = track_folder_name(&meta) {
            let abs = tracks_dir().join(&folder);
            if abs.is_dir() {
                track_folder = Some((format!("{TRACKS_DIR}/{folder}"), abs));
            }
        }
    }
    Ok(AlbumFiles { card_rel: album_path.to_string(), card_abs, sidecars, track_folder })
}

pub fn list_albums() -> Result<Vec<AlbumSummary>, VaultError> {
    let dir = albums_dir();
    let mut entries = safe_read_dir(&dir);
    entries.sort();
    let mut out = Vec::new();
    for entry in entries {
        if !entry.ends_with(".md") {
            continue;
        }
        let abs = dir.join(&entry);
        let Ok(text) = fs::read_to_string(&abs) else {
            continue;
        };
        let (meta, _body) = parse_frontmatter(&text);
        let stat = fs::metadata(&abs)?;
        let name = entry.trim_end_matches(".md").to_string();
        let tracks_present = count_present_tracks(&meta);
        out.push(AlbumSummary {
            path: format!("{ALBUMS_DIR}/{entry}"),
            name: name.clone(),
            title: meta_str(&meta, "Title").unwrap_or(name),
            artist: first_artist(&meta),
            year: meta_clone(&meta, "Year"),
            image: meta_str(&meta, "Image"),
            status: meta_str(&meta, "Status"),
            personal_rating: meta_f64(&meta, "Personal Rating"),
            genres: as_strings(meta.get("Genres")),
            release_type: meta_str(&meta, "Release Type"),
            track_count: meta_clone(&meta, "Track Count"),
            length: meta_str(&meta, "Length"),
            mtime: mtime_ms(&stat),
            release_id: meta_str(&meta, "Release ID"),
            provider_id: meta_str(&meta, "Provider ID"),
            tracks_present,
            tracks_total: meta_i64(&meta, "Track Count").unwrap_or(tracks_present),
        });
    }
    Ok(out)
}

pub fn read_album(album_path: &str) -> Result<Album, VaultError> {
    let abs = PathBuf::from(library_vault_root()).join(album_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!("Album not found: {album_path}")));
    }
    let text = fs::read_to_string(&abs)?;
    let (meta, body) = parse_frontmatter(&text);

    let table_tracks = parse_track_table(&body);
    let folder_name = track_folder_name(&meta);
    let track_folder_abs = folder_name
        .as_ref()
        .map(|n| tracks_dir().join(n));
    let track_folder_rel = folder_name
        .as_ref()
        .map(|n| format!("{TRACKS_DIR}/{n}"));
    let audio_files = track_folder_abs
        .as_ref()
        .map(|p| safe_read_dir(p))
        .unwrap_or_default();

    let mut audio_by_number: Vec<(i64, String)> = Vec::new();
    for file in &audio_files {
        if !RE_AUDIO_EXT.is_match(file) {
            continue;
        }
        let Some(c) = RE_TRACK_NUM_PREFIX.captures(file) else {
            continue;
        };
        let Some(n) = c.get(1).and_then(|x| x.as_str().parse::<i64>().ok()) else {
            continue;
        };
        if !audio_by_number.iter().any(|(k, _)| *k == n) {
            audio_by_number.push((n, file.clone()));
        }
    }

    let tracks: Vec<Track> = if !table_tracks.is_empty() {
        table_tracks
            .iter()
            .map(|t| {
                let file = audio_by_number.iter().find(|(k, _)| *k == t.n).map(|(_, f)| f.clone());
                let audio_path = file
                    .as_ref()
                    .and_then(|f| track_folder_rel.as_ref().map(|tf| format!("{tf}/{f}")));
                Track {
                    n: t.n,
                    title: t.title.clone(),
                    wikilink: t.wikilink.clone(),
                    duration: t.duration,
                    disc: t.disc,
                    available: file.is_some(),
                    audio_path,
                }
            })
            .collect()
    } else {
        let mut sorted = audio_by_number.clone();
        sorted.sort_by_key(|(k, _)| *k);
        sorted
            .into_iter()
            .map(|(n, file)| {
                let title = RE_TRACK_NUM_PREFIX
                    .replace(&file, "")
                    .to_string()
                    .rsplit_once('.')
                    .map(|(a, _)| a.to_string())
                    .unwrap_or_else(|| file.clone());
                let audio_path = track_folder_rel.as_ref().map(|tf| format!("{tf}/{file}"));
                Track {
                    n,
                    title,
                    wikilink: None,
                    duration: None,
                    disc: 1,
                    audio_path,
                    available: true,
                }
            })
            .collect()
    };

    let artists = as_strings(meta.get("Artists"));
    let labels = as_strings(meta.get("Label"));
    let track_count = meta
        .get("Track Count")
        .and_then(|v| match v {
            Value::Null => None,
            Value::String(s) if s.is_empty() => None,
            other => Some(other.clone()),
        })
        .unwrap_or_else(|| Value::from(tracks.len()));

    Ok(Album {
        path: album_path.to_string(),
        title: meta_str(&meta, "Title").unwrap_or_default(),
        artist: first_artist(&meta),
        artists,
        year: meta_clone(&meta, "Year"),
        image: meta_str(&meta, "Image"),
        status: meta_str(&meta, "Status"),
        personal_rating: meta_f64(&meta, "Personal Rating"),
        genres: as_strings(meta.get("Genres")),
        labels,
        country: meta_str(&meta, "Country"),
        release_type: meta_str(&meta, "Release Type"),
        track_count,
        length: meta_str(&meta, "Length"),
        release_id: meta_str(&meta, "Release ID"),
        provider_id: meta_str(&meta, "Provider ID"),
        source_url: meta_str(&meta, "Source URL"),
        tracks,
        track_folder: track_folder_rel,
        notes: extract_notes_section(&body),
    })
}

fn frontmatter_head_tail(text: &str) -> Result<(String, String), VaultError> {
    if !text.starts_with("---") {
        return Err(VaultError::NotFound("No frontmatter".into()));
    }
    let end = text[3..]
        .find("\n---")
        .ok_or_else(|| VaultError::NotFound("No frontmatter".into()))?
        + 3;
    Ok((text[..end].to_string(), text[end..].to_string()))
}

pub fn mark_status(
    album_path: &str,
    new_status: &str,
    base_mtime: Option<f64>,
) -> Result<MarkStatusResponse, VaultError> {
    let abs = PathBuf::from(library_vault_root()).join(album_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!("Album not found: {album_path}")));
    }
    check_mtime(&abs, base_mtime)?;
    let text = fs::read_to_string(&abs)?;
    let (head, tail) = frontmatter_head_tail(&text)?;
    let next_head = set_frontmatter_field(&head, "Status", new_status);
    let out = format!("{next_head}{tail}");
    atomic_write(&abs, out.as_bytes())?;
    let stat = fs::metadata(&abs)?;
    Ok(MarkStatusResponse {
        ok: true,
        status: new_status.to_string(),
        mtime: mtime_ms(&stat),
    })
}

pub fn mark_rating(
    album_path: &str,
    rating: f64,
    base_mtime: Option<f64>,
) -> Result<MarkRatingResponse, VaultError> {
    let abs = PathBuf::from(library_vault_root()).join(album_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!("Album not found: {album_path}")));
    }
    if !rating.is_finite() || rating < 0.0 || rating > 10.0 {
        return Err(VaultError::Invalid("Rating must be a number in [0, 10]".into()));
    }
    check_mtime(&abs, base_mtime)?;
    let text = fs::read_to_string(&abs)?;
    let (head, tail) = frontmatter_head_tail(&text)?;
    // Match Node's `String(r)` — integer if whole, decimal otherwise.
    let value = if rating.fract() == 0.0 {
        format!("{}", rating as i64)
    } else {
        format!("{rating}")
    };
    let next_head = set_frontmatter_field(&head, "Personal Rating", &value);
    let out = format!("{next_head}{tail}");
    atomic_write(&abs, out.as_bytes())?;
    Ok(MarkRatingResponse {
        ok: true,
        personal_rating: rating,
    })
}

/// Byte offset of a body line equal to `heading` (ignoring trailing
/// whitespace/CR), or None. Locates the user-owned `## Notes` section, which by
/// convention is the last body section (after `## Cover` / `## Tracks`).
fn find_h2_line(s: &str, heading: &str) -> Option<usize> {
    let mut off = 0usize;
    for line in s.split_inclusive('\n') {
        let t = line.trim_end_matches(|c: char| c == '\n' || c == '\r' || c == ' ' || c == '\t');
        if t == heading {
            return Some(off);
        }
        off += line.len();
    }
    None
}

/// Trimmed contents of the `## Notes` section (everything after the heading to
/// end of body), or empty when absent.
fn extract_notes_section(body: &str) -> String {
    match find_h2_line(body, "## Notes") {
        Some(start) => body[start..]
            .splitn(2, '\n')
            .nth(1)
            .unwrap_or("")
            .trim()
            .to_string(),
        None => String::new(),
    }
}

/// Rewrite the body (`tail`, everything after the frontmatter) so `notes` is the
/// trailing `## Notes` section — replacing an existing one or appending a new
/// one, preserving the machine-generated sections above. Empty `notes` removes
/// the section.
fn splice_notes_section(tail: &str, notes: &str) -> String {
    let trim_end = |s: &str| {
        s.trim_end_matches(|c: char| c == '\n' || c == '\r' || c == ' ' || c == '\t')
            .to_string()
    };
    let before = match find_h2_line(tail, "## Notes") {
        Some(start) => trim_end(&tail[..start]),
        None => trim_end(tail),
    };
    if notes.is_empty() {
        return format!("{before}\n");
    }
    format!("{before}\n\n## Notes\n\n{notes}\n")
}

/// Write the user-owned `## Notes` body section, preserving frontmatter and the
/// machine-generated sections. Mirrors `mark_status`'s mtime guard + atomic write.
pub fn write_notes(
    album_path: &str,
    notes: &str,
    base_mtime: Option<f64>,
) -> Result<NotesResponse, VaultError> {
    let abs = PathBuf::from(library_vault_root()).join(album_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!("Album not found: {album_path}")));
    }
    check_mtime(&abs, base_mtime)?;
    let text = fs::read_to_string(&abs)?;
    let (head, tail) = frontmatter_head_tail(&text)?;
    let trimmed = notes.trim();
    let new_tail = splice_notes_section(&tail, trimmed);
    let out = format!("{head}{new_tail}");
    atomic_write(&abs, out.as_bytes())?;
    let stat = fs::metadata(&abs)?;
    Ok(NotesResponse {
        ok: true,
        notes: trimmed.to_string(),
        mtime: mtime_ms(&stat),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_dashes() {
        assert_eq!(normalize_for_folder("Foo \u{2014} Bar"), "Foo - Bar");
        assert_eq!(normalize_for_folder("  spaced   out  "), "spaced out");
    }

    #[test]
    fn strip_wikilink_path() {
        assert_eq!(strip_wikilink("[[a/b/c|Display]]"), "Display");
        assert_eq!(strip_wikilink("[[Just A Title]]"), "Just A Title");
        assert_eq!(strip_wikilink("plain"), "plain");
    }

    #[test]
    fn duration_mm_ss() {
        assert_eq!(parse_duration_to_seconds("4:54"), Some(294));
        assert_eq!(parse_duration_to_seconds("1:02:03"), Some(3723));
        assert_eq!(parse_duration_to_seconds("bad"), None);
    }

    #[test]
    fn track_table_basic() {
        let body = "\
| 01  | [[01 - Xtal\\|Xtal]]    | 4:54   |
| 02  | Wiki                   | 3:30   |
";
        let rows = parse_track_table(body);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].n, 1);
        assert_eq!(rows[0].title, "Xtal");
        assert_eq!(rows[0].wikilink.as_deref(), Some("01 - Xtal"));
        assert_eq!(rows[0].duration, Some(294));
        assert_eq!(rows[1].title, "Wiki");
    }

    #[test]
    fn track_table_disc_marker() {
        let body = "\
### Disc 1
| 01 | A | 1:00 |
### Disc 2
| 01 | B | 2:00 |
";
        let rows = parse_track_table(body);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].disc, 1);
        assert_eq!(rows[1].disc, 2);
    }
}

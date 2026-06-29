//! User-curated music playlists.
//!
//! A playlist is one markdown hub page at:
//!   `<Library vault>/Music/Playlists/<Name>.md`  (`Type: Music-Playlist`)
//! whose body holds a `## Tracks` table. Each track cell is one of three forms
//! (see `title_cell`): a full-path wikilink to its `.md` track page (the
//! canonical owned entity); an `![[…opus]]` audio embed when it has audio but no
//! page; or — for an imported, not-yet-downloaded track — plain text (no link,
//! no audio). Plain rows read back as `available: false` (PlaylistDetail greys
//! them); they're the import path's first-class case, so the old "audio always
//! exists" invariant no longer holds. The album cell upgrades from plain text to
//! a wikilink once the album card exists.
//! Custom cover images live under `Music/Playlists/Covers/<Name>.<ext>`
//! and are served to the webview via the `mortar-pestle-asset://` scheme.
//!
//! The app is the read/write authority: pages are emitted canonically from
//! scratch (`emit_canonical`), never round-tripped through a parser, so a
//! malformed hand-edit can't corrupt a rewrite.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::commands::vault::{atomic_write, library_vault_root, mtime_ms, VaultError};
use crate::parsers::daily::today_str;
use crate::parsers::frontmatter::parse_frontmatter;

const PLAYLISTS_DIR: &str = "Music/Playlists";
const COVERS_DIR: &str = "Music/Playlists/Covers";
const COVER_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "avif"];
const MAX_COVER_BYTES: usize = 20 * 1024 * 1024;
const SENT: char = '\u{0001}';

static RE_WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]$").unwrap());
static RE_EMBED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^!\[\[([^\]]+?)\]\]$").unwrap());
static RE_DURATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d+):(\d{1,2})(?::(\d{1,2}))?$").unwrap());
static RE_NUM_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\s*-\s*").unwrap());
static RE_AUDIO_EXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.(opus|ogg|mp3|m4a|flac)$").unwrap());
static RE_ILLEGAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[/\\:*?"<>|#^\[\]\x00-\x1f]"#).unwrap());
static RE_SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub path: String,
    pub name: String,
    pub title: String,
    pub image: Option<String>,
    pub track_count: i64,
    pub cover_urls: Vec<String>,
    pub mtime: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub n: i64,
    pub title: String,
    pub artist: String,
    pub album_path: Option<String>,
    pub album_title: Option<String>,
    pub album_image: Option<String>,
    pub audio_path: Option<String>,
    pub available: bool,
    pub duration: Option<i64>,
    pub wikilink: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub path: String,
    pub title: String,
    pub image: Option<String>,
    pub cover_urls: Vec<String>,
    pub tracks: Vec<PlaylistTrack>,
}

/// Track reference sent by the frontend when writing a playlist. The frontend
/// has all of this from the album/queue context it adds the track from.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRefInput {
    pub wikilink: Option<String>,   // full track-page path, no extension
    pub audio_path: Option<String>, // vault-relative `.opus`
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album_path: Option<String>, // full album-page path, no extension
    #[serde(default)]
    pub album_title: Option<String>,
    #[serde(default)]
    pub duration: Option<i64>,
}

fn root() -> PathBuf {
    PathBuf::from(library_vault_root())
}
fn playlists_dir() -> PathBuf {
    root().join(PLAYLISTS_DIR)
}
fn covers_dir() -> PathBuf {
    root().join(COVERS_DIR)
}

fn safe_read_dir(p: &Path) -> Vec<String> {
    fs::read_dir(p)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

fn meta_str(meta: &Map<String, Value>, key: &str) -> Option<String> {
    meta.get(key).and_then(|v| match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Null => None,
        Value::String(_) => None,
        other => Some(other.to_string()),
    })
}

fn parse_duration_to_seconds(s: &str) -> Option<i64> {
    let c = RE_DURATION.captures(s.trim())?;
    let a: i64 = c.get(1)?.as_str().parse().ok()?;
    let b: i64 = c.get(2)?.as_str().parse().ok()?;
    if let Some(sec) = c.get(3) {
        return Some(a * 3600 + b * 60 + sec.as_str().parse::<i64>().ok()?);
    }
    Some(a * 60 + b)
}

fn fmt_dur(secs: i64) -> String {
    if secs <= 0 {
        return String::new();
    }
    let (h, m, s) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// Filename-safe playlist name: drop path/markdown-hostile chars, collapse
/// whitespace, trim, strip leading dots, cap length. Empty → error upstream.
/// pub(crate): the Video Editor's project folders reuse the same rule.
pub(crate) fn sanitize_name(title: &str) -> String {
    let cleaned = RE_ILLEGAL.replace_all(title, " ");
    let collapsed = RE_SPACES.replace_all(&cleaned, " ");
    let trimmed = collapsed.trim().trim_start_matches('.').trim();
    trimmed.chars().take(120).collect::<String>().trim().to_string()
}

/// A YAML double-quoted scalar (escaping `\` and `"`). Safe for any title/path.
fn yaml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Escape a value for a markdown-table cell: literal pipes become `\|`.
fn cell_escape(s: &str) -> String {
    s.replace('|', "\\|")
}

fn ext_of(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
}

// ── parsing ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum CellLink {
    Link { target: String, display: String },
    Embed { target: String },
    Plain { text: String },
}

fn parse_cell_link(cell: &str) -> CellLink {
    let c = cell.trim();
    if let Some(m) = RE_EMBED.captures(c) {
        return CellLink::Embed {
            target: m.get(1).unwrap().as_str().trim().to_string(),
        };
    }
    if let Some(m) = RE_WIKILINK.captures(c) {
        let target = m.get(1).unwrap().as_str().trim().to_string();
        let display = m
            .get(2)
            .map(|x| x.as_str().trim().to_string())
            .unwrap_or_else(|| target.clone());
        return CellLink::Link { target, display };
    }
    CellLink::Plain { text: c.to_string() }
}

#[derive(Debug, Clone)]
struct ParsedRow {
    title: CellLink,
    artist: String,
    album: CellLink,
    duration: Option<i64>,
}

/// Parse the `## Tracks` table. Each data row is `| # | Title | Artist | Album |
/// Length |`. Wikilink pipes are written `\|` (table-escaped); we mask them so a
/// naive split-on-`|` keeps each wikilink intact, then restore.
fn parse_tracks_table(body: &str) -> Vec<ParsedRow> {
    let mut out = Vec::new();
    for raw in body.split('\n') {
        if !raw.trim_start().starts_with('|') {
            continue;
        }
        let masked = raw.replace("\\|", &SENT.to_string());
        let cells: Vec<String> = masked
            .split('|')
            .map(|c| c.trim().replace(SENT, "|"))
            .collect();
        if cells.len() < 7 {
            continue; // need 5 inner cells (split adds leading+trailing empties)
        }
        let inner = &cells[1..cells.len() - 1];
        if inner.len() < 5 {
            continue;
        }
        // Skip the header (col 0 not numeric) and the `|---|` separator.
        if inner[0].parse::<i64>().is_err() {
            continue;
        }
        out.push(ParsedRow {
            title: parse_cell_link(&inner[1]),
            artist: inner[2].clone(),
            album: parse_cell_link(&inner[3]),
            duration: parse_duration_to_seconds(&inner[4]),
        });
    }
    out
}

/// Read an album page's `Image` (cover), memoized per call.
fn album_image(album_rel_no_ext: &str, cache: &mut HashMap<String, Option<String>>) -> Option<String> {
    if let Some(hit) = cache.get(album_rel_no_ext) {
        return hit.clone();
    }
    let abs = root().join(format!("{album_rel_no_ext}.md"));
    let img = fs::read_to_string(&abs)
        .ok()
        .and_then(|t| meta_str(&parse_frontmatter(&t).0, "Image"));
    cache.insert(album_rel_no_ext.to_string(), img.clone());
    img
}

fn title_from_audio_leaf(audio_path: &str) -> String {
    let leaf = Path::new(audio_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(audio_path);
    let no_ext = RE_AUDIO_EXT.replace(leaf, "");
    RE_NUM_PREFIX.replace(&no_ext, "").trim().to_string()
}

fn row_to_track(
    n: i64,
    row: &ParsedRow,
    cache: &mut HashMap<String, Option<String>>,
) -> PlaylistTrack {
    // Title cell → wikilink/audio + display title.
    let (wikilink, audio_path, title) = match &row.title {
        CellLink::Link { target, display } => (
            Some(target.clone()),
            Some(format!("{target}.opus")),
            display.clone(),
        ),
        CellLink::Embed { target } => (None, Some(target.clone()), title_from_audio_leaf(target)),
        CellLink::Plain { text } => (None, None, text.clone()),
    };
    let available = audio_path
        .as_ref()
        .map(|a| root().join(a).exists())
        .unwrap_or(false);

    // Album cell → path/title + resolved cover.
    let (album_path, album_title) = match &row.album {
        CellLink::Link { target, display } => (Some(format!("{target}.md")), Some(display.clone())),
        CellLink::Plain { text } if !text.is_empty() => (None, Some(text.clone())),
        _ => (None, None),
    };
    let album_image = match &row.album {
        CellLink::Link { target, .. } => album_image(target, cache),
        _ => None,
    };

    PlaylistTrack {
        n,
        title,
        artist: row.artist.clone(),
        album_path,
        album_title,
        album_image,
        audio_path,
        available,
        duration: row.duration,
        wikilink,
    }
}

fn collage_urls(tracks: &[PlaylistTrack]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for t in tracks {
        if let Some(img) = &t.album_image {
            if !img.is_empty() && seen.insert(img.clone()) {
                out.push(img.clone());
                if out.len() == 4 {
                    break;
                }
            }
        }
    }
    out
}

// ── reads ────────────────────────────────────────────────────────────────────

pub fn list_playlists() -> Result<Vec<PlaylistSummary>, VaultError> {
    let dir = playlists_dir();
    let mut entries = safe_read_dir(&dir);
    entries.sort();
    let mut cache: HashMap<String, Option<String>> = HashMap::new();
    let mut out = Vec::new();
    for entry in entries {
        if !entry.ends_with(".md") {
            continue;
        }
        let abs = dir.join(&entry);
        let Ok(text) = fs::read_to_string(&abs) else {
            continue;
        };
        let (meta, body) = parse_frontmatter(&text);
        if meta_str(&meta, "Type").as_deref() != Some("Music-Playlist") {
            continue;
        }
        let stat = fs::metadata(&abs)?;
        let name = entry.trim_end_matches(".md").to_string();
        let image = meta_str(&meta, "Image");
        let rows = parse_tracks_table(&body);
        // Only resolve covers for the collage when there's no custom cover.
        let cover_urls = if image.is_some() {
            Vec::new()
        } else {
            let tracks: Vec<PlaylistTrack> = rows
                .iter()
                .take(8)
                .enumerate()
                .map(|(i, r)| row_to_track(i as i64 + 1, r, &mut cache))
                .collect();
            collage_urls(&tracks)
        };
        out.push(PlaylistSummary {
            path: format!("{PLAYLISTS_DIR}/{entry}"),
            name: name.clone(),
            title: meta_str(&meta, "Title").unwrap_or(name),
            image,
            track_count: rows.len() as i64,
            cover_urls,
            mtime: mtime_ms(&stat),
        });
    }
    Ok(out)
}

pub fn read_playlist(playlist_path: &str) -> Result<Playlist, VaultError> {
    let abs = root().join(playlist_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!(
            "Playlist not found: {playlist_path}"
        )));
    }
    let text = fs::read_to_string(&abs)?;
    let (meta, body) = parse_frontmatter(&text);
    let mut cache: HashMap<String, Option<String>> = HashMap::new();
    let tracks: Vec<PlaylistTrack> = parse_tracks_table(&body)
        .iter()
        .enumerate()
        .map(|(i, r)| row_to_track(i as i64 + 1, r, &mut cache))
        .collect();
    let name = Path::new(playlist_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    Ok(Playlist {
        path: playlist_path.to_string(),
        title: meta_str(&meta, "Title").unwrap_or(name),
        image: meta_str(&meta, "Image"),
        cover_urls: collage_urls(&tracks),
        tracks,
    })
}

// ── emit + writes ──────────────────────────────────────────────────────────────

fn title_cell(r: &TrackRefInput) -> String {
    match (&r.wikilink, &r.audio_path) {
        (Some(wl), _) if !wl.is_empty() => {
            format!("[[{}\\|{}]]", cell_escape(wl), cell_escape(&r.title))
        }
        (_, Some(audio)) if !audio.is_empty() => format!("![[{}]]", cell_escape(audio)),
        _ => cell_escape(&r.title),
    }
}

fn album_cell(r: &TrackRefInput) -> String {
    match (&r.album_path, &r.album_title) {
        (Some(p), Some(t)) if !p.is_empty() => {
            format!("[[{}\\|{}]]", cell_escape(p), cell_escape(t))
        }
        (_, Some(t)) => cell_escape(t),
        _ => String::new(),
    }
}

fn emit_canonical(title: &str, image: Option<&str>, created: &str, tracks: &[TrackRefInput]) -> String {
    let mut s = String::new();
    s.push_str("---\n");
    s.push_str("Type: Music-Playlist\n");
    s.push_str("Domain: Music\n");
    s.push_str(&format!("Title: {}\n", yaml_str(title)));
    if let Some(img) = image {
        s.push_str(&format!("Image: {}\n", yaml_str(img)));
    }
    s.push_str(&format!("Track Count: {}\n", tracks.len()));
    s.push_str(&format!("Created: {created}\n"));
    s.push_str("---\n\n");
    if let Some(img) = image {
        s.push_str(&format!("## Cover\n\n![[{img}]]\n\n"));
    }
    s.push_str("## Tracks\n\n");
    s.push_str("| # | Title | Artist | Album | Length |\n");
    s.push_str("|---|-------|--------|-------|--------|\n");
    for (i, r) in tracks.iter().enumerate() {
        s.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            i + 1,
            title_cell(r),
            cell_escape(r.artist.as_deref().unwrap_or("")),
            album_cell(r),
            r.duration.map(fmt_dur).unwrap_or_default(),
        ));
    }
    s
}

fn read_created(rel: &str) -> Option<String> {
    let abs = root().join(rel);
    fs::read_to_string(&abs)
        .ok()
        .and_then(|t| meta_str(&parse_frontmatter(&t).0, "Created"))
}

/// Create / edit / rename a playlist page. `original_path` distinguishes edit
/// from create (and, when its name differs, a rename — which moves the cover and
/// deletes the old file). `cover_path` is the Image to write verbatim; if its
/// filename doesn't match the playlist name, the cover file is moved to match.
pub fn write_playlist(
    title: &str,
    tracks: Vec<TrackRefInput>,
    original_path: Option<String>,
    cover_path: Option<String>,
) -> Result<Playlist, VaultError> {
    let safe = sanitize_name(title);
    if safe.is_empty() {
        return Err(VaultError::Invalid("Playlist name is empty".into()));
    }
    let new_rel = format!("{PLAYLISTS_DIR}/{safe}.md");
    let new_abs = root().join(&new_rel);

    let renaming = original_path.as_deref().map(|o| o != new_rel).unwrap_or(false);
    let creating = original_path.is_none();
    if (creating || renaming) && new_abs.exists() {
        return Err(VaultError::Invalid(format!(
            "A playlist named \"{title}\" already exists"
        )));
    }

    // Normalize the cover filename to the playlist name (handles rename + the
    // save-then-write handshake). Move the file if it isn't already canonical.
    let image: Option<String> = match cover_path {
        Some(cov) if !cov.is_empty() => {
            let ext = ext_of(&cov).unwrap_or_else(|| "png".into());
            let canonical = format!("{COVERS_DIR}/{safe}.{ext}");
            if cov != canonical {
                let from = root().join(&cov);
                let to = root().join(&canonical);
                if from.exists() {
                    if let Some(parent) = to.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::rename(&from, &to);
                }
            }
            Some(canonical)
        }
        _ => None,
    };

    let created = original_path
        .as_deref()
        .and_then(read_created)
        .unwrap_or_else(today_str);

    let content = emit_canonical(title, image.as_deref(), &created, &tracks);
    atomic_write(&new_abs, content.as_bytes())?;

    if renaming {
        if let Some(orig) = &original_path {
            let _ = fs::remove_file(root().join(orig));
        }
    }
    read_playlist(&new_rel)
}

/// Persist a user-picked cover image as `Covers/<Name>.<ext>` and return its
/// vault-relative path. Pure binary write — the page's `Image` is set by the
/// following `write_playlist` call. Removes sibling covers of other extensions.
pub fn save_playlist_cover(title: &str, bytes: Vec<u8>, ext: &str) -> Result<String, VaultError> {
    let ext = ext.trim().trim_start_matches('.').to_lowercase();
    if !COVER_EXTS.contains(&ext.as_str()) {
        return Err(VaultError::Invalid(format!("Unsupported image type: {ext}")));
    }
    if bytes.is_empty() {
        return Err(VaultError::Invalid("Empty image".into()));
    }
    if bytes.len() > MAX_COVER_BYTES {
        return Err(VaultError::Invalid("Image exceeds 20 MB".into()));
    }
    let safe = sanitize_name(title);
    if safe.is_empty() {
        return Err(VaultError::Invalid("Playlist name is empty".into()));
    }
    // Drop covers for this playlist with a different extension.
    for f in safe_read_dir(&covers_dir()) {
        if let Some(stem) = Path::new(&f).file_stem().and_then(|s| s.to_str()) {
            if stem == safe && f != format!("{safe}.{ext}") && RE_AUDIO_EXT.is_match(&f) == false {
                if ext_of(&f).map(|e| COVER_EXTS.contains(&e.as_str())).unwrap_or(false) {
                    let _ = fs::remove_file(covers_dir().join(&f));
                }
            }
        }
    }
    let rel = format!("{COVERS_DIR}/{safe}.{ext}");
    atomic_write(&root().join(&rel), &bytes)?;
    Ok(rel)
}

/// Collect a playlist's on-disk files — the `.md` card plus every cover sibling
/// (the frontmatter `Image:` cover and any stem-matched file in `Covers/`) — as
/// (vault-relative, absolute) pairs. The card is always element 0. Does NOT
/// delete: `music_delete_playlist` routes these through the recycling bin.
pub fn collect_playlist_files(playlist_path: &str) -> Result<Vec<(String, PathBuf)>, VaultError> {
    let abs = root().join(playlist_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!(
            "Playlist not found: {playlist_path}"
        )));
    }
    let mut out: Vec<(String, PathBuf)> = vec![(playlist_path.to_string(), abs.clone())];
    let mut seen: HashSet<String> = HashSet::new();
    // Cover named in the page's frontmatter (already a vault-relative path).
    if let Ok(text) = fs::read_to_string(&abs) {
        if let Some(img) = meta_str(&parse_frontmatter(&text).0, "Image") {
            let p = root().join(&img);
            if p.exists() && seen.insert(img.clone()) {
                out.push((img, p));
            }
        }
    }
    // Any sibling cover sharing the playlist's stem (captures all extensions).
    if let Some(stem) = Path::new(playlist_path).file_stem().and_then(|s| s.to_str()) {
        for f in safe_read_dir(&covers_dir()) {
            if Path::new(&f).file_stem().and_then(|s| s.to_str()) == Some(stem) {
                let rel = format!("{COVERS_DIR}/{f}");
                if seen.insert(rel.clone()) {
                    out.push((rel, covers_dir().join(&f)));
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(wikilink: Option<&str>, audio: Option<&str>, title: &str, album_path: Option<&str>, album: Option<&str>, dur: Option<i64>) -> TrackRefInput {
        TrackRefInput {
            wikilink: wikilink.map(String::from),
            audio_path: audio.map(String::from),
            title: title.into(),
            artist: Some("Aphex Twin".into()),
            album_path: album_path.map(String::from),
            album_title: album.map(String::from),
            duration: dur,
        }
    }

    #[test]
    fn sanitize_strips_illegal_and_caps() {
        assert_eq!(sanitize_name("  Late/Night: Mix  "), "Late Night Mix");
        assert_eq!(sanitize_name("../etc"), "etc");
        assert_eq!(sanitize_name(""), "");
        assert_eq!(sanitize_name("...."), "");
    }

    #[test]
    fn duration_round_trip() {
        assert_eq!(parse_duration_to_seconds("4:51"), Some(291));
        assert_eq!(fmt_dur(291), "4:51");
        assert_eq!(fmt_dur(3723), "1:02:03");
        assert_eq!(parse_duration_to_seconds("1:02:03"), Some(3723));
    }

    #[test]
    fn embed_leaf_title() {
        assert_eq!(
            title_from_audio_leaf("Knowledge/Music/MusicBrainz Pipeline/Tracks/A - B/03 - Pulsewidth.opus"),
            "Pulsewidth"
        );
    }

    #[test]
    fn emit_then_parse_link_row() {
        let refs = vec![r(
            Some("Knowledge/Music/MusicBrainz Pipeline/Tracks/Aphex Twin - SAW/01 - Xtal"),
            Some("Knowledge/Music/MusicBrainz Pipeline/Tracks/Aphex Twin - SAW/01 - Xtal.opus"),
            "Xtal",
            Some("Knowledge/Music/MusicBrainz Pipeline/Albums/SAW (by Aphex Twin - 1992)"),
            Some("Selected Ambient Works 85-92"),
            Some(291),
        )];
        let page = emit_canonical("Late Night", None, "2026-05-28", &refs);
        assert!(page.contains("Type: Music-Playlist"));
        assert!(page.contains("Title: \"Late Night\""));
        let rows = parse_tracks_table(&page);
        assert_eq!(rows.len(), 1);
        match &rows[0].title {
            CellLink::Link { target, display } => {
                assert!(target.ends_with("01 - Xtal"));
                assert_eq!(display, "Xtal");
            }
            other => panic!("expected link, got {other:?}"),
        }
        assert_eq!(rows[0].artist, "Aphex Twin");
        assert_eq!(rows[0].duration, Some(291));
        match &rows[0].album {
            CellLink::Link { display, .. } => assert_eq!(display, "Selected Ambient Works 85-92"),
            other => panic!("expected album link, got {other:?}"),
        }
    }

    #[test]
    fn emit_then_parse_embed_and_pipe_title() {
        let refs = vec![
            r(None, Some("Knowledge/Music/MusicBrainz Pipeline/Tracks/A - B/02 - Foo.opus"), "Foo", None, None, Some(60)),
            // Path is pipe-free (filenames are sanitized); only the display title carries a pipe.
            r(Some("X/Y/04 - AB Song"), Some("X/Y/04 - AB Song.opus"), "A|B Song", None, None, None),
        ];
        let page = emit_canonical("P", None, "2026-05-28", &refs);
        let rows = parse_tracks_table(&page);
        assert_eq!(rows.len(), 2);
        assert!(matches!(&rows[0].title, CellLink::Embed { .. }));
        // Pipe inside the display survives the table round-trip.
        match &rows[1].title {
            CellLink::Link { display, .. } => assert_eq!(display, "A|B Song"),
            other => panic!("expected link, got {other:?}"),
        }
    }

    #[test]
    fn cover_section_emitted_when_image_set() {
        let page = emit_canonical("P", Some("Knowledge/Music/Playlists/Covers/P.png"), "2026-05-28", &[]);
        assert!(page.contains("## Cover"));
        assert!(page.contains("![[Knowledge/Music/Playlists/Covers/P.png]]"));
    }
}

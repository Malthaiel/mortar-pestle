//! Anime / video series + episode resolution.
//!
//! Ported from the now-removed Node sidecar (`server/src/video/library.js`). Sub-feature 7 of the Desktop-Only
//! Migration.
//!
//! Series pages live at `Anime/Catalog/<Title>.md` in the Library vault (see
//! `ANIME_DIR`) and carry `Local Path:` pointing to a folder of episode files
//! (usually outside the vault). The body holds a `## Episodes` table with one
//! row per episode.
//!
//! Franchise pages aggregate multiple MAL entries (seasons / movies / OVAs)
//! under one card. They carry `Related IDs:` plus per-section suffixed
//! frontmatter (`Status Season 1`, `Watched Episodes Movie`, ...). The body
//! has one `## <SECTION>` H2 per entry with its own `### Episodes` table.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::commands::vault::{atomic_write, check_mtime, library_vault_root, mtime_ms, VaultError};
use crate::parsers::frontmatter::{parse_frontmatter, set_frontmatter_field};

const ANIME_DIR: &str = "Anime/Catalog";

static ACRONYMS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    ["OVA", "ONA", "ED", "OP", "TV", "SP"].into_iter().collect()
});

static STATUS_RANK: LazyLock<HashMap<&'static str, i32>> = LazyLock::new(|| {
    [
        ("Currently-Watching", 4),
        ("On-Hold", 3),
        ("Plan-to-Watch", 2),
        ("Dropped", 1),
        ("Completed", 0),
    ]
    .into_iter()
    .collect()
});

static RE_WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]$").unwrap());
static RE_H2: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^##\s+([A-Z][A-Z\d ]*?)\s*$").unwrap());
static RE_EPISODE_ROW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([\d-]+)?\s*\|").unwrap());
static RE_CELL_WIKILINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]\s*$").unwrap());
static RE_VIDEO_EXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\.(mkv|mp4|webm|avi|mov|m4v|ogv|m2ts)$").unwrap());

const SENT: char = '\u{0001}';

static EP_NUM_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r"[Ss]\d{1,2}[Ee](\d{1,3})").unwrap(),
        Regex::new(r"\s-\s*(\d{1,3})(?:[\s.\[v]|$)").unwrap(),
        Regex::new(r"^\s*(\d{1,3})\s*-\s+").unwrap(),
        Regex::new(r"[Ee][Pp]?(\d{1,3})\b").unwrap(),
        Regex::new(r"\[(\d{1,3})\]").unwrap(),
        // Bare trailing number right before the extension ("[Group] Show 01.mkv").
        // Last so the delimited patterns above win first; separator-anchored and
        // ≤3 digits so "1080p" / "x265" / years can't false-match.
        Regex::new(r"(?:^|[\s._-])(\d{1,3})\.[A-Za-z0-9]+$").unwrap(),
    ]
});

// ─── Response types ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSummary {
    pub path: String,
    pub name: String,
    pub title: String,
    /// Numeric MAL ID (`Provider ID:`). Lets the Anime Browse tab dedup search
    /// hits against the library; `None` for cards missing the field.
    pub provider_id: Option<i64>,
    pub year: Option<Value>,
    pub image: Option<String>,
    pub status: Option<String>,
    pub genres: Vec<String>,
    pub studio: Vec<String>,
    pub episodes_total: Option<i64>,
    pub airing: bool,
    pub local_path: Option<String>,
    pub download_status: Option<String>,
    /// True when the card's local path holds ≥1 real episode file (extras
    /// skipped) — powers the Downloaded / Not Downloaded topbar filter.
    pub has_local_files: bool,
    pub online_rating: Option<Value>,
    pub personal_rating: f64,
    /// Sum of `Re Watches` (non-franchise) or every `Re Watches <suffix>`
    /// (franchise) — powers the library topbar's Rewatched stat.
    pub re_watches: i64,
    /// Array of episode numbers for non-franchise pages; integer count for franchise pages.
    pub watched_episodes: Value,
    pub franchise: bool,
    /// `null` for non-franchise; ordered list of MAL IDs for franchise pages.
    pub related_ids: Option<Vec<i64>>,
    /// `null` for non-franchise; ordered list of section suffixes for franchise pages.
    pub season_names: Option<Vec<String>>,
    pub mtime: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub n: i64,
    pub title: String,
    pub wikilink: Option<String>,
    pub aired: Option<String>,
    pub file_abs: Option<String>,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    pub name: String,
    pub status: String,
    pub started: String,
    pub finished: String,
    pub re_watches: i64,
    pub watched: Vec<i64>,
    pub episodes: Vec<Episode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub path: String,
    pub title: String,
    pub year: Option<Value>,
    pub image: Option<String>,
    pub status: Option<String>,
    pub genres: Vec<String>,
    pub studio: Vec<String>,
    pub themes: Vec<String>,
    pub demographics: Vec<String>,
    pub producers: Vec<String>,
    pub director: Option<String>,
    pub music: Option<String>,
    pub duration: Option<String>,
    pub episodes_total: i64,
    pub aired_from: Option<String>,
    pub aired_to: Option<String>,
    pub airing: bool,
    pub local_path: Option<String>,
    pub download_status: Option<String>,
    pub online_rating: Option<Value>,
    pub scored_by: Option<i64>,
    pub rank: Option<i64>,
    pub popularity: Option<i64>,
    pub members: Option<i64>,
    pub premiered: Option<String>,
    pub format: Option<String>,
    /// MAL detail extras (from frontmatter; written by `download_anime.py`).
    pub source: Option<String>,
    pub rating: Option<String>,
    pub broadcast: Option<String>,
    pub title_japanese: Option<String>,
    pub title_english: Option<String>,
    pub synonyms: Vec<String>,
    pub aired: Option<String>,
    pub openings: Vec<String>,
    pub endings: Vec<String>,
    pub trailer: Option<String>,
    /// Synopsis from the `## Plot` body section; background from `## Background`.
    pub synopsis: Option<String>,
    pub background: Option<String>,
    pub personal_rating: f64,
    /// `Started:` / `Finished:` frontmatter — the user's watch dates (written
    /// by the card writers, populated by the MAL import). Empty → None.
    pub started: Option<String>,
    pub finished: Option<String>,
    /// Number for franchise pages (total watched count), array of ep numbers otherwise.
    pub watched_episodes: Value,
    pub franchise: bool,
    pub related_ids: Option<Vec<i64>>,
    /// MAL id from `Provider ID` frontmatter — lets the detail page fetch live
    /// Jikan credits (characters/staff/relations) for an owned entry.
    pub provider_id: Option<i64>,
    pub seasons: Option<Vec<Season>>,
    pub episodes: Vec<Episode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkEpisodeResponse {
    pub ok: bool,
    pub watched_episodes: Vec<i64>,
    pub status: String,
    pub season: Option<String>,
    pub mtime: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkSeriesStatusResponse {
    pub ok: bool,
    pub status: String,
    pub season: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkSeriesRatingResponse {
    pub ok: bool,
    pub personal_rating: f64,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

fn as_finite_numbers(v: Option<&Value>) -> Vec<i64> {
    as_str_array(v)
        .iter()
        .filter_map(|x| match x {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
            Value::String(s) => s.parse::<f64>().ok().map(|f| f as i64),
            _ => None,
        })
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

fn meta_i64(meta: &Map<String, Value>, key: &str) -> Option<i64> {
    meta.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.parse::<f64>().ok().map(|f| f as i64),
        _ => None,
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

fn meta_bool(meta: &Map<String, Value>, key: &str) -> bool {
    meta.get(key)
        .map(|v| matches!(v, Value::Bool(true)) || matches!(v, Value::String(s) if s == "true"))
        .unwrap_or(false)
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

/// "SEASON 1" → "Season 1"; "MOVIE" → "Movie"; "OVA 2" → "OVA 2".
pub fn h2_to_suffix(h2: &str) -> String {
    h2.split_whitespace()
        .map(|part| {
            if part.chars().all(|c| c.is_ascii_digit()) {
                return part.to_string();
            }
            let upper = part.to_ascii_uppercase();
            if ACRONYMS.contains(upper.as_str()) {
                return upper;
            }
            let mut chars = part.chars();
            match chars.next() {
                Some(c) => {
                    c.to_ascii_uppercase().to_string() + &chars.collect::<String>().to_ascii_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone)]
struct TableEp {
    n: i64,
    title: String,
    wikilink: Option<String>,
    aired: Option<String>,
}

fn parse_episode_table(body: &str) -> Vec<TableEp> {
    let mut out = Vec::new();
    for raw in body.split('\n') {
        let line = raw.replace("\\|", &SENT.to_string());
        let Some(m) = RE_EPISODE_ROW.captures(&line) else {
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
        let aired = m
            .get(3)
            .map(|x| x.as_str().trim().to_string())
            .filter(|s| !s.is_empty());
        out.push(TableEp {
            n,
            title,
            wikilink,
            aired,
        });
    }
    out
}

#[derive(Debug, Clone)]
struct Section {
    suffix: String,
    content: String,
}

fn parse_franchise_sections(body: &str) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut cur_suffix: Option<String> = None;
    let mut cur_buf: Vec<String> = Vec::new();
    for line in body.split('\n') {
        if let Some(c) = RE_H2.captures(line) {
            if let Some(prev) = cur_suffix.take() {
                sections.push(Section {
                    suffix: prev,
                    content: cur_buf.join("\n"),
                });
            }
            cur_suffix = Some(h2_to_suffix(c.get(1).unwrap().as_str()));
            cur_buf = Vec::new();
            continue;
        }
        if cur_suffix.is_some() {
            cur_buf.push(line.to_string());
        }
    }
    if let Some(prev) = cur_suffix {
        sections.push(Section {
            suffix: prev,
            content: cur_buf.join("\n"),
        });
    }
    sections
}

/// Extract the body content of a named `## <Name>` H2 section (e.g. `Plot`,
/// `Background`) — everything between that header and the next `## ` header,
/// trimmed. Case-insensitive on the header name. Returns `None` when the
/// section is absent or its body is empty. Mirrors the section-scan approach
/// used by `parse_franchise_sections`, but matches a literal mixed-case name
/// rather than the all-caps franchise suffixes `RE_H2` targets.
fn extract_body_section(body: &str, name: &str) -> Option<String> {
    let mut buf: Vec<&str> = Vec::new();
    let mut capturing = false;
    for line in body.split('\n') {
        if let Some(rest) = line.strip_prefix("## ") {
            if capturing {
                break; // next H2 ends the section
            }
            if rest.trim().eq_ignore_ascii_case(name) {
                capturing = true;
            }
            continue;
        }
        if capturing {
            buf.push(line);
        }
    }
    if !capturing {
        return None;
    }
    let text = buf.join("\n").trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn parse_episode_number(file: &str) -> Option<i64> {
    if !RE_VIDEO_EXT.is_match(file) {
        return None;
    }
    for pat in EP_NUM_PATTERNS.iter() {
        if let Some(m) = pat.captures(file) {
            if let Some(n) = m.get(1).and_then(|x| x.as_str().parse::<i64>().ok()) {
                return Some(n);
            }
        }
    }
    None
}

/// Non-episode subfolders bundled in many releases (creditless OP/ED, specials,
/// menus, scans, samples, previews). Skipped during the episode scan so their
/// files never collide with real episode numbers.
fn is_extras_dir(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "nc" | "ncs" | "ncop" | "nced" | "creditless"
            | "special" | "specials" | "extra" | "extras" | "bonus"
            | "menu" | "menus" | "scan" | "scans"
            | "sample" | "samples" | "preview" | "previews"
            | "pv" | "cm" | "sp"
    )
}

/// Top-level creditless / extras files some releases leave beside real
/// episodes ("NCED 01.mkv", "OP 01.mkv", "Menu.mkv"). The bare-trailing-number
/// pattern would read their counter as an episode number and shadow the real
/// file, so they're skipped like extras dirs. Two shapes: a creditless token
/// anywhere in the stem, or the WHOLE stem being a short extras token plus an
/// optional counter — full-stem so titles merely starting with the letters
/// ("Edens Zero 01") never match.
fn is_extras_file(name: &str) -> bool {
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    let lower = stem.trim().to_ascii_lowercase();
    if ["ncop", "nced", "creditless", "non-credit", "non credit"]
        .iter()
        .any(|t| lower.contains(t))
    {
        return true;
    }
    let tok = lower
        .trim_end_matches(|c: char| c.is_ascii_digit())
        .trim_end_matches([' ', '.', '_', '-', '#']);
    matches!(
        tok,
        "nc" | "ncs" | "op" | "ed" | "pv" | "cm" | "sp" | "menu" | "preview" | "sample"
            | "extra" | "bonus" | "special"
    )
}

fn walk_video_files(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, max: usize, out: &mut Vec<PathBuf>) {
        if depth > max {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                if is_extras_dir(&name_str) {
                    continue;   // creditless / specials / menus aren't numbered episodes
                }
                walk(&path, depth + 1, max, out);
            } else if path.is_file() {
                if is_extras_file(&name_str) {
                    continue; // top-level creditless/extras file — would shadow a real episode
                }
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    if root.is_dir() {
        walk(root, 0, max_depth, &mut out);
    }
    out
}

/// True if `root` holds at least one real episode video file, applying the same
/// extras-dir / extras-file skip rules as the episode scan. Early-exit — the
/// Downloaded / Not Downloaded filter only needs a boolean, not the full
/// per-episode index, and not-downloaded cards have no dir at all (instant
/// false).
fn has_any_video_file(root: &Path) -> bool {
    fn walk(dir: &Path, depth: usize, max: usize) -> bool {
        let Ok(entries) = fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                if depth < max && !is_extras_dir(&name_str) && walk(&path, depth + 1, max) {
                    return true;
                }
            } else if RE_VIDEO_EXT.is_match(&name_str) && !is_extras_file(&name_str) {
                return true;
            }
        }
        false
    }
    root.is_dir() && walk(root, 0, 3)
}

fn index_files_by_episode(root: Option<&Path>) -> HashMap<i64, PathBuf> {
    let mut map = HashMap::new();
    let Some(root) = root else { return map };
    if !root.exists() {
        return map;
    }
    let files = walk_video_files(root, 3);
    for f in files {
        let name = f.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if let Some(n) = parse_episode_number(name) {
            map.entry(n).or_insert(f);
        }
    }
    map
}

fn is_franchise(meta: &Map<String, Value>) -> bool {
    match meta.get("Related IDs") {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Null) => false,
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(_) => true,
        None => false,
    }
}

fn rollup_status(meta: &Map<String, Value>, suffixes: &[String]) -> String {
    let mut best: Option<String> = None;
    let mut best_rank: i32 = -1;
    for suffix in suffixes {
        let s = meta
            .get(&format!("Status {suffix}"))
            .and_then(|v| v.as_str())
            .unwrap_or("Plan-to-Watch")
            .to_string();
        let rank = STATUS_RANK.get(s.as_str()).copied().unwrap_or(-1);
        if rank > best_rank {
            best = Some(s);
            best_rank = rank;
        }
    }
    let Some(found) = best else {
        return "Plan-to-Watch".to_string();
    };
    let all_completed = suffixes.iter().all(|s| {
        meta.get(&format!("Status {s}"))
            .and_then(|v| v.as_str())
            .map(|x| x == "Completed")
            .unwrap_or(false)
    });
    if all_completed {
        "Completed".to_string()
    } else {
        found
    }
}

fn sum_watched(meta: &Map<String, Value>, suffixes: &[String]) -> i64 {
    suffixes
        .iter()
        .map(|s| {
            as_finite_numbers(meta.get(&format!("Watched Episodes {s}"))).len() as i64
        })
        .sum()
}

fn sum_rewatches(meta: &Map<String, Value>, suffixes: &[String]) -> i64 {
    suffixes
        .iter()
        .map(|s| meta_i64(meta, &format!("Re Watches {s}")).unwrap_or(0))
        .sum()
}

fn anime_dir() -> PathBuf {
    PathBuf::from(library_vault_root()).join(ANIME_DIR)
}

// ─── Public commands ────────────────────────────────────────────────────────

pub fn list_series() -> Result<Vec<SeriesSummary>, VaultError> {
    let dir = anime_dir();
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
        let (meta, body) = parse_frontmatter(&text);
        let stat = match fs::metadata(&abs) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let franchise = is_franchise(&meta);
        let (status, watched_value, episodes_total, season_names, related_ids, re_watches);
        if franchise {
            let sections = parse_franchise_sections(&body);
            let names: Vec<String> = sections.iter().map(|x| x.suffix.clone()).collect();
            season_names = Some(names.clone());
            related_ids = Some(as_finite_numbers(meta.get("Related IDs")));
            status = Some(rollup_status(&meta, &names));
            watched_value = Value::from(sum_watched(&meta, &names));
            episodes_total = meta_i64(&meta, "Episodes");
            re_watches = sum_rewatches(&meta, &names);
        } else {
            status = meta_str(&meta, "Status");
            watched_value = Value::from(as_finite_numbers(meta.get("Watched Episodes")));
            episodes_total = meta_i64(&meta, "Episodes");
            season_names = None;
            related_ids = None;
            re_watches = meta_i64(&meta, "Re Watches").unwrap_or(0);
        }
        let name = entry.trim_end_matches(".md").to_string();
        let local_path = meta_str(&meta, "Local Path").map(resolve_local_path);
        let has_local_files = local_path
            .as_deref()
            .map(|p| has_any_video_file(Path::new(p)))
            .unwrap_or(false);
        out.push(SeriesSummary {
            path: format!("{ANIME_DIR}/{entry}"),
            name: name.clone(),
            title: meta_str(&meta, "Title").unwrap_or(name),
            provider_id: meta_i64(&meta, "Provider ID"),
            year: meta_clone(&meta, "Year"),
            image: meta_str(&meta, "Image"),
            status,
            genres: as_strings(meta.get("Genres")),
            studio: as_strings(meta.get("Studio"))
                .iter()
                .map(|s| strip_wikilink(s))
                .collect(),
            episodes_total,
            airing: meta_bool(&meta, "Airing"),
            local_path,
            download_status: meta_str(&meta, "Download Status"),
            has_local_files,
            online_rating: meta_clone(&meta, "Online Rating"),
            personal_rating: meta_f64(&meta, "Personal Rating"),
            re_watches,
            watched_episodes: watched_value,
            franchise,
            related_ids,
            season_names,
            mtime: mtime_ms(&stat),
        });
    }
    Ok(out)
}

/// Resolve a card's `Local Path` to an absolute path. Vault-relative values
/// (anime video now lives under `<library>/Anime/Videos/` — Library Migration)
/// join the library root; legacy absolute values pass through unchanged.
fn resolve_local_path(lp: String) -> String {
    if PathBuf::from(&lp).is_absolute() {
        lp
    } else {
        PathBuf::from(library_vault_root())
            .join(&lp)
            .to_string_lossy()
            .into_owned()
    }
}

pub fn read_series(series_path: &str) -> Result<Series, VaultError> {
    let abs = PathBuf::from(library_vault_root()).join(series_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!(
            "Series not found: {series_path}"
        )));
    }
    let text = fs::read_to_string(&abs)?;
    let (meta, body) = parse_frontmatter(&text);
    let local_path = meta_str(&meta, "Local Path").map(resolve_local_path);
    let franchise = is_franchise(&meta);

    let mut seasons_out: Option<Vec<Season>> = None;
    let episodes_out: Vec<Episode>;

    if franchise {
        let sections = parse_franchise_sections(&body);
        let mut seasons = Vec::new();
        let mut flat = Vec::new();
        for section in &sections {
            let suffix = &section.suffix;
            let table_eps = parse_episode_table(&section.content);
            let section_dir = local_path
                .as_deref()
                .map(|lp| PathBuf::from(lp).join(suffix));
            let files_by_num = index_files_by_episode(section_dir.as_deref());
            let section_eps: Vec<Episode> = table_eps
                .iter()
                .map(|t| {
                    let file_abs = files_by_num
                        .get(&t.n)
                        .map(|p| p.to_string_lossy().to_string());
                    Episode {
                        n: t.n,
                        title: t.title.clone(),
                        wikilink: t.wikilink.clone(),
                        aired: t.aired.clone(),
                        available: file_abs.is_some(),
                        file_abs,
                        season_name: Some(suffix.clone()),
                    }
                })
                .collect();
            let watched = as_finite_numbers(meta.get(&format!("Watched Episodes {suffix}")));
            seasons.push(Season {
                name: suffix.clone(),
                status: meta
                    .get(&format!("Status {suffix}"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Plan-to-Watch")
                    .to_string(),
                started: meta_str(&meta, &format!("Started {suffix}")).unwrap_or_default(),
                finished: meta_str(&meta, &format!("Finished {suffix}")).unwrap_or_default(),
                re_watches: meta_i64(&meta, &format!("Re Watches {suffix}")).unwrap_or(0),
                watched,
                episodes: section_eps.clone(),
            });
            flat.extend(section_eps);
        }
        seasons_out = Some(seasons);
        episodes_out = flat;
    } else {
        let table_eps = parse_episode_table(&body);
        let files_by_num = index_files_by_episode(local_path.as_deref().map(Path::new));
        if !table_eps.is_empty() {
            episodes_out = table_eps
                .iter()
                .map(|t| {
                    let file_abs = files_by_num
                        .get(&t.n)
                        .map(|p| p.to_string_lossy().to_string());
                    Episode {
                        n: t.n,
                        title: t.title.clone(),
                        wikilink: t.wikilink.clone(),
                        aired: t.aired.clone(),
                        available: file_abs.is_some(),
                        file_abs,
                        season_name: None,
                    }
                })
                .collect();
        } else {
            let mut entries: Vec<(i64, PathBuf)> = files_by_num.into_iter().collect();
            entries.sort_by_key(|(k, _)| *k);
            episodes_out = entries
                .into_iter()
                .map(|(n, p)| {
                    let title = p
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|s| s.rsplit_once('.').map(|(a, _)| a).unwrap_or(s).to_string())
                        .unwrap_or_default();
                    let file_abs = Some(p.to_string_lossy().to_string());
                    Episode {
                        n,
                        title,
                        wikilink: None,
                        aired: None,
                        available: true,
                        file_abs,
                        season_name: None,
                    }
                })
                .collect();
        }
    }

    let watched_value = if franchise {
        Value::from(sum_watched(
            &meta,
            &seasons_out
                .as_ref()
                .map(|ss| ss.iter().map(|s| s.name.clone()).collect::<Vec<_>>())
                .unwrap_or_default(),
        ))
    } else {
        Value::from(as_finite_numbers(meta.get("Watched Episodes")))
    };
    let status = if franchise {
        Some(rollup_status(
            &meta,
            &seasons_out
                .as_ref()
                .map(|ss| ss.iter().map(|s| s.name.clone()).collect::<Vec<_>>())
                .unwrap_or_default(),
        ))
    } else {
        meta_str(&meta, "Status")
    };
    let episodes_total = meta_i64(&meta, "Episodes").unwrap_or(episodes_out.len() as i64);
    let related_ids = if franchise {
        Some(as_finite_numbers(meta.get("Related IDs")))
    } else {
        None
    };

    Ok(Series {
        path: series_path.to_string(),
        title: meta_str(&meta, "Title").unwrap_or_default(),
        year: meta_clone(&meta, "Year"),
        image: meta_str(&meta, "Image"),
        status,
        genres: as_strings(meta.get("Genres")),
        studio: as_strings(meta.get("Studio"))
            .iter()
            .map(|s| strip_wikilink(s))
            .collect(),
        themes: as_strings(meta.get("Themes")),
        demographics: as_strings(meta.get("Demographics")),
        producers: as_strings(meta.get("Producers"))
            .iter()
            .map(|s| strip_wikilink(s))
            .collect(),
        director: meta_str(&meta, "Director").map(|s| strip_wikilink(&s)),
        music: meta_str(&meta, "Music").map(|s| strip_wikilink(&s)),
        duration: meta_str(&meta, "Duration"),
        episodes_total,
        aired_from: meta_str(&meta, "Aired From"),
        aired_to: meta_str(&meta, "Aired To"),
        airing: meta_bool(&meta, "Airing"),
        local_path,
        download_status: meta_str(&meta, "Download Status"),
        online_rating: meta_clone(&meta, "Online Rating"),
        scored_by: meta_i64(&meta, "Scored By"),
        rank: meta_i64(&meta, "Rank"),
        popularity: meta_i64(&meta, "Popularity"),
        members: meta_i64(&meta, "Members"),
        premiered: meta_str(&meta, "Premiered"),
        format: meta_str(&meta, "Format"),
        source: meta_str(&meta, "Source"),
        rating: meta_str(&meta, "Rating"),
        broadcast: meta_str(&meta, "Broadcast"),
        title_japanese: meta_str(&meta, "Title Japanese"),
        title_english: meta_str(&meta, "Title English"),
        synonyms: as_strings(meta.get("Synonyms")),
        aired: meta_str(&meta, "Aired"),
        openings: as_strings(meta.get("Openings")),
        endings: as_strings(meta.get("Endings")),
        trailer: meta_str(&meta, "Trailer"),
        synopsis: extract_body_section(&body, "Plot"),
        background: extract_body_section(&body, "Background"),
        personal_rating: meta_f64(&meta, "Personal Rating"),
        started: meta_str(&meta, "Started"),
        finished: meta_str(&meta, "Finished"),
        watched_episodes: watched_value,
        franchise,
        related_ids,
        provider_id: meta_i64(&meta, "Provider ID"),
        seasons: seasons_out,
        episodes: episodes_out,
    })
}

fn frontmatter_head_tail(text: &str) -> Result<(String, String), VaultError> {
    if !text.starts_with("---") {
        return Err(VaultError::Invalid("No frontmatter".into()));
    }
    let end = text[3..]
        .find("\n---")
        .ok_or_else(|| VaultError::Invalid("No frontmatter".into()))?
        + 3;
    Ok((text[..end].to_string(), text[end..].to_string()))
}

pub fn mark_episode_watched(
    series_path: &str,
    episode_num: i64,
    season: Option<&str>,
    base_mtime: Option<f64>,
) -> Result<MarkEpisodeResponse, VaultError> {
    let abs = PathBuf::from(library_vault_root()).join(series_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!(
            "Series not found: {series_path}"
        )));
    }
    if episode_num <= 0 {
        return Err(VaultError::Invalid("Invalid episode number".into()));
    }
    check_mtime(&abs, base_mtime)?;
    let text = fs::read_to_string(&abs)?;
    let (meta, body) = parse_frontmatter(&text);
    let franchise = is_franchise(&meta);
    let season_str = season.map(str::to_string);
    let use_season = franchise && season_str.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let watched_key = if use_season {
        format!("Watched Episodes {}", season_str.as_ref().unwrap())
    } else {
        "Watched Episodes".to_string()
    };
    let status_key = if use_season {
        format!("Status {}", season_str.as_ref().unwrap())
    } else {
        "Status".to_string()
    };

    let mut watched: Vec<i64> = as_finite_numbers(meta.get(&watched_key));
    if !watched.contains(&episode_num) {
        watched.push(episode_num);
    }
    watched.sort();

    // Total: for franchise season, section table count; else meta.Episodes
    let total: Option<i64> = if use_season {
        let sections = parse_franchise_sections(&body);
        let sn = season_str.as_ref().unwrap();
        sections
            .iter()
            .find(|s| &s.suffix == sn)
            .map(|s| parse_episode_table(&s.content).len() as i64)
            .filter(|n| *n > 0)
    } else {
        meta_i64(&meta, "Episodes")
    };

    let prev_status = meta_str(&meta, &status_key).unwrap_or_else(|| "Plan-to-Watch".to_string());
    let mut new_status = prev_status.clone();
    if new_status == "Plan-to-Watch" {
        new_status = "Currently-Watching".to_string();
    }
    if let Some(t) = total {
        if (watched.len() as i64) >= t {
            new_status = "Completed".to_string();
        }
    }

    let (mut head, tail) = frontmatter_head_tail(&text)?;
    let watched_value_str = format!(
        "[{}]",
        watched
            .iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    head = set_frontmatter_field(&head, &watched_key, &watched_value_str);
    if new_status != prev_status {
        head = set_frontmatter_field(&head, &status_key, &new_status);
    }
    let out = format!("{head}{tail}");
    atomic_write(&abs, out.as_bytes())?;
    let stat = fs::metadata(&abs)?;
    Ok(MarkEpisodeResponse {
        ok: true,
        watched_episodes: watched,
        status: new_status,
        season: if use_season { season_str } else { None },
        mtime: mtime_ms(&stat),
    })
}

pub fn mark_status(
    series_path: &str,
    new_status: &str,
    season: Option<&str>,
    base_mtime: Option<f64>,
) -> Result<MarkSeriesStatusResponse, VaultError> {
    let abs = PathBuf::from(library_vault_root()).join(series_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!(
            "Series not found: {series_path}"
        )));
    }
    if new_status.is_empty() {
        return Err(VaultError::Invalid("status required".into()));
    }
    check_mtime(&abs, base_mtime)?;
    let text = fs::read_to_string(&abs)?;
    let (meta, _body) = parse_frontmatter(&text);
    let franchise = is_franchise(&meta);
    let season_str = season.map(str::to_string);
    let use_season = franchise && season_str.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let status_key = if use_season {
        format!("Status {}", season_str.as_ref().unwrap())
    } else {
        "Status".to_string()
    };
    let (head, tail) = frontmatter_head_tail(&text)?;
    let next_head = set_frontmatter_field(&head, &status_key, new_status);
    let out = format!("{next_head}{tail}");
    atomic_write(&abs, out.as_bytes())?;
    Ok(MarkSeriesStatusResponse {
        ok: true,
        status: new_status.to_string(),
        season: if use_season { season_str } else { None },
    })
}

pub fn mark_rating(
    series_path: &str,
    rating: f64,
    base_mtime: Option<f64>,
) -> Result<MarkSeriesRatingResponse, VaultError> {
    let abs = PathBuf::from(library_vault_root()).join(series_path);
    if !abs.exists() {
        return Err(VaultError::NotFound(format!(
            "Series not found: {series_path}"
        )));
    }
    if !rating.is_finite() || rating < 0.0 || rating > 10.0 {
        return Err(VaultError::Invalid("Rating must be a number in [0, 10]".into()));
    }
    check_mtime(&abs, base_mtime)?;
    let text = fs::read_to_string(&abs)?;
    let (head, tail) = frontmatter_head_tail(&text)?;
    let value = if rating.fract() == 0.0 {
        format!("{}", rating as i64)
    } else {
        format!("{rating}")
    };
    let next_head = set_frontmatter_field(&head, "Personal Rating", &value);
    let out = format!("{next_head}{tail}");
    atomic_write(&abs, out.as_bytes())?;
    Ok(MarkSeriesRatingResponse {
        ok: true,
        personal_rating: rating,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn h2_suffix_basic() {
        assert_eq!(h2_to_suffix("SEASON 1"), "Season 1");
        assert_eq!(h2_to_suffix("MOVIE"), "Movie");
        assert_eq!(h2_to_suffix("OVA 2"), "OVA 2");
        assert_eq!(h2_to_suffix("ED"), "ED");
    }

    #[test]
    fn episode_number_patterns() {
        assert_eq!(parse_episode_number("[Erai-raws] Title - 12 [1080p].mkv"), Some(12));
        assert_eq!(parse_episode_number("Title S01E12 - foo.mkv"), Some(12));
        assert_eq!(parse_episode_number("12 - Title.mkv"), Some(12));
        assert_eq!(parse_episode_number("Title E12.mkv"), Some(12));
        assert_eq!(parse_episode_number("foo.txt"), None);
    }

    #[test]
    fn extras_files_skipped() {
        assert!(is_extras_file("NCED 01.mkv"));
        assert!(is_extras_file("NCOP2.mkv"));
        assert!(is_extras_file("OP 01.mkv"));
        assert!(is_extras_file("ED_1.mkv"));
        assert!(is_extras_file("PV2.mkv"));
        assert!(is_extras_file("Menu.mkv"));
        assert!(!is_extras_file("Nichijou 01.mkv"));
        assert!(!is_extras_file("Edens Zero 01.mkv"));
        assert!(!is_extras_file("[Group] Show - 05.mkv"));
        assert!(!is_extras_file("Operation Z 03.mkv"));
    }

    #[test]
    fn franchise_section_split() {
        let body = "## SEASON 1\nfoo\n## MOVIE\nbar\n";
        let sections = parse_franchise_sections(body);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].suffix, "Season 1");
        assert_eq!(sections[1].suffix, "Movie");
    }

    #[test]
    fn body_section_plot_and_background() {
        let body = "## Plot\n\nA synopsis line.\n\n## Background\n\nProduction notes.\n\n## Episodes\n\n| 01 | x | |\n";
        assert_eq!(
            extract_body_section(body, "Plot").as_deref(),
            Some("A synopsis line.")
        );
        assert_eq!(
            extract_body_section(body, "Background").as_deref(),
            Some("Production notes.")
        );
        // Case-insensitive on the name; absent / empty sections → None.
        assert_eq!(
            extract_body_section(body, "plot").as_deref(),
            Some("A synopsis line.")
        );
        assert_eq!(extract_body_section(body, "Missing"), None);
        assert_eq!(extract_body_section("## Plot\n\n## Episodes\n", "Plot"), None);
    }

    #[test]
    fn episode_table_with_pipe_in_wikilink() {
        let body = "| 01 | [[a/b\\|Display]] | 2024-01-01 |\n";
        let rows = parse_episode_table(body);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Display");
        assert_eq!(rows[0].wikilink.as_deref(), Some("a/b"));
        assert_eq!(rows[0].aired.as_deref(), Some("2024-01-01"));
    }
}

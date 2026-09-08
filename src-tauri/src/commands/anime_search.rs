//! Anime Browse — AniList (GraphQL) search commands.
//!
//! Read-only outbound HTTP to `graphql.anilist.co` for the Video Player's Anime
//! Browse tab: title search, Top, current season, title detail, episodes, cast,
//! staff, relations, statistics, recommendations, and the character/person
//! pages.
//!
//! **Why AniList and not Jikan** (measured 2026-08-25): Jikan's origin is dead —
//! every 200 it still returns carries `X-Cache-Status: STALE` with a
//! `last-modified` no newer than 2026-07-30, and any URL not already in its
//! nginx cache 504s in ~0.42 s under every `Accept-Encoding`, from every
//! network. See `Knowledge/Mortar & Pestle/Plans/AniList Migration.md`.
//!
//! Every command keeps its exact name, `mal_id` parameter and return struct, so
//! the React side is untouched. AniList is queried BY MAL id (`Media(idMal:)`),
//! so nothing in the vault is re-keyed.
//!
//! Jikan survives as a **best-effort side-source** for the four things AniList
//! does not carry — opening songs, ending songs, the age rating, and the
//! background blurb — plus episode titles (`anime_episodes` prefers Jikan and
//! falls back to AniList `streamingEpisodes`). `jikan_side` never retries and
//! never errors: a dead Jikan leaves those fields empty and nothing else.
//!
//! A token-bucket limiter (2 req/s · 28 req/min, inside AniList's documented 30
//! req/min) lets a page's calls overlap; responses are cached in-memory (LRU)
//! and on disk with status-aware TTLs (airing 1h / finished 7d) and
//! stale-while-revalidate.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::commands::vault::VaultError;

const ANILIST_URL: &str = "https://graphql.anilist.co";
const JIKAN_BASE: &str = "https://api.jikan.moe/v4";
const USER_AGENT: &str = "Citadel/1.0 (mortar-pestle)";

// Token-bucket rate limit — AniList documents 90 req/min and currently serves a
// degraded 30 (`X-RateLimit-Limit: 30`, observed 2026-08-25). Stay under the
// degraded figure with headroom; the detail page went from ~7 requests to 1, so
// this is looser in practice than the old 60/min Jikan budget.
const MAX_PER_SEC: usize = 2;
const MAX_PER_MIN: usize = 28;

// Cache TTLs. Finished anime essentially never change; airing ones gain
// episodes/score/members so they expire fast. Cast/staff/relations stay stable
// even while airing, so they get the long TTL regardless.
const HOUR: u64 = 3600;
const DAY: u64 = 86_400;
const MEM_CAP: usize = 500;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeHit {
    pub mal_id: i64,
    pub title: String,
    pub title_english: Option<String>,
    pub year: Option<i64>,
    pub r#type: Option<String>,
    pub episodes: Option<i64>,
    pub score: Option<f64>,
    pub airing: bool,
    pub image: Option<String>,
    pub synopsis: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trailer {
    pub youtube_id: Option<String>,
    pub url: Option<String>,
    pub image: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeDetail {
    pub mal_id: i64,
    pub title: String,
    pub title_english: Option<String>,
    pub title_japanese: Option<String>,
    pub synonyms: Vec<String>,
    pub year: Option<i64>,
    pub season: Option<String>,
    pub r#type: Option<String>,
    pub episodes: Option<i64>,
    pub score: Option<f64>,
    pub scored_by: Option<i64>,
    pub rank: Option<i64>,
    pub popularity: Option<i64>,
    pub airing: bool,
    pub status: Option<String>,
    pub members: Option<i64>,
    pub duration: Option<String>,
    pub source: Option<String>,
    pub rating: Option<String>,
    pub broadcast: Option<String>,
    pub synopsis: Option<String>,
    pub background: Option<String>,
    pub genres: Vec<String>,
    pub studios: Vec<String>,
    pub themes: Vec<String>,
    pub demographics: Vec<String>,
    pub producers: Vec<String>,
    pub aired: Option<String>,
    pub aired_from: Option<String>,
    pub aired_to: Option<String>,
    pub openings: Vec<String>,
    pub endings: Vec<String>,
    pub trailer: Option<Trailer>,
    pub image: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeRow {
    /// Episode NUMBER (the field name is historical — Jikan exposed the episode
    /// number as `mal_id` on its episodes endpoint and the frontend reads
    /// `malId`).
    pub mal_id: i64,
    pub title: String,
    pub aired: Option<String>,
}

// ── Shared HTTP client (keep-alive) ──────────────────────────────────────────
fn http_client() -> &'static reqwest::Client {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    CELL.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

// ── Token-bucket rate limiter ────────────────────────────────────────────────
// A sliding window of recent request timestamps. The lock is taken ONLY to make
// the admission decision (and dropped before any sleep), so requests admitted
// within the window proceed concurrently.
fn rate_window() -> &'static Mutex<VecDeque<Instant>> {
    static CELL: OnceLock<Mutex<VecDeque<Instant>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(VecDeque::new()))
}

async fn admit() {
    loop {
        let wait = {
            let mut q = rate_window().lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            while let Some(&front) = q.front() {
                if now.duration_since(front) >= Duration::from_secs(60) {
                    q.pop_front();
                } else {
                    break;
                }
            }
            if q.len() >= MAX_PER_MIN {
                let front = *q.front().expect("len checked");
                Some(Duration::from_secs(60).saturating_sub(now.duration_since(front)))
            } else {
                let in_last_sec = q
                    .iter()
                    .rev()
                    .take_while(|&&t| now.duration_since(t) < Duration::from_secs(1))
                    .count();
                if in_last_sec >= MAX_PER_SEC {
                    let t = q[q.len() - MAX_PER_SEC];
                    Some(Duration::from_secs(1).saturating_sub(now.duration_since(t)))
                } else {
                    q.push_back(now);
                    None
                }
            }
        };
        match wait {
            None => return,
            // Floor the sleep so a near-zero wait can't spin the loop hot.
            Some(d) => tokio::time::sleep(d.max(Duration::from_millis(5))).await,
        }
    }
}

// ── Response cache (in-memory LRU + on-disk JSON) ─────────────────────────────
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Capture the per-app cache dir at startup (called from `lib.rs` setup). If the
/// dir can't be resolved/created, the disk cache silently disables (mem-only).
pub fn init_cache_dir(app: &tauri::AppHandle) {
    use tauri::Manager;
    match app.path().app_cache_dir() {
        Ok(dir) => {
            let sub = dir.join("anime");
            match std::fs::create_dir_all(&sub) {
                Ok(()) => {
                    let _ = CACHE_DIR.set(sub);
                }
                Err(e) => eprintln!("anime cache dir create failed: {e} — disk cache disabled"),
            }
        }
        Err(e) => eprintln!("app_cache_dir unavailable: {e} — anime disk cache disabled"),
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct CacheEntry {
    url: String,
    value: serde_json::Value,
    fetched_at: u64,
    ttl_secs: u64,
}

struct MemCache {
    map: HashMap<String, (CacheEntry, u64)>,
    seq: u64,
}

fn mem() -> &'static Mutex<MemCache> {
    static CELL: OnceLock<Mutex<MemCache>> = OnceLock::new();
    CELL.get_or_init(|| {
        Mutex::new(MemCache {
            map: HashMap::new(),
            seq: 0,
        })
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_file(key: &str) -> Option<PathBuf> {
    let dir = CACHE_DIR.get()?;
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    Some(dir.join(format!("{:016x}.json", h.finish())))
}

fn mem_insert(key: &str, entry: CacheEntry) {
    let mut m = mem().lock().unwrap_or_else(|e| e.into_inner());
    m.seq += 1;
    let seq = m.seq;
    if !m.map.contains_key(key) && m.map.len() >= MEM_CAP {
        if let Some(victim) = m
            .map
            .iter()
            .min_by_key(|(_, (_, s))| *s)
            .map(|(k, _)| k.clone())
        {
            m.map.remove(&victim);
        }
    }
    m.map.insert(key.to_string(), (entry, seq));
}

/// Look up a cached entry (mem first, then disk → promoted into mem). Returns it
/// regardless of freshness; callers decide via `fetched_at` + `ttl_secs`.
fn cache_lookup(key: &str) -> Option<CacheEntry> {
    {
        let mut m = mem().lock().unwrap_or_else(|e| e.into_inner());
        m.seq += 1;
        let seq = m.seq;
        if let Some(slot) = m.map.get_mut(key) {
            slot.1 = seq;
            return Some(slot.0.clone());
        }
    }
    let path = cache_file(key)?;
    let bytes = std::fs::read(&path).ok()?;
    let entry: CacheEntry = serde_json::from_slice(&bytes).ok()?;
    mem_insert(key, entry.clone());
    Some(entry)
}

fn cache_store(key: &str, value: &serde_json::Value, ttl_secs: u64) {
    let entry = CacheEntry {
        url: key.to_string(),
        value: value.clone(),
        fetched_at: now_secs(),
        ttl_secs,
    };
    mem_insert(key, entry.clone());
    // Per-key filename → distinct files, no cross-write contention.
    if let Some(path) = cache_file(key) {
        if let Ok(bytes) = serde_json::to_vec(&entry) {
            let _ = std::fs::write(&path, bytes);
        }
    }
}

// ── Fetch + cache ─────────────────────────────────────────────────────────────
#[derive(Clone, Copy)]
enum Ttl {
    Fixed(u64),
    /// airing → 1h, finished → 7d, decided from the media `status`.
    Detail,
}

/// `true` when this AniList payload describes a title that is still airing.
fn payload_airing(v: &serde_json::Value) -> bool {
    v.pointer("/Media/status").and_then(|s| s.as_str()) == Some("RELEASING")
}

fn resolve_ttl(ttl: Ttl, v: &serde_json::Value) -> u64 {
    match ttl {
        Ttl::Fixed(s) => s,
        Ttl::Detail => {
            if payload_airing(v) {
                HOUR
            } else {
                7 * DAY
            }
        }
    }
}

/// TTL for a title's episode list — follows the title's airing status by peeking
/// the cached detail entry (defaults to 1h when detail isn't cached yet).
fn anime_ttl(mal_id: i64) -> Ttl {
    match cache_lookup(&detail_key(mal_id)) {
        Some(entry) => Ttl::Fixed(if payload_airing(&entry.value) {
            HOUR
        } else {
            7 * DAY
        }),
        None => Ttl::Fixed(HOUR),
    }
}

/// Raw AniList POST through the rate limiter + shared client. Retries transient
/// failures — 429 (honoring Retry-After), 5xx, and transport timeouts — with
/// exponential backoff. No caching; `cached_gql` wraps this.
async fn anilist_post(
    query: &str,
    variables: serde_json::Value,
) -> Result<serde_json::Value, VaultError> {
    let client = http_client();
    let body = serde_json::json!({ "query": query, "variables": variables });
    let mut backoff = Duration::from_millis(1200);
    let mut last_err = String::new();
    for attempt in 0..4 {
        admit().await;
        let result = client
            .post(ANILIST_URL)
            .header(reqwest::header::ACCEPT, "application/json")
            // See the note in scripts/download_anime.py: AniList 403s any
            // client that does not present as their own site, and the Referer
            // alone is what clears it.
            .header(reqwest::header::REFERER, "https://anilist.co/")
            .json(&body)
            .timeout(Duration::from_secs(15))
            .send()
            .await;
        let resp = match result {
            Ok(r) => r,
            // Transport error (timeout, reset, refused) — transient → retry.
            Err(e) => {
                last_err = format!("AniList request failed: {e}");
                if attempt < 3 {
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(8));
                    continue;
                }
                return Err(VaultError::Io(last_err));
            }
        };
        let status = resp.status().as_u16();
        if (status == 429 || (500..=599).contains(&status)) && attempt < 3 {
            let wait = if status == 429 {
                resp.headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .map(|s| Duration::from_secs(s.min(60)))
                    .unwrap_or(backoff)
            } else {
                backoff
            };
            tokio::time::sleep(wait).await;
            backoff = (backoff * 2).min(Duration::from_secs(8));
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(VaultError::Io(format!("AniList returned HTTP {status}")));
        }
        let v = resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| VaultError::Io(format!("AniList JSON parse failed: {e}")))?;
        // GraphQL reports field-level failures in a 200 body.
        if let Some(msg) = v
            .pointer("/errors/0/message")
            .and_then(|m| m.as_str())
            .filter(|_| v.get("data").map(|d| d.is_null()).unwrap_or(true))
        {
            return Err(VaultError::Io(format!("AniList: {msg}")));
        }
        return v
            .get("data")
            .cloned()
            .ok_or_else(|| VaultError::Io("AniList response had no data.".into()));
    }
    Err(VaultError::Io(if last_err.is_empty() {
        "AniList unavailable after retries.".into()
    } else {
        last_err
    }))
}

/// Cached AniList query. Fresh entry → instant return. Stale entry →
/// stale-while-revalidate (return stale now, refresh in the background). Miss →
/// fetch + store. A stale entry is always returned immediately even if the
/// background refresh later fails (offline fallback); only a true miss with a
/// failed fetch propagates the error.
async fn cached_gql(
    key: &str,
    query: &str,
    variables: serde_json::Value,
    ttl: Ttl,
) -> Result<serde_json::Value, VaultError> {
    if let Some(entry) = cache_lookup(key) {
        let fresh = now_secs().saturating_sub(entry.fetched_at) < entry.ttl_secs;
        if !fresh {
            let key_owned = key.to_string();
            let query_owned = query.to_string();
            tauri::async_runtime::spawn(async move {
                if let Ok(v) = anilist_post(&query_owned, variables).await {
                    cache_store(&key_owned, &v, resolve_ttl(ttl, &v));
                }
            });
        }
        return Ok(entry.value);
    }
    let v = anilist_post(query, variables).await?;
    cache_store(key, &v, resolve_ttl(ttl, &v));
    Ok(v)
}

// ── Jikan side-source (best-effort, never fatal) ─────────────────────────────
// Jikan alone carries opening/ending song lists, the age rating, the background
// blurb, and per-episode titles. Its origin has been dead since ~2026-07-30 and
// answers only out of a stale nginx cache, so this path takes ONE attempt with a
// short timeout and swallows every failure — a dead Jikan must never slow down
// or fail an AniList-backed page.
async fn jikan_side(path: &str, ttl: Ttl) -> Option<serde_json::Value> {
    let key = format!("jk:{path}");
    if let Some(entry) = cache_lookup(&key) {
        if now_secs().saturating_sub(entry.fetched_at) < entry.ttl_secs {
            return Some(entry.value);
        }
    }
    admit().await;
    let resp = http_client()
        .get(format!("{JIKAN_BASE}/{path}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(Duration::from_secs(6))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v = resp.json::<serde_json::Value>().await.ok()?;
    let secs = match ttl {
        Ttl::Fixed(s) => s,
        Ttl::Detail => 7 * DAY,
    };
    cache_store(&key, &v, secs);
    Some(v)
}

// ── Value helpers ────────────────────────────────────────────────────────────
fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn str_at(v: &serde_json::Value, ptr: &str) -> Option<String> {
    v.pointer(ptr)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn i64_at(v: &serde_json::Value, ptr: &str) -> Option<i64> {
    v.pointer(ptr).and_then(|x| x.as_i64())
}

fn str_list(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().filter(|s| !s.is_empty()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// `SIDE_STORY` → `Side story`, `LIGHT_NOVEL` → `Light novel`, `TV` → `TV`.
/// Sentence case, matching MAL's own labels — only the first word is
/// capitalised. All-caps runs of 3 or fewer characters (TV, OVA, ONA) keep
/// their case wherever they appear.
fn humanize_enum(raw: &str) -> String {
    let words: Vec<String> = raw
        .split('_')
        .filter(|w| !w.is_empty())
        .enumerate()
        .map(|(i, w)| {
            if w.len() <= 3 {
                return w.to_string();
            }
            let lower = w.to_lowercase();
            if i > 0 {
                return lower;
            }
            let mut c = lower.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect();
    words.join(" ")
}

/// AniList `MediaFormat` → the MAL-shaped label the UI already renders.
fn format_label(raw: &str) -> String {
    match raw {
        "TV" => "TV".into(),
        "TV_SHORT" => "TV Short".into(),
        "MOVIE" => "Movie".into(),
        "SPECIAL" => "Special".into(),
        "OVA" => "OVA".into(),
        "ONA" => "ONA".into(),
        "MUSIC" => "Music".into(),
        other => humanize_enum(other),
    }
}

/// AniList `MediaStatus` → the MAL-shaped status string the UI already renders.
fn status_label(raw: &str) -> String {
    match raw {
        "RELEASING" => "Currently Airing".into(),
        "FINISHED" => "Finished Airing".into(),
        "NOT_YET_RELEASED" => "Not yet aired".into(),
        "CANCELLED" => "Cancelled".into(),
        "HIATUS" => "On Hiatus".into(),
        other => humanize_enum(other),
    }
}

/// AniList descriptions are HTML fragments (`<br>`, `<i>`, `<b>`, `<a>`).
/// Flatten to the plain text every consumer of `synopsis`/`about` expects.
fn strip_html(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for ch in raw.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let t = tag.trim_start_matches('/').to_ascii_lowercase();
                if t.starts_with("br") || t.starts_with("p") {
                    out.push('\n');
                }
            }
            c if in_tag => tag.push(c),
            c => out.push(c),
        }
    }
    let out = out
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&");
    // Collapse the blank-line runs the <br><br> pairs leave behind.
    let mut collapsed = String::with_capacity(out.len());
    let mut blanks = 0;
    for line in out.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        collapsed.push_str(line.trim_end());
        collapsed.push('\n');
    }
    collapsed.trim().to_string()
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `{year,month,day}` → `2013-04-07` (day/month may be null → best prefix).
fn fuzzy_iso(v: Option<&serde_json::Value>) -> Option<String> {
    let d = v?;
    let y = d.get("year").and_then(|x| x.as_i64())?;
    match (
        d.get("month").and_then(|x| x.as_i64()),
        d.get("day").and_then(|x| x.as_i64()),
    ) {
        (Some(m), Some(day)) => Some(format!("{y:04}-{m:02}-{day:02}")),
        (Some(m), None) => Some(format!("{y:04}-{m:02}")),
        _ => Some(format!("{y:04}")),
    }
}

/// `{year,month,day}` → `Apr 7, 2013`.
fn fuzzy_human(v: Option<&serde_json::Value>) -> Option<String> {
    let d = v?;
    let y = d.get("year").and_then(|x| x.as_i64())?;
    match (
        d.get("month").and_then(|x| x.as_i64()),
        d.get("day").and_then(|x| x.as_i64()),
    ) {
        (Some(m), Some(day)) if (1..=12).contains(&m) => {
            Some(format!("{} {day}, {y}", MONTHS[(m - 1) as usize]))
        }
        (Some(m), None) if (1..=12).contains(&m) => Some(format!("{} {y}", MONTHS[(m - 1) as usize])),
        _ => Some(y.to_string()),
    }
}

/// The AniList season the current date falls in, as `(SEASON, year)`.
fn current_season() -> (&'static str, i64) {
    use chrono::Datelike;
    let now = chrono::Local::now();
    let (m, y) = (now.month(), now.year() as i64);
    match m {
        12 => ("WINTER", y + 1),
        1 | 2 => ("WINTER", y),
        3..=5 => ("SPRING", y),
        6..=8 => ("SUMMER", y),
        _ => ("FALL", y),
    }
}

// ── Shared GraphQL fragments ─────────────────────────────────────────────────
/// The field set behind `AnimeHit` — kept identical across every grid query so
/// one parser serves search, top, season and discover.
const HIT_FIELDS: &str = r#"
  id idMal
  title { romaji english }
  seasonYear startDate { year }
  format episodes averageScore status
  coverImage { extraLarge large }
  description
"#;

/// AniList rejects a query that DECLARES a variable it never uses ("Variable
/// \"$a\" is never used."), so each caller passes exactly its own declarations.
fn hit_query(vars: &str, selector: &str) -> String {
    format!("query({vars}){{Page(page:$p,perPage:25){{media({selector}){{{HIT_FIELDS}}}}}}}")
}

fn parse_hit(v: &serde_json::Value) -> Option<AnimeHit> {
    // MAL id is the app's identity for an anime (routes, vault cards, torrent
    // tags). An AniList-only entry has none and is skipped rather than given a
    // fake id.
    let mal_id = v.get("idMal").and_then(|x| x.as_i64()).filter(|n| *n > 0)?;
    Some(AnimeHit {
        mal_id,
        title: str_at(v, "/title/romaji")
            .or_else(|| str_at(v, "/title/english"))
            .unwrap_or_default(),
        title_english: str_at(v, "/title/english"),
        year: v
            .get("seasonYear")
            .and_then(|x| x.as_i64())
            .or_else(|| i64_at(v, "/startDate/year")),
        r#type: str_field(v, "format").map(|f| format_label(&f)),
        episodes: v.get("episodes").and_then(|x| x.as_i64()),
        score: v
            .get("averageScore")
            .and_then(|x| x.as_f64())
            .map(|s| s / 10.0),
        airing: str_field(v, "status").as_deref() == Some("RELEASING"),
        image: str_at(v, "/coverImage/extraLarge").or_else(|| str_at(v, "/coverImage/large")),
        synopsis: str_field(v, "description").map(|d| strip_html(&d)),
    })
}

fn parse_hits(v: &serde_json::Value) -> Vec<AnimeHit> {
    v.pointer("/Page/media")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(parse_hit).collect())
        .unwrap_or_default()
}

/// `Studio(search:)` wraps its grid one level deeper.
fn parse_studio_hits(v: &serde_json::Value) -> Vec<AnimeHit> {
    v.pointer("/Studio/media/nodes")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(parse_hit).collect())
        .unwrap_or_default()
}

// ── Browse grids ─────────────────────────────────────────────────────────────
#[tauri::command]
pub async fn anime_search(query: String) -> Result<Vec<AnimeHit>, VaultError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!("query($p:Int,$a:String){{Page(page:$p,perPage:25){{media(search:$a,type:ANIME,isAdult:false,sort:SEARCH_MATCH){{{HIT_FIELDS}}}}}}}");
    let v = cached_gql(
        &format!("al:search:{}", q.to_lowercase()),
        &sql,
        serde_json::json!({ "p": 1, "a": q }),
        Ttl::Fixed(HOUR),
    )
    .await?;
    Ok(parse_hits(&v))
}

#[tauri::command]
pub async fn anime_top(page: Option<u32>) -> Result<Vec<AnimeHit>, VaultError> {
    let page = page.unwrap_or(1).max(1);
    let sql = hit_query("$p:Int", "type:ANIME,isAdult:false,sort:SCORE_DESC");
    let v = cached_gql(
        &format!("al:top:{page}"),
        &sql,
        serde_json::json!({ "p": page }),
        Ttl::Fixed(HOUR),
    )
    .await?;
    Ok(parse_hits(&v))
}

#[tauri::command]
pub async fn anime_season_now(page: Option<u32>) -> Result<Vec<AnimeHit>, VaultError> {
    let page = page.unwrap_or(1).max(1);
    let (season, year) = current_season();
    Ok(season_page(season, year, page).await?)
}

/// One page of a named season's grid, ordered by popularity.
async fn season_page(season: &str, year: i64, page: u32) -> Result<Vec<AnimeHit>, VaultError> {
    let sql = format!("query($p:Int,$s:MediaSeason,$y:Int){{Page(page:$p,perPage:25){{media(type:ANIME,isAdult:false,season:$s,seasonYear:$y,sort:POPULARITY_DESC){{{HIT_FIELDS}}}}}}}");
    let v = cached_gql(
        &format!("al:season:{season}:{year}:{page}"),
        &sql,
        serde_json::json!({ "p": page, "s": season, "y": year }),
        Ttl::Fixed(HOUR),
    )
    .await?;
    Ok(parse_hits(&v))
}

/// Native discovery for a clickable taxon. `kind` is one of
/// `genre` (AniList genre), `theme`/`demographic` (AniList tag), `studio`,
/// `type` (media format) or `season` ("Spring 2020"). Results are the same
/// `AnimeHit` shape the Browse grids already render. An unresolvable name
/// returns an empty list (the grid shows its empty state).
#[tauri::command]
pub async fn anime_discover(
    kind: String,
    name: String,
    page: Option<u32>,
) -> Result<Vec<AnimeHit>, VaultError> {
    let page = page.unwrap_or(1).max(1);
    let name = name.trim();
    if name.is_empty() {
        return Ok(Vec::new());
    }
    match kind.as_str() {
        "genre" => {
            let sql = hit_query("$p:Int,$a:String", "type:ANIME,isAdult:false,genre:$a,sort:POPULARITY_DESC");
            let v = cached_gql(
                &format!("al:genre:{}:{page}", name.to_lowercase()),
                &sql,
                serde_json::json!({ "p": page, "a": name }),
                Ttl::Fixed(HOUR),
            )
            .await?;
            Ok(parse_hits(&v))
        }
        // MAL's themes and demographics are both AniList *tags*.
        "theme" | "demographic" => {
            let sql = hit_query("$p:Int,$a:String", "type:ANIME,isAdult:false,tag:$a,sort:POPULARITY_DESC");
            let v = cached_gql(
                &format!("al:tag:{}:{page}", name.to_lowercase()),
                &sql,
                serde_json::json!({ "p": page, "a": name }),
                Ttl::Fixed(HOUR),
            )
            .await?;
            Ok(parse_hits(&v))
        }
        "studio" => {
            let sql = format!("query($p:Int,$a:String){{Studio(search:$a){{id name media(page:$p,perPage:25,sort:POPULARITY_DESC){{nodes{{{HIT_FIELDS}}}}}}}}}");
            let v = cached_gql(
                &format!("al:studio:{}:{page}", name.to_lowercase()),
                &sql,
                serde_json::json!({ "p": page, "a": name }),
                Ttl::Fixed(7 * DAY),
            )
            .await?;
            Ok(parse_studio_hits(&v))
        }
        "type" => {
            let fmt = match name.to_lowercase().as_str() {
                "tv" => "TV",
                "tv short" => "TV_SHORT",
                "movie" => "MOVIE",
                "special" => "SPECIAL",
                "ova" => "OVA",
                "ona" => "ONA",
                "music" => "MUSIC",
                _ => return Ok(Vec::new()),
            };
            let sql = hit_query("$p:Int,$b:[MediaFormat]", "type:ANIME,isAdult:false,format_in:$b,sort:POPULARITY_DESC");
            let v = cached_gql(
                &format!("al:format:{fmt}:{page}"),
                &sql,
                serde_json::json!({ "p": page, "b": [fmt] }),
                Ttl::Fixed(HOUR),
            )
            .await?;
            Ok(parse_hits(&v))
        }
        "season" => {
            // "Spring 2020" → season SPRING, year 2020
            let parts: Vec<&str> = name.split_whitespace().collect();
            if parts.len() != 2 {
                return Ok(Vec::new());
            }
            let season = match parts[0].to_lowercase().as_str() {
                "winter" => "WINTER",
                "spring" => "SPRING",
                "summer" => "SUMMER",
                "fall" | "autumn" => "FALL",
                _ => return Ok(Vec::new()),
            };
            let Ok(year) = parts[1].parse::<i64>() else {
                return Ok(Vec::new());
            };
            season_page(season, year, page).await
        }
        other => Err(VaultError::Invalid(format!("Unknown taxon kind: {other}"))),
    }
}

// ── Detail ───────────────────────────────────────────────────────────────────
fn detail_key(mal_id: i64) -> String {
    format!("al:detail:{mal_id}")
}

const DETAIL_QUERY: &str = r#"
query($idMal:Int){
  Media(idMal:$idMal, type:ANIME){
    id idMal
    title { romaji english native }
    synonyms format episodes duration status season seasonYear source
    startDate { year month day } endDate { year month day }
    averageScore popularity
    rankings { rank type allTime }
    genres
    tags { name rank isGeneralSpoiler isMediaSpoiler }
    studios { edges { isMain node { name } } }
    description
    coverImage { extraLarge large }
    trailer { id site thumbnail }
    stats { scoreDistribution { amount } }
  }
}
"#;

/// Tags AniList files as demographics; MAL surfaces them as their own row.
const DEMOGRAPHIC_TAGS: [&str; 5] = ["Shounen", "Shoujo", "Seinen", "Josei", "Kids"];

/// Tag names above the noise floor, minus spoilers and the demographic tags
/// (which get their own field). MAL's "themes" are the same idea.
fn theme_tags(d: &serde_json::Value) -> Vec<String> {
    d.get("tags")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|t| {
                    t.get("isGeneralSpoiler").and_then(|b| b.as_bool()) != Some(true)
                        && t.get("isMediaSpoiler").and_then(|b| b.as_bool()) != Some(true)
                        && t.get("rank").and_then(|r| r.as_i64()).unwrap_or(0) >= 60
                })
                .filter_map(|t| str_field(t, "name"))
                .filter(|n| !DEMOGRAPHIC_TAGS.contains(&n.as_str()))
                .collect()
        })
        .unwrap_or_default()
}

fn demographic_tags(d: &serde_json::Value) -> Vec<String> {
    d.get("tags")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| str_field(t, "name"))
                .filter(|n| DEMOGRAPHIC_TAGS.contains(&n.as_str()))
                .collect()
        })
        .unwrap_or_default()
}

/// Studio names, split by AniList's `isMain` flag — main studios map to MAL's
/// "Studio", the rest to MAL's "Producers".
fn studio_names(d: &serde_json::Value, main: bool) -> Vec<String> {
    d.pointer("/studios/edges")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|e| e.get("isMain").and_then(|b| b.as_bool()).unwrap_or(false) == main)
                .filter_map(|e| str_at(e, "/node/name"))
                .collect()
        })
        .unwrap_or_default()
}

/// All-time rank of the given kind (`RATED` → MAL's rank, `POPULAR` → MAL's
/// popularity), falling back to the seasonal figure when no all-time one exists.
fn ranking(d: &serde_json::Value, kind: &str) -> Option<i64> {
    let arr = d.get("rankings")?.as_array()?;
    arr.iter()
        .find(|r| {
            str_field(r, "type").as_deref() == Some(kind)
                && r.get("allTime").and_then(|b| b.as_bool()) == Some(true)
        })
        .or_else(|| {
            arr.iter()
                .find(|r| str_field(r, "type").as_deref() == Some(kind))
        })
        .and_then(|r| r.get("rank").and_then(|x| x.as_i64()))
}

#[tauri::command]
pub async fn anime_detail(mal_id: i64) -> Result<AnimeDetail, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let v = cached_gql(
        &detail_key(mal_id),
        DETAIL_QUERY,
        serde_json::json!({ "idMal": mal_id }),
        Ttl::Detail,
    )
    .await?;
    let d = v
        .get("Media")
        .filter(|m| !m.is_null())
        .ok_or_else(|| VaultError::Io("AniList has no entry for this MAL ID.".into()))?;

    // Openings / endings / age rating / background live only on Jikan. `/full`
    // is the ONLY endpoint carrying the song lists — plain `/anime/{id}` returns
    // `theme: null` — so try it first and fall back to the plain endpoint, which
    // still has rating + background. Best-effort: a dead Jikan leaves them empty.
    let side = match jikan_side(&format!("anime/{mal_id}/full"), Ttl::Fixed(7 * DAY)).await {
        Some(v) => Some(v),
        None => jikan_side(&format!("anime/{mal_id}"), Ttl::Fixed(7 * DAY)).await,
    };
    let side = side.as_ref().and_then(|s| s.get("data"));
    let side_list = |group: &str| -> Vec<String> {
        side.and_then(|s| s.get("theme"))
            .map(|t| str_list(t, group))
            .unwrap_or_default()
    };

    let episodes = d.get("episodes").and_then(|x| x.as_i64());
    let duration = d.get("duration").and_then(|x| x.as_i64()).map(|m| {
        if episodes.unwrap_or(1) > 1 {
            format!("{m} min per ep")
        } else {
            format!("{m} min")
        }
    });
    let aired_from = fuzzy_iso(d.get("startDate"));
    let aired_to = fuzzy_iso(d.get("endDate"));
    let aired = match (fuzzy_human(d.get("startDate")), fuzzy_human(d.get("endDate"))) {
        (Some(f), Some(t)) if f != t => Some(format!("{f} to {t}")),
        (Some(f), _) => Some(f),
        _ => None,
    };
    // Trailer — YouTube only (the in-app browser's nav allow-list passes
    // youtube.com); Dailymotion entries are dropped so the card renders nothing.
    let trailer = d.get("trailer").filter(|t| !t.is_null()).and_then(|t| {
        if str_field(t, "site").as_deref() != Some("youtube") {
            return None;
        }
        let youtube_id = str_field(t, "id")?;
        Some(Trailer {
            image: str_field(t, "thumbnail")
                .or_else(|| Some(format!("https://img.youtube.com/vi/{youtube_id}/hqdefault.jpg"))),
            url: Some(format!("https://www.youtube.com/watch?v={youtube_id}")),
            youtube_id: Some(youtube_id),
        })
    });
    // MAL's "Scored By" is the number of users who scored it — the same figure
    // AniList's score histogram sums to.
    let scored_by = d
        .pointer("/stats/scoreDistribution")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|b| b.get("amount").and_then(|x| x.as_i64()))
                .sum::<i64>()
        })
        .filter(|n| *n > 0);

    Ok(AnimeDetail {
        mal_id: d.get("idMal").and_then(|x| x.as_i64()).unwrap_or(mal_id),
        title: str_at(d, "/title/romaji")
            .or_else(|| str_at(d, "/title/english"))
            .unwrap_or_default(),
        title_english: str_at(d, "/title/english"),
        title_japanese: str_at(d, "/title/native"),
        synonyms: str_list(d, "synonyms"),
        year: d
            .get("seasonYear")
            .and_then(|x| x.as_i64())
            .or_else(|| i64_at(d, "/startDate/year")),
        season: str_field(d, "season").map(|s| humanize_enum(&s)),
        r#type: str_field(d, "format").map(|f| format_label(&f)),
        episodes,
        score: d
            .get("averageScore")
            .and_then(|x| x.as_f64())
            .map(|s| s / 10.0),
        scored_by,
        rank: ranking(d, "RATED"),
        popularity: ranking(d, "POPULAR"),
        airing: str_field(d, "status").as_deref() == Some("RELEASING"),
        status: str_field(d, "status").map(|s| status_label(&s)),
        members: d.get("popularity").and_then(|x| x.as_i64()),
        duration,
        source: str_field(d, "source").map(|s| humanize_enum(&s)),
        rating: side.and_then(|s| str_field(s, "rating")),
        broadcast: side
            .and_then(|s| s.get("broadcast"))
            .and_then(|b| str_field(b, "string")),
        synopsis: str_field(d, "description").map(|s| strip_html(&s)),
        background: side.and_then(|s| str_field(s, "background")),
        genres: str_list(d, "genres"),
        studios: studio_names(d, true),
        themes: theme_tags(d),
        demographics: demographic_tags(d),
        producers: studio_names(d, false),
        aired,
        aired_from,
        aired_to,
        openings: side_list("openings"),
        endings: side_list("endings"),
        trailer,
        image: str_at(d, "/coverImage/extraLarge").or_else(|| str_at(d, "/coverImage/large")),
        source_url: Some(format!("https://myanimelist.net/anime/{mal_id}")),
    })
}

// ── Episodes ─────────────────────────────────────────────────────────────────
const STREAMING_EPISODES_QUERY: &str = r#"
query($idMal:Int){ Media(idMal:$idMal, type:ANIME){ streamingEpisodes { title } } }
"#;

/// `Episode 3 - A Dim Light` → `(3, "A Dim Light")`.
fn parse_streaming_title(raw: &str) -> Option<(i64, String)> {
    let rest = raw.strip_prefix("Episode ")?;
    let (num, title) = rest.split_once(" - ").unwrap_or((rest, ""));
    Some((num.trim().parse().ok()?, title.trim().to_string()))
}

#[tauri::command]
pub async fn anime_episodes(mal_id: i64) -> Result<Vec<EpisodeRow>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let ttl = anime_ttl(mal_id);
    // Jikan first — it is the only source with real per-episode titles AND air
    // dates. Best-effort: one attempt per page, and the moment it fails we fall
    // through to AniList's streaming titles.
    let mut out: Vec<EpisodeRow> = Vec::new();
    let mut page = 1u32;
    loop {
        let Some(v) = jikan_side(&format!("anime/{mal_id}/episodes?page={page}"), ttl).await else {
            break;
        };
        if let Some(arr) = v.get("data").and_then(|x| x.as_array()) {
            for e in arr {
                let Some(n) = e.get("mal_id").and_then(|x| x.as_i64()) else {
                    continue;
                };
                out.push(EpisodeRow {
                    mal_id: n,
                    title: str_field(e, "title").unwrap_or_default(),
                    aired: e
                        .get("aired")
                        .and_then(|x| x.as_str())
                        .and_then(|s| s.get(0..10))
                        .map(str::to_string),
                });
            }
        }
        let has_next = v
            .pointer("/pagination/has_next_page")
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        // Cap at 25 pages (~2500 eps) as a runaway guard for long-runners.
        if !has_next || page >= 25 {
            break;
        }
        page += 1;
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    if !out.is_empty() {
        return Ok(out);
    }
    // Fallback: AniList's streaming titles. Complete for a normal-length
    // licensed series (Shingeki no Kyojin: 25/25), a recent-window subset for
    // 1000-episode runners, and empty for unlicensed titles — no air dates.
    let v = cached_gql(
        &format!("al:eps:{mal_id}"),
        STREAMING_EPISODES_QUERY,
        serde_json::json!({ "idMal": mal_id }),
        ttl,
    )
    .await?;
    let mut rows: Vec<EpisodeRow> = v
        .pointer("/Media/streamingEpisodes")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    let (n, title) = parse_streaming_title(e.get("title")?.as_str()?)?;
                    Some(EpisodeRow {
                        mal_id: n,
                        title,
                        aired: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    rows.sort_by_key(|r| r.mal_id);
    Ok(rows)
}

// ── Max-detail credits ──────────────────────────────────────────────────────
// The per-anime detail page's Characters, Staff and Related sections — for owned
// AND not-owned titles alike. Read-only; portraits hot-linked, nothing
// persisted. Each rides the same rate limiter + cache as the rest.
//
// NOTE ON IDS: character and person ids here are AniList ids, not MAL ids (the
// struct field keeps the historical `mal_id` name so the frontend's `malId` key
// is unchanged). They are only ever handed back to `character_full` /
// `person_full`, which query AniList — so the pair stays self-consistent. Anime
// ids remain MAL ids everywhere, because those key routes and vault cards.

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceActor {
    pub mal_id: i64,
    pub name: String,
    pub language: String,
    pub image: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeCharacter {
    pub mal_id: i64,
    pub name: String,
    pub image: Option<String>,
    pub role: Option<String>,
    pub voice_actors: Vec<VoiceActor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffMember {
    pub mal_id: i64,
    pub name: String,
    pub image: Option<String>,
    pub positions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationEntry {
    pub mal_id: i64,
    pub name: String,
    pub r#type: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeRelation {
    pub relation: String,
    pub entries: Vec<RelationEntry>,
}

const CHARACTERS_QUERY: &str = r#"
query($idMal:Int){
  Media(idMal:$idMal, type:ANIME){
    characters(sort:[ROLE,RELEVANCE], perPage:50){
      edges{
        role
        node { id name { full } image { large } }
        voiceActorRoles(sort:RELEVANCE){
          voiceActor { id name { full } languageV2 image { large } }
        }
      }
    }
  }
}
"#;

/// Japanese + English VAs from a `voiceActorRoles` list, Japanese first.
/// AniList carries every dub language; the UI only shows these two.
fn parse_voice_actor_roles(list: &[serde_json::Value]) -> Vec<VoiceActor> {
    let mut out: Vec<VoiceActor> = list
        .iter()
        .filter_map(|r| {
            let va = r.get("voiceActor")?;
            let language = str_field(va, "languageV2")?;
            if language != "Japanese" && language != "English" {
                return None;
            }
            Some(VoiceActor {
                mal_id: va.get("id").and_then(|x| x.as_i64()).unwrap_or(0),
                name: str_at(va, "/name/full").unwrap_or_default(),
                language,
                image: str_at(va, "/image/large"),
            })
        })
        .collect();
    out.sort_by_key(|v| if v.language == "Japanese" { 0 } else { 1 });
    out
}

#[tauri::command]
pub async fn anime_characters(mal_id: i64) -> Result<Vec<AnimeCharacter>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let v = cached_gql(
        &format!("al:chars:{mal_id}"),
        CHARACTERS_QUERY,
        serde_json::json!({ "idMal": mal_id }),
        Ttl::Fixed(7 * DAY),
    )
    .await?;
    let out = v
        .pointer("/Media/characters/edges")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    Some(AnimeCharacter {
                        mal_id: i64_at(e, "/node/id").unwrap_or(0),
                        name: str_at(e, "/node/name/full").unwrap_or_default(),
                        image: str_at(e, "/node/image/large"),
                        role: str_field(e, "role").map(|r| humanize_enum(&r)),
                        voice_actors: parse_voice_actor_roles(
                            e.get("voiceActorRoles")
                                .and_then(|x| x.as_array())
                                .map(Vec::as_slice)
                                .unwrap_or(&[]),
                        ),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // AniList already sorts ROLE-first; nothing to re-sort.
    Ok(out)
}

const STAFF_QUERY: &str = r#"
query($idMal:Int){
  Media(idMal:$idMal, type:ANIME){
    staff(sort:RELEVANCE, perPage:50){
      edges { role node { id name { full } image { large } } }
    }
  }
}
"#;

#[tauri::command]
pub async fn anime_staff(mal_id: i64) -> Result<Vec<StaffMember>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let v = cached_gql(
        &format!("al:staff:{mal_id}"),
        STAFF_QUERY,
        serde_json::json!({ "idMal": mal_id }),
        Ttl::Fixed(7 * DAY),
    )
    .await?;
    // AniList emits one edge per (person, role); MAL grouped roles per person.
    // Dedup by person, collecting positions, so a Director + Storyboard shows
    // one card.
    let mut out: Vec<StaffMember> = Vec::new();
    let mut index: HashMap<i64, usize> = HashMap::new();
    if let Some(arr) = v.pointer("/Media/staff/edges").and_then(|x| x.as_array()) {
        for e in arr {
            let Some(id) = i64_at(e, "/node/id") else {
                continue;
            };
            let role = str_field(e, "role");
            match index.get(&id) {
                Some(&i) => {
                    if let Some(r) = role {
                        let slot: &mut StaffMember = &mut out[i];
                        if !slot.positions.contains(&r) {
                            slot.positions.push(r);
                        }
                    }
                }
                None => {
                    index.insert(id, out.len());
                    out.push(StaffMember {
                        mal_id: id,
                        name: str_at(e, "/node/name/full").unwrap_or_default(),
                        image: str_at(e, "/node/image/large"),
                        positions: role.into_iter().collect(),
                    });
                }
            }
        }
    }
    Ok(out)
}

const RELATIONS_QUERY: &str = r#"
query($idMal:Int){
  Media(idMal:$idMal, type:ANIME){
    relations {
      edges {
        relationType(version:2)
        node { id idMal type title { romaji english } }
      }
    }
  }
}
"#;

#[tauri::command]
pub async fn anime_relations(mal_id: i64) -> Result<Vec<AnimeRelation>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let v = cached_gql(
        &format!("al:relations:{mal_id}"),
        RELATIONS_QUERY,
        serde_json::json!({ "idMal": mal_id }),
        Ttl::Fixed(7 * DAY),
    )
    .await?;
    // Group the flat edge list by relation type, preserving first-seen order.
    let mut out: Vec<AnimeRelation> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    if let Some(arr) = v.pointer("/Media/relations/edges").and_then(|x| x.as_array()) {
        for e in arr {
            // Anime relations only — no in-app detail route for manga.
            if str_at(e, "/node/type").as_deref() != Some("ANIME") {
                continue;
            }
            let Some(entry_mal_id) = i64_at(e, "/node/idMal").filter(|n| *n > 0) else {
                continue;
            };
            let Some(relation) = str_field(e, "relationType").map(|r| humanize_enum(&r)) else {
                continue;
            };
            let entry = RelationEntry {
                mal_id: entry_mal_id,
                name: str_at(e, "/node/title/romaji")
                    .or_else(|| str_at(e, "/node/title/english"))
                    .unwrap_or_default(),
                r#type: Some("anime".into()),
                url: Some(format!("https://myanimelist.net/anime/{entry_mal_id}")),
            };
            match index.get(&relation) {
                Some(&i) => out[i].entries.push(entry),
                None => {
                    index.insert(relation.clone(), out.len());
                    out.push(AnimeRelation {
                        relation,
                        entries: vec![entry],
                    });
                }
            }
        }
    }
    Ok(out)
}

// ── Statistics + recommendations ─────────────────────────────────────────────
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreBucket {
    pub score: i64,
    pub votes: i64,
    pub percentage: f64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusBreakdown {
    pub watching: i64,
    pub completed: i64,
    pub on_hold: i64,
    pub dropped: i64,
    pub plan_to_watch: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeStatistics {
    pub total: i64,
    pub scores: Vec<ScoreBucket>,
    pub statuses: StatusBreakdown,
}

const STATS_QUERY: &str = r#"
query($idMal:Int){
  Media(idMal:$idMal, type:ANIME){
    stats {
      scoreDistribution { score amount }
      statusDistribution { status amount }
    }
  }
}
"#;

#[tauri::command]
pub async fn anime_statistics(mal_id: i64) -> Result<AnimeStatistics, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let v = cached_gql(
        &format!("al:stats:{mal_id}"),
        STATS_QUERY,
        serde_json::json!({ "idMal": mal_id }),
        Ttl::Fixed(HOUR),
    )
    .await?;
    let d = v
        .pointer("/Media/stats")
        .filter(|s| !s.is_null())
        .ok_or_else(|| VaultError::Io("AniList statistics had no data.".into()))?;

    // AniList buckets scores 10..100 in tens; the histogram renders 1..10.
    let raw: Vec<(i64, i64)> = d
        .get("scoreDistribution")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| {
                    Some((
                        b.get("score").and_then(|x| x.as_i64())? / 10,
                        b.get("amount").and_then(|x| x.as_i64()).unwrap_or(0),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let scored: i64 = raw.iter().map(|(_, votes)| votes).sum();
    let mut scores: Vec<ScoreBucket> = raw
        .into_iter()
        .map(|(score, votes)| ScoreBucket {
            score,
            votes,
            percentage: if scored > 0 {
                (votes as f64) * 100.0 / (scored as f64)
            } else {
                0.0
            },
        })
        .collect();
    scores.sort_by_key(|b| b.score);

    let status_amount = |name: &str| -> i64 {
        d.get("statusDistribution")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|s| str_field(s, "status").as_deref() == Some(name))
                    .filter_map(|s| s.get("amount").and_then(|x| x.as_i64()))
                    .sum()
            })
            .unwrap_or(0)
    };
    let statuses = StatusBreakdown {
        // REPEATING (rewatching) has no MAL column; it folds into "watching".
        watching: status_amount("CURRENT") + status_amount("REPEATING"),
        completed: status_amount("COMPLETED"),
        on_hold: status_amount("PAUSED"),
        dropped: status_amount("DROPPED"),
        plan_to_watch: status_amount("PLANNING"),
    };
    let total = statuses.watching
        + statuses.completed
        + statuses.on_hold
        + statuses.dropped
        + statuses.plan_to_watch;
    Ok(AnimeStatistics {
        total,
        scores,
        statuses,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub mal_id: i64,
    pub title: String,
    pub image: Option<String>,
    pub votes: i64,
}

const RECOMMENDATIONS_QUERY: &str = r#"
query($idMal:Int){
  Media(idMal:$idMal, type:ANIME){
    recommendations(sort:RATING_DESC, perPage:25){
      nodes {
        rating
        mediaRecommendation { id idMal type title { romaji english } coverImage { extraLarge large } }
      }
    }
  }
}
"#;

#[tauri::command]
pub async fn anime_recommendations(mal_id: i64) -> Result<Vec<Recommendation>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let v = cached_gql(
        &format!("al:recs:{mal_id}"),
        RECOMMENDATIONS_QUERY,
        serde_json::json!({ "idMal": mal_id }),
        Ttl::Fixed(7 * DAY),
    )
    .await?;
    let out = v
        .pointer("/Media/recommendations/nodes")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let m = r.get("mediaRecommendation").filter(|m| !m.is_null())?;
                    if str_field(m, "type").as_deref() != Some("ANIME") {
                        return None;
                    }
                    let mal_id = m.get("idMal").and_then(|x| x.as_i64()).filter(|n| *n > 0)?;
                    Some(Recommendation {
                        mal_id,
                        title: str_at(m, "/title/romaji")
                            .or_else(|| str_at(m, "/title/english"))
                            .unwrap_or_default(),
                        image: str_at(m, "/coverImage/extraLarge")
                            .or_else(|| str_at(m, "/coverImage/large")),
                        votes: r.get("rating").and_then(|x| x.as_i64()).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(out)
}

// ── Character page ───────────────────────────────────────────────────────────
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterAppearance {
    pub mal_id: i64,
    pub title: String,
    pub image: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDetail {
    pub mal_id: i64,
    pub name: String,
    pub name_kanji: Option<String>,
    pub image: Option<String>,
    pub about: Option<String>,
    pub voice_actors: Vec<VoiceActor>,
    pub appearances: Vec<CharacterAppearance>,
}

const CHARACTER_QUERY: &str = r#"
query($id:Int){
  Character(id:$id){
    id
    name { full native }
    image { large }
    description
    media(sort:POPULARITY_DESC, perPage:50){
      edges {
        characterRole
        node { id idMal type title { romaji english } coverImage { extraLarge large } }
        voiceActors(sort:RELEVANCE) { id name { full } languageV2 image { large } }
      }
    }
  }
}
"#;

/// Full character page payload — bio, Japanese + English voice actors, and the
/// anime this character appears in. `id` is the AniList character id handed out
/// by `anime_characters`.
#[tauri::command]
pub async fn character_full(mal_id: i64) -> Result<CharacterDetail, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid character ID".into()));
    }
    let v = cached_gql(
        &format!("al:char:{mal_id}"),
        CHARACTER_QUERY,
        serde_json::json!({ "id": mal_id }),
        Ttl::Fixed(7 * DAY),
    )
    .await?;
    let d = v
        .get("Character")
        .filter(|c| !c.is_null())
        .ok_or_else(|| VaultError::Io("AniList character had no data.".into()))?;
    let edges = d
        .pointer("/media/edges")
        .and_then(|x| x.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    // VAs are attached per appearance; collect across them, first win per person.
    let mut voice_actors: Vec<VoiceActor> = Vec::new();
    let mut seen: HashMap<i64, ()> = HashMap::new();
    for e in edges {
        for va in e
            .get("voiceActors")
            .and_then(|x| x.as_array())
            .map(Vec::as_slice)
            .unwrap_or(&[])
        {
            let Some(language) = str_field(va, "languageV2") else {
                continue;
            };
            if language != "Japanese" && language != "English" {
                continue;
            }
            let id = va.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
            if seen.insert(id, ()).is_some() {
                continue;
            }
            voice_actors.push(VoiceActor {
                mal_id: id,
                name: str_at(va, "/name/full").unwrap_or_default(),
                language,
                image: str_at(va, "/image/large"),
            });
        }
    }
    voice_actors.sort_by_key(|v| if v.language == "Japanese" { 0 } else { 1 });

    let appearances = edges
        .iter()
        .filter(|e| str_at(e, "/node/type").as_deref() == Some("ANIME"))
        .filter_map(|e| {
            Some(CharacterAppearance {
                mal_id: i64_at(e, "/node/idMal").filter(|n| *n > 0)?,
                title: str_at(e, "/node/title/romaji")
                    .or_else(|| str_at(e, "/node/title/english"))
                    .unwrap_or_default(),
                image: str_at(e, "/node/coverImage/extraLarge")
                    .or_else(|| str_at(e, "/node/coverImage/large")),
                role: str_field(e, "characterRole").map(|r| humanize_enum(&r)),
            })
        })
        .collect();

    Ok(CharacterDetail {
        mal_id: d.get("id").and_then(|x| x.as_i64()).unwrap_or(mal_id),
        name: str_at(d, "/name/full").unwrap_or_default(),
        name_kanji: str_at(d, "/name/native"),
        image: str_at(d, "/image/large"),
        about: str_field(d, "description").map(|s| strip_html(&s)),
        voice_actors,
        appearances,
    })
}

// ── Person page ──────────────────────────────────────────────────────────────
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRole {
    pub anime_id: i64,
    pub title: String,
    pub image: Option<String>,
    pub character: Option<String>,
    pub role: Option<String>,
}

/// One anime a person worked on as staff (non-voice), with the position(s) they
/// held on it — deduped by anime, since a person can hold several positions on
/// a single title (e.g. Director + Storyboard).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffRole {
    pub anime_id: i64,
    pub title: String,
    pub image: Option<String>,
    pub positions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonDetail {
    pub mal_id: i64,
    pub name: String,
    pub image: Option<String>,
    pub about: Option<String>,
    pub roles: Vec<VoiceRole>,
    pub staff_roles: Vec<StaffRole>,
}

const PERSON_QUERY: &str = r#"
query($id:Int){
  Staff(id:$id){
    id
    name { full native }
    image { large }
    description
    characterMedia(sort:POPULARITY_DESC, perPage:50){
      edges {
        characterRole
        characters { name { full } }
        node { id idMal type title { romaji english } coverImage { extraLarge large } }
      }
    }
    staffMedia(sort:POPULARITY_DESC, perPage:50){
      edges {
        staffRole
        node { id idMal type title { romaji english } coverImage { extraLarge large } }
      }
    }
  }
}
"#;

/// Person page payload — bio + the anime they voiced (deduped by anime,
/// preferring a Main role) AND the anime they worked on as staff (deduped by
/// anime, positions collected). `id` is the AniList staff id handed out by
/// `anime_staff` and by the voice-actor links on character pages.
#[tauri::command]
pub async fn person_full(mal_id: i64) -> Result<PersonDetail, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid person ID".into()));
    }
    let v = cached_gql(
        &format!("al:person:{mal_id}"),
        PERSON_QUERY,
        serde_json::json!({ "id": mal_id }),
        Ttl::Fixed(7 * DAY),
    )
    .await?;
    let d = v
        .get("Staff")
        .filter(|s| !s.is_null())
        .ok_or_else(|| VaultError::Io("AniList person had no data.".into()))?;

    let node_title = |e: &serde_json::Value| {
        str_at(e, "/node/title/romaji")
            .or_else(|| str_at(e, "/node/title/english"))
            .unwrap_or_default()
    };
    let node_image = |e: &serde_json::Value| {
        str_at(e, "/node/coverImage/extraLarge").or_else(|| str_at(e, "/node/coverImage/large"))
    };

    let mut roles: Vec<VoiceRole> = Vec::new();
    let mut index: HashMap<i64, usize> = HashMap::new();
    if let Some(arr) = d.pointer("/characterMedia/edges").and_then(|x| x.as_array()) {
        for e in arr {
            if str_at(e, "/node/type").as_deref() != Some("ANIME") {
                continue;
            }
            let Some(anime_id) = i64_at(e, "/node/idMal").filter(|n| *n > 0) else {
                continue;
            };
            let role = str_field(e, "characterRole").map(|r| humanize_enum(&r));
            let character = str_at(e, "/characters/0/name/full");
            match index.get(&anime_id) {
                // Upgrade a previously-seen anime to its Main role if this is Main.
                Some(&i) => {
                    if role.as_deref() == Some("Main") && roles[i].role.as_deref() != Some("Main") {
                        roles[i].role = role;
                        roles[i].character = character;
                    }
                }
                None => {
                    index.insert(anime_id, roles.len());
                    roles.push(VoiceRole {
                        anime_id,
                        title: node_title(e),
                        image: node_image(e),
                        character,
                        role,
                    });
                }
            }
        }
    }

    let mut staff_roles: Vec<StaffRole> = Vec::new();
    let mut staff_index: HashMap<i64, usize> = HashMap::new();
    if let Some(arr) = d.pointer("/staffMedia/edges").and_then(|x| x.as_array()) {
        for e in arr {
            if str_at(e, "/node/type").as_deref() != Some("ANIME") {
                continue;
            }
            let Some(anime_id) = i64_at(e, "/node/idMal").filter(|n| *n > 0) else {
                continue;
            };
            let position = str_field(e, "staffRole");
            match staff_index.get(&anime_id) {
                Some(&i) => {
                    if let Some(pos) = position {
                        if !staff_roles[i].positions.contains(&pos) {
                            staff_roles[i].positions.push(pos);
                        }
                    }
                }
                None => {
                    staff_index.insert(anime_id, staff_roles.len());
                    staff_roles.push(StaffRole {
                        anime_id,
                        title: node_title(e),
                        image: node_image(e),
                        positions: position.into_iter().collect(),
                    });
                }
            }
        }
    }

    Ok(PersonDetail {
        mal_id: d.get("id").and_then(|x| x.as_i64()).unwrap_or(mal_id),
        name: str_at(d, "/name/full").unwrap_or_default(),
        image: str_at(d, "/image/large"),
        about: str_field(d, "description").map(|s| strip_html(&s)),
        roles,
        staff_roles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_labels_read_like_mal() {
        assert_eq!(humanize_enum("SIDE_STORY"), "Side story");
        assert_eq!(humanize_enum("LIGHT_NOVEL"), "Light novel");
        assert_eq!(humanize_enum("MAIN"), "Main");
        assert_eq!(humanize_enum("ALTERNATIVE_VERSION"), "Alternative version");
        assert_eq!(format_label("TV_SHORT"), "TV Short");
        assert_eq!(format_label("OVA"), "OVA");
        assert_eq!(status_label("RELEASING"), "Currently Airing");
    }

    #[test]
    fn html_is_flattened() {
        assert_eq!(
            strip_html("A <i>boy</i> &amp; his <b>robot</b>.<br><br>Second para."),
            "A boy & his robot.\n\nSecond para."
        );
    }

    #[test]
    fn fuzzy_dates_degrade_by_precision() {
        let full = serde_json::json!({"year":2013,"month":4,"day":7});
        let month = serde_json::json!({"year":2013,"month":4,"day":null});
        let year = serde_json::json!({"year":2013,"month":null,"day":null});
        assert_eq!(fuzzy_iso(Some(&full)).as_deref(), Some("2013-04-07"));
        assert_eq!(fuzzy_iso(Some(&month)).as_deref(), Some("2013-04"));
        assert_eq!(fuzzy_human(Some(&full)).as_deref(), Some("Apr 7, 2013"));
        assert_eq!(fuzzy_human(Some(&year)).as_deref(), Some("2013"));
    }

    #[test]
    fn streaming_titles_split_into_number_and_name() {
        assert_eq!(
            parse_streaming_title("Episode 3 - A Dim Light"),
            Some((3, "A Dim Light".to_string()))
        );
        assert_eq!(
            parse_streaming_title("Episode 12"),
            Some((12, String::new()))
        );
        assert_eq!(parse_streaming_title("Trailer"), None);
    }

    /// An AniList-only entry (no MAL id) must be dropped, not given a fake id —
    /// every route and vault card in the app is keyed by MAL id.
    #[test]
    fn hits_without_a_mal_id_are_skipped() {
        let v = serde_json::json!({"id": 99999, "idMal": null, "title": {"romaji": "Nope"}});
        assert!(parse_hit(&v).is_none());
    }
}

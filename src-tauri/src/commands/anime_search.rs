//! Anime Browse — Jikan (MyAnimeList) search commands.
//!
//! Read-only outbound HTTP to the Jikan v4 API for the Video Player's Anime
//! Browse tab: title search, Top, current season, title detail, and the episode
//! list. Mirrors the curl calls in `Infrastructure/Skills/Ingest/ingest-mal.md`
//! and the throttle shape of `music_search.rs`.
//!
//! A token-bucket limiter (3 req/s · 60 req/min) lets a page's calls overlap
//! without bursting; responses are cached in-memory (LRU) and on disk (per-app
//! cache dir) with status-aware TTLs (airing 1h / finished 7d) and
//! stale-while-revalidate. `anime_episodes` paginates with a 1s inter-page sleep
//! on cache misses. Covers are hot-linked from MAL on the frontend.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::commands::vault::VaultError;

const JIKAN_BASE: &str = "https://api.jikan.moe/v4";
const JIKAN_USER_AGENT: &str = "Citadel/1.0 (iskariel)";

// Token-bucket rate limit — Jikan documents 3 req/s and 60 req/min. We stay
// inside both windows while letting a page's calls OVERLAP (up to the cap)
// instead of the old strict one-at-a-time serialization.
const MAX_PER_SEC: usize = 3;
const MAX_PER_MIN: usize = 60;

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
    /// Jikan exposes the episode number as `mal_id` on the episodes endpoint.
    pub mal_id: i64,
    pub title: String,
    pub aired: Option<String>,
}

// ── Shared HTTP client (keep-alive) ──────────────────────────────────────────
// One reused client instead of `reqwest::Client::new()` per call, so the TLS
// connection to api.jikan.moe is pooled across requests.
fn http_client() -> &'static reqwest::Client {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    CELL.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(JIKAN_USER_AGENT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

// ── Token-bucket rate limiter ────────────────────────────────────────────────
// A sliding window of recent request timestamps. The lock is taken ONLY to make
// the admission decision (and dropped before any sleep), so requests admitted
// within the window proceed concurrently — the previous design held one lock
// across the whole request, forcing strict serialization (and the slowness).
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
            let jikan = dir.join("jikan");
            match std::fs::create_dir_all(&jikan) {
                Ok(()) => {
                    let _ = CACHE_DIR.set(jikan);
                }
                Err(e) => eprintln!("jikan cache dir create failed: {e} — disk cache disabled"),
            }
        }
        Err(e) => eprintln!("app_cache_dir unavailable: {e} — jikan disk cache disabled"),
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

fn cache_file(url: &str) -> Option<PathBuf> {
    let dir = CACHE_DIR.get()?;
    let mut h = DefaultHasher::new();
    url.hash(&mut h);
    Some(dir.join(format!("{:016x}.json", h.finish())))
}

fn mem_insert(url: &str, entry: CacheEntry) {
    let mut m = mem().lock().unwrap_or_else(|e| e.into_inner());
    m.seq += 1;
    let seq = m.seq;
    if !m.map.contains_key(url) && m.map.len() >= MEM_CAP {
        if let Some(victim) = m
            .map
            .iter()
            .min_by_key(|(_, (_, s))| *s)
            .map(|(k, _)| k.clone())
        {
            m.map.remove(&victim);
        }
    }
    m.map.insert(url.to_string(), (entry, seq));
}

/// Look up a cached entry (mem first, then disk → promoted into mem). Returns it
/// regardless of freshness; callers decide via `fetched_at` + `ttl_secs`.
fn cache_lookup(url: &str) -> Option<CacheEntry> {
    {
        let mut m = mem().lock().unwrap_or_else(|e| e.into_inner());
        m.seq += 1;
        let seq = m.seq;
        if let Some(slot) = m.map.get_mut(url) {
            slot.1 = seq;
            return Some(slot.0.clone());
        }
    }
    let path = cache_file(url)?;
    let bytes = std::fs::read(&path).ok()?;
    let entry: CacheEntry = serde_json::from_slice(&bytes).ok()?;
    mem_insert(url, entry.clone());
    Some(entry)
}

fn cache_store(url: &str, value: &serde_json::Value, ttl_secs: u64) {
    let entry = CacheEntry {
        url: url.to_string(),
        value: value.clone(),
        fetched_at: now_secs(),
        ttl_secs,
    };
    mem_insert(url, entry.clone());
    // Per-URL filename → distinct files, no cross-write contention.
    if let Some(path) = cache_file(url) {
        if let Ok(bytes) = serde_json::to_vec(&entry) {
            let _ = std::fs::write(&path, bytes);
        }
    }
}

// ── Fetch + cache ─────────────────────────────────────────────────────────────
#[derive(Clone, Copy)]
enum Ttl {
    Fixed(u64),
    /// airing → 1h, finished → 7d, decided from the anime-detail response.
    Detail,
}

fn resolve_ttl(ttl: Ttl, v: &serde_json::Value) -> u64 {
    match ttl {
        Ttl::Fixed(s) => s,
        Ttl::Detail => {
            let airing = v
                .get("data")
                .and_then(|d| d.get("airing"))
                .and_then(|b| b.as_bool())
                .unwrap_or(false);
            if airing {
                HOUR
            } else {
                7 * DAY
            }
        }
    }
}

/// TTL for a title's episode list — follows the title's airing status by peeking
/// the cached anime-detail entry (defaults to 1h when detail isn't cached yet).
fn anime_ttl(mal_id: i64) -> Ttl {
    let url = format!("{JIKAN_BASE}/anime/{mal_id}");
    if let Some(entry) = cache_lookup(&url) {
        let airing = entry
            .value
            .get("data")
            .and_then(|d| d.get("airing"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        Ttl::Fixed(if airing { HOUR } else { 7 * DAY })
    } else {
        Ttl::Fixed(HOUR)
    }
}

/// Raw Jikan GET through the rate limiter + shared client. Retries
/// transient failures — 429 (honoring Retry-After), 5xx gateway blips,
/// and transport timeouts/connection errors — with exponential backoff.
/// No caching — `cached_get` wraps this.
async fn jikan_fetch(url: &str) -> Result<serde_json::Value, VaultError> {
    let client = http_client();
    let mut backoff = Duration::from_millis(1200);
    let mut last_err = String::new();
    for attempt in 0..4 {
        admit().await;
        let result = client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(Duration::from_secs(15))
            .send()
            .await;
        let resp = match result {
            Ok(r) => r,
            // Transport error (timeout, reset, refused) — transient → retry.
            Err(e) => {
                last_err = format!("Jikan request failed: {e}");
                if attempt < 3 {
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(8));
                    continue;
                }
                return Err(VaultError::Io(last_err));
            }
        };
        let status = resp.status().as_u16();
        // 429 + 5xx are transient: back off and retry (429 honors Retry-After).
        if (status == 429 || (500..=599).contains(&status)) && attempt < 3 {
            let wait = if status == 429 {
                resp.headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .map(|s| Duration::from_secs(s.min(10)))
                    .unwrap_or(backoff)
            } else {
                backoff
            };
            tokio::time::sleep(wait).await;
            backoff = (backoff * 2).min(Duration::from_secs(8));
            continue;
        }
        if !resp.status().is_success() {
            return Err(VaultError::Io(format!("Jikan returned HTTP {status}")));
        }
        return resp
            .json::<serde_json::Value>()
            .await
            .map_err(|e| VaultError::Io(format!("Jikan JSON parse failed: {e}")));
    }
    Err(VaultError::Io(if last_err.is_empty() {
        "Jikan unavailable after retries.".into()
    } else {
        last_err
    }))
}

/// Cached Jikan GET. Fresh entry → instant return. Stale entry →
/// stale-while-revalidate (return stale now, refresh in the background). Miss →
/// fetch + store. A stale entry is always returned immediately even if the
/// background refresh later fails (offline fallback); only a true miss with a
/// failed fetch propagates the error.
async fn cached_get(url: &str, ttl: Ttl) -> Result<serde_json::Value, VaultError> {
    if let Some(entry) = cache_lookup(url) {
        let fresh = now_secs().saturating_sub(entry.fetched_at) < entry.ttl_secs;
        if !fresh {
            let url_owned = url.to_string();
            tauri::async_runtime::spawn(async move {
                if let Ok(v) = jikan_fetch(&url_owned).await {
                    cache_store(&url_owned, &v, resolve_ttl(ttl, &v));
                }
            });
        }
        return Ok(entry.value);
    }
    let v = jikan_fetch(url).await?;
    cache_store(url, &v, resolve_ttl(ttl, &v));
    Ok(v)
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// MAL cover URL from `images.jpg.image_url`.
fn image_url(v: &serde_json::Value) -> Option<String> {
    v.get("images")
        .and_then(|i| i.get("jpg"))
        .and_then(|j| j.get("image_url"))
        .and_then(|u| u.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Names from an array of `{ name }` objects (genres, studios).
fn names(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| e.get("name").and_then(|n| n.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_hit(v: &serde_json::Value) -> Option<AnimeHit> {
    let mal_id = v.get("mal_id")?.as_i64()?;
    Some(AnimeHit {
        mal_id,
        title: str_field(v, "title").unwrap_or_default(),
        title_english: str_field(v, "title_english"),
        year: v.get("year").and_then(|x| x.as_i64()),
        r#type: str_field(v, "type"),
        episodes: v.get("episodes").and_then(|x| x.as_i64()),
        score: v.get("score").and_then(|x| x.as_f64()),
        airing: v.get("airing").and_then(|x| x.as_bool()).unwrap_or(false),
        image: image_url(v),
        synopsis: str_field(v, "synopsis"),
    })
}

fn parse_hits(v: &serde_json::Value) -> Vec<AnimeHit> {
    v.get("data")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(parse_hit).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn anime_search(query: String) -> Result<Vec<AnimeHit>, VaultError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!(
        "{JIKAN_BASE}/anime?q={}&sfw=true&limit=25&order_by=members&sort=desc",
        urlencoding::encode(q)
    );
    Ok(parse_hits(&cached_get(&url, Ttl::Fixed(HOUR)).await?))
}

#[tauri::command]
pub async fn anime_top(page: Option<u32>) -> Result<Vec<AnimeHit>, VaultError> {
    let page = page.unwrap_or(1).max(1);
    let url = format!("{JIKAN_BASE}/top/anime?page={page}&limit=25&sfw=true");
    Ok(parse_hits(&cached_get(&url, Ttl::Fixed(HOUR)).await?))
}

#[tauri::command]
pub async fn anime_season_now(page: Option<u32>) -> Result<Vec<AnimeHit>, VaultError> {
    let page = page.unwrap_or(1).max(1);
    let url = format!("{JIKAN_BASE}/seasons/now?page={page}&limit=25&sfw=true");
    Ok(parse_hits(&cached_get(&url, Ttl::Fixed(HOUR)).await?))
}

/// Resolve a genre/theme/demographic NAME → its MAL id via the cached
/// `/genres/anime` list (small + stable, 7-day TTL). Case-insensitive.
async fn resolve_genre_id(name: &str) -> Result<Option<i64>, VaultError> {
    let url = format!("{JIKAN_BASE}/genres/anime");
    let v = cached_get(&url, Ttl::Fixed(7 * DAY)).await?;
    let target = name.to_lowercase();
    Ok(v.get("data").and_then(|d| d.as_array()).and_then(|arr| {
        arr.iter()
            .find(|g| {
                g.get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| n.to_lowercase() == target)
                    .unwrap_or(false)
            })
            .and_then(|g| g.get("mal_id"))
            .and_then(|x| x.as_i64())
    }))
}

/// Native MAL discovery for a clickable taxon. `kind` is one of
/// `genre|theme|demographic` (resolved to a genre id, then `?genres=<id>`) or
/// `studio` (resolved via `/producers?q=`, then `?producers=<id>`). Results are
/// the same `AnimeHit` shape the Browse grids already render, ordered by members.
/// An unresolvable name returns an empty list (the grid shows its empty state).
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
    let filter = match kind.as_str() {
        "studio" => {
            let url = format!(
                "{JIKAN_BASE}/producers?q={}&order_by=count&sort=desc&limit=1",
                urlencoding::encode(name)
            );
            let v = cached_get(&url, Ttl::Fixed(7 * DAY)).await?;
            match v
                .get("data")
                .and_then(|d| d.as_array())
                .and_then(|a| a.first())
                .and_then(|p| p.get("mal_id"))
                .and_then(|x| x.as_i64())
            {
                Some(id) => format!("producers={id}"),
                None => return Ok(Vec::new()),
            }
        }
        "genre" | "theme" | "demographic" => match resolve_genre_id(name).await? {
            Some(id) => format!("genres={id}"),
            None => return Ok(Vec::new()),
        },
        "type" => format!("type={}", urlencoding::encode(&name.to_lowercase())),
        "season" => {
            // "Spring 2020" → /seasons/2020/spring
            let parts: Vec<&str> = name.split_whitespace().collect();
            if parts.len() != 2 {
                return Ok(Vec::new());
            }
            let url = format!(
                "{JIKAN_BASE}/seasons/{}/{}?page={page}&limit=25&sfw=true",
                parts[1],
                parts[0].to_lowercase()
            );
            return Ok(parse_hits(&cached_get(&url, Ttl::Fixed(HOUR)).await?));
        }
        other => return Err(VaultError::Invalid(format!("Unknown taxon kind: {other}"))),
    };
    let url =
        format!("{JIKAN_BASE}/anime?{filter}&order_by=members&sort=desc&sfw=true&page={page}&limit=25");
    Ok(parse_hits(&cached_get(&url, Ttl::Fixed(HOUR)).await?))
}

#[tauri::command]
pub async fn anime_detail(mal_id: i64) -> Result<AnimeDetail, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let url = format!("{JIKAN_BASE}/anime/{mal_id}");
    let v = cached_get(&url, Ttl::Detail).await?;
    let d = v
        .get("data")
        .ok_or_else(|| VaultError::Io("Jikan detail had no data.".into()))?;
    let aired = d.get("aired");
    let aired_from = aired
        .and_then(|a| a.get("from"))
        .and_then(|x| x.as_str())
        .and_then(|s| s.get(0..10))
        .map(str::to_string);
    let aired_to = aired
        .and_then(|a| a.get("to"))
        .and_then(|x| x.as_str())
        .and_then(|s| s.get(0..10))
        .map(str::to_string);
    // Trailer — populated only when at least one sub-field is present, so JS gets
    // null for trailerless titles and AnimeTrailer can render nothing.
    let trailer = d.get("trailer").and_then(|t| {
        let mut youtube_id = str_field(t, "youtube_id");
        let mut url = str_field(t, "url");
        let mut image = t
            .get("images")
            .and_then(|i| i.get("maximum_image_url").or_else(|| i.get("image_url")))
            .and_then(|u| u.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // Jikan increasingly returns only embed_url
        // (https://www.youtube-nocookie.com/embed/<id>?...) with youtube_id, url
        // and every images.* field null. Recover the id from the embed path, then
        // synthesise the watch URL (a public youtube.com URL passes the in-app
        // browser nav allow-list) and a thumbnail (hqdefault always exists and
        // cover-crops to a clean 16:9 in the trailer card).
        if youtube_id.is_none() {
            youtube_id = str_field(t, "embed_url").and_then(|e| {
                e.rsplit('/')
                    .next()
                    .and_then(|seg| seg.split('?').next())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            });
        }
        if let Some(id) = youtube_id.as_deref() {
            if url.is_none() {
                url = Some(format!("https://www.youtube.com/watch?v={id}"));
            }
            if image.is_none() {
                image = Some(format!("https://img.youtube.com/vi/{id}/hqdefault.jpg"));
            }
        }
        if youtube_id.is_none() && url.is_none() && image.is_none() {
            None
        } else {
            Some(Trailer {
                youtube_id,
                url,
                image,
            })
        }
    });
    Ok(AnimeDetail {
        mal_id: d.get("mal_id").and_then(|x| x.as_i64()).unwrap_or(mal_id),
        title: str_field(d, "title").unwrap_or_default(),
        title_english: str_field(d, "title_english"),
        title_japanese: str_field(d, "title_japanese"),
        synonyms: d
            .get("title_synonyms")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().filter(|s| !s.is_empty()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        year: d.get("year").and_then(|x| x.as_i64()).or_else(|| {
            aired
                .and_then(|a| a.get("prop"))
                .and_then(|p| p.get("from"))
                .and_then(|f| f.get("year"))
                .and_then(|y| y.as_i64())
        }),
        season: str_field(d, "season"),
        r#type: str_field(d, "type"),
        episodes: d.get("episodes").and_then(|x| x.as_i64()),
        score: d.get("score").and_then(|x| x.as_f64()),
        scored_by: d.get("scored_by").and_then(|x| x.as_i64()),
        rank: d.get("rank").and_then(|x| x.as_i64()),
        popularity: d.get("popularity").and_then(|x| x.as_i64()),
        airing: d.get("airing").and_then(|x| x.as_bool()).unwrap_or(false),
        status: str_field(d, "status"),
        members: d.get("members").and_then(|x| x.as_i64()),
        duration: str_field(d, "duration"),
        source: str_field(d, "source"),
        rating: str_field(d, "rating"),
        broadcast: d.get("broadcast").and_then(|b| str_field(b, "string")),
        synopsis: str_field(d, "synopsis"),
        background: str_field(d, "background"),
        genres: names(d, "genres"),
        studios: names(d, "studios"),
        themes: names(d, "themes"),
        demographics: names(d, "demographics"),
        producers: names(d, "producers"),
        aired: aired.and_then(|a| str_field(a, "string")),
        aired_from,
        aired_to,
        openings: d
            .get("theme")
            .and_then(|t| t.get("openings"))
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().filter(|s| !s.is_empty()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        endings: d
            .get("theme")
            .and_then(|t| t.get("endings"))
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().filter(|s| !s.is_empty()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        trailer,
        image: image_url(d),
        source_url: str_field(d, "url"),
    })
}

#[tauri::command]
pub async fn anime_episodes(mal_id: i64) -> Result<Vec<EpisodeRow>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let mut out: Vec<EpisodeRow> = Vec::new();
    let mut page = 1u32;
    let ttl = anime_ttl(mal_id);
    loop {
        let url = format!("{JIKAN_BASE}/anime/{mal_id}/episodes?page={page}");
        let v = cached_get(&url, ttl).await?;
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
            .get("pagination")
            .and_then(|p| p.get("has_next_page"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        // Cap at 25 pages (~2500 eps) as a runaway guard for long-runners.
        if !has_next || page >= 25 {
            break;
        }
        page += 1;
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    Ok(out)
}

// ── Max-detail credits ──────────────────────────────────────────────────────
// Live Jikan fetches powering the per-anime detail page's Characters, Staff,
// and Related sections — for owned AND not-owned titles alike (keyed by MAL id,
// which every entry has). Read-only; portraits hot-linked from MAL, nothing
// persisted. Each rides the same rate limiter + cache as the rest.

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

/// Japanese + English VAs from a `{ person, language }` list, Japanese first.
/// Shared by the anime `voice_actors` array and the character `voices` array.
fn parse_voice_actors(list: &[serde_json::Value]) -> Vec<VoiceActor> {
    let mut out: Vec<VoiceActor> = list
        .iter()
        .filter_map(|va| {
            let language = str_field(va, "language")?;
            if language != "Japanese" && language != "English" {
                return None;
            }
            let person = va.get("person")?;
            Some(VoiceActor {
                mal_id: person.get("mal_id").and_then(|x| x.as_i64()).unwrap_or(0),
                name: str_field(person, "name").unwrap_or_default(),
                language,
                image: image_url(person),
            })
        })
        .collect();
    out.sort_by_key(|v| if v.language == "Japanese" { 0 } else { 1 });
    out
}

fn parse_character(entry: &serde_json::Value) -> Option<AnimeCharacter> {
    let character = entry.get("character")?;
    Some(AnimeCharacter {
        mal_id: character.get("mal_id").and_then(|x| x.as_i64()).unwrap_or(0),
        name: str_field(character, "name").unwrap_or_default(),
        image: image_url(character),
        role: str_field(entry, "role"),
        voice_actors: parse_voice_actors(
            entry.get("voice_actors").and_then(|x| x.as_array()).map(Vec::as_slice).unwrap_or(&[]),
        ),
    })
}

#[tauri::command]
pub async fn anime_characters(mal_id: i64) -> Result<Vec<AnimeCharacter>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let url = format!("{JIKAN_BASE}/anime/{mal_id}/characters");
    let v = cached_get(&url, Ttl::Fixed(7 * DAY)).await?;
    let mut out: Vec<AnimeCharacter> = v
        .get("data")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(parse_character).collect())
        .unwrap_or_default();
    // Main cast first; preserve Jikan's favorites order within each group.
    out.sort_by_key(|c| if c.role.as_deref() == Some("Main") { 0 } else { 1 });
    Ok(out)
}

fn parse_staff(entry: &serde_json::Value) -> Option<StaffMember> {
    let person = entry.get("person")?;
    let positions = entry
        .get("positions")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|p| p.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Some(StaffMember {
        mal_id: person.get("mal_id").and_then(|x| x.as_i64()).unwrap_or(0),
        name: str_field(person, "name").unwrap_or_default(),
        image: image_url(person),
        positions,
    })
}

#[tauri::command]
pub async fn anime_staff(mal_id: i64) -> Result<Vec<StaffMember>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let url = format!("{JIKAN_BASE}/anime/{mal_id}/staff");
    let v = cached_get(&url, Ttl::Fixed(7 * DAY)).await?;
    let out = v
        .get("data")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(parse_staff).collect())
        .unwrap_or_default();
    Ok(out)
}

fn parse_relation(entry: &serde_json::Value) -> Option<AnimeRelation> {
    let relation = str_field(entry, "relation")?;
    let entries: Vec<RelationEntry> = entry
        .get("entry")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| {
                    // Anime relations only — no in-app detail route for manga.
                    if str_field(e, "type").as_deref() != Some("anime") {
                        return None;
                    }
                    let mal_id = e.get("mal_id").and_then(|x| x.as_i64())?;
                    Some(RelationEntry {
                        mal_id,
                        name: str_field(e, "name").unwrap_or_default(),
                        r#type: str_field(e, "type"),
                        url: str_field(e, "url"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if entries.is_empty() {
        return None;
    }
    Some(AnimeRelation { relation, entries })
}

#[tauri::command]
pub async fn anime_relations(mal_id: i64) -> Result<Vec<AnimeRelation>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let url = format!("{JIKAN_BASE}/anime/{mal_id}/relations");
    let v = cached_get(&url, Ttl::Fixed(7 * DAY)).await?;
    let out = v
        .get("data")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(parse_relation).collect())
        .unwrap_or_default();
    Ok(out)
}

// ── Statistics + recommendations ─────────────────────────────────────────────
// Aggregate community data for the detail page's rail histogram/status bars and
// the bottom recommendations row. Score/status counts shift slowly even while
// airing, so a 1h TTL is plenty; recommendations are near-static (7d).

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

#[tauri::command]
pub async fn anime_statistics(mal_id: i64) -> Result<AnimeStatistics, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let url = format!("{JIKAN_BASE}/anime/{mal_id}/statistics");
    let v = cached_get(&url, Ttl::Fixed(HOUR)).await?;
    let d = v
        .get("data")
        .ok_or_else(|| VaultError::Io("Jikan statistics had no data.".into()))?;
    let i64_field = |key: &str| d.get(key).and_then(|x| x.as_i64()).unwrap_or(0);
    // 10 buckets, score 1..=10, in ascending score order. Jikan returns them
    // descending; reverse so the histogram reads 1→10 top-down.
    let mut scores: Vec<ScoreBucket> = d
        .get("scores")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    Some(ScoreBucket {
                        score: s.get("score").and_then(|x| x.as_i64())?,
                        votes: s.get("votes").and_then(|x| x.as_i64()).unwrap_or(0),
                        percentage: s.get("percentage").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    scores.sort_by_key(|b| b.score);
    Ok(AnimeStatistics {
        total: i64_field("total"),
        scores,
        statuses: StatusBreakdown {
            watching: i64_field("watching"),
            completed: i64_field("completed"),
            on_hold: i64_field("on_hold"),
            dropped: i64_field("dropped"),
            plan_to_watch: i64_field("plan_to_watch"),
        },
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

#[tauri::command]
pub async fn anime_recommendations(mal_id: i64) -> Result<Vec<Recommendation>, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid MAL ID".into()));
    }
    let url = format!("{JIKAN_BASE}/anime/{mal_id}/recommendations");
    let v = cached_get(&url, Ttl::Fixed(7 * DAY)).await?;
    let out = v
        .get("data")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let entry = r.get("entry")?;
                    let mal_id = entry.get("mal_id").and_then(|x| x.as_i64())?;
                    Some(Recommendation {
                        mal_id,
                        title: str_field(entry, "title").unwrap_or_default(),
                        image: image_url(entry),
                        votes: r.get("votes").and_then(|x| x.as_i64()).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(out)
}

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

fn parse_appearance(entry: &serde_json::Value) -> Option<CharacterAppearance> {
    let anime = entry.get("anime")?;
    let mal_id = anime.get("mal_id").and_then(|x| x.as_i64())?;
    Some(CharacterAppearance {
        mal_id,
        title: str_field(anime, "title").unwrap_or_default(),
        image: image_url(anime),
        role: str_field(entry, "role"),
    })
}

/// Full character page payload — bio, Japanese + English voice actors, and the
/// anime this character appears in. Powers the in-app character detail route.
#[tauri::command]
pub async fn character_full(mal_id: i64) -> Result<CharacterDetail, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid character ID".into()));
    }
    let url = format!("{JIKAN_BASE}/characters/{mal_id}/full");
    let v = cached_get(&url, Ttl::Fixed(7 * DAY)).await?;
    let d = v
        .get("data")
        .ok_or_else(|| VaultError::Io("Jikan character had no data.".into()))?;
    let appearances = d
        .get("anime")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(parse_appearance).collect())
        .unwrap_or_default();
    Ok(CharacterDetail {
        mal_id: d.get("mal_id").and_then(|x| x.as_i64()).unwrap_or(mal_id),
        name: str_field(d, "name").unwrap_or_default(),
        name_kanji: str_field(d, "name_kanji"),
        image: image_url(d),
        about: str_field(d, "about"),
        voice_actors: parse_voice_actors(
            d.get("voices").and_then(|x| x.as_array()).map(Vec::as_slice).unwrap_or(&[]),
        ),
        appearances,
    })
}

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

/// Person page payload — bio + the anime they voiced (deduped by anime,
/// preferring a Main role) AND the anime they worked on as staff (deduped by
/// anime, positions collected). Powers the in-app person route, reached from
/// both voice-actor links (character pages) and staff cards (anime pages).
/// Voiced-In popularity/year sorts are enriched lazily client-side.
#[tauri::command]
pub async fn person_full(mal_id: i64) -> Result<PersonDetail, VaultError> {
    if mal_id <= 0 {
        return Err(VaultError::Invalid("Invalid person ID".into()));
    }
    let url = format!("{JIKAN_BASE}/people/{mal_id}/full");
    let v = cached_get(&url, Ttl::Fixed(7 * DAY)).await?;
    let d = v
        .get("data")
        .ok_or_else(|| VaultError::Io("Jikan person had no data.".into()))?;
    let mut roles: Vec<VoiceRole> = Vec::new();
    let mut index: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
    if let Some(arr) = d.get("voices").and_then(|x| x.as_array()) {
        for entry in arr {
            let Some(anime) = entry.get("anime") else { continue; };
            let Some(anime_id) = anime.get("mal_id").and_then(|x| x.as_i64()) else { continue; };
            let role = str_field(entry, "role");
            let character = entry.get("character").and_then(|c| str_field(c, "name"));
            if let Some(&i) = index.get(&anime_id) {
                // Upgrade a previously-seen anime to its Main role if this is Main.
                if role.as_deref() == Some("Main") && roles[i].role.as_deref() != Some("Main") {
                    roles[i].role = role;
                    roles[i].character = character;
                }
            } else {
                index.insert(anime_id, roles.len());
                roles.push(VoiceRole {
                    anime_id,
                    title: str_field(anime, "title").unwrap_or_default(),
                    image: image_url(anime),
                    character,
                    role,
                });
            }
        }
    }
    // Staff (non-voice) credits — the `anime` array of /people/{id}/full pairs
    // one position with one anime per entry. Dedup by anime, collecting unique
    // positions, so a person with several roles on a title shows one card.
    let mut staff_roles: Vec<StaffRole> = Vec::new();
    let mut staff_index: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
    if let Some(arr) = d.get("anime").and_then(|x| x.as_array()) {
        for entry in arr {
            let Some(anime) = entry.get("anime") else { continue; };
            let Some(anime_id) = anime.get("mal_id").and_then(|x| x.as_i64()) else { continue; };
            let position = str_field(entry, "position");
            if let Some(&i) = staff_index.get(&anime_id) {
                if let Some(pos) = position {
                    if !staff_roles[i].positions.contains(&pos) {
                        staff_roles[i].positions.push(pos);
                    }
                }
            } else {
                staff_index.insert(anime_id, staff_roles.len());
                staff_roles.push(StaffRole {
                    anime_id,
                    title: str_field(anime, "title").unwrap_or_default(),
                    image: image_url(anime),
                    positions: position.into_iter().collect(),
                });
            }
        }
    }
    Ok(PersonDetail {
        mal_id: d.get("mal_id").and_then(|x| x.as_i64()).unwrap_or(mal_id),
        name: str_field(d, "name").unwrap_or_default(),
        image: image_url(d),
        about: str_field(d, "about"),
        roles,
        staff_roles,
    })
}

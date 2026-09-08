//! Cinemeta — keyless film + TV metadata for the Library Movies / TV Shows rooms.
//!
//! One supplier serves both rooms: every endpoint takes a `kind` of `"movie"` or
//! `"series"`, so the Movies room is this same client with a different string.
//! See `Knowledge/Mortar & Pestle/Plans/Library Migration/TV Shows Tab.md`.
//!
//! **Why Cinemeta and not TMDb**: Cinemeta is keyless and **IMDb-keyed**, which
//! is the same id `torrentio_search` downloads by, so the browse id IS the
//! download id.
//!
//! Two 2026-09-07 reasons recorded here were WRONG and are struck (2026-09-08):
//! "an account only the user can create" is now the deliberate design, not an
//! objection — the user supplies their own TMDb key, so no key ships with the
//! app (`Knowledge/Mortar & Pestle/Plans/Bring Your Own Source.md`). And TMDb
//! needs no `/external_ids` round-trip: Cinemeta's own payload already carries
//! `moviedb_id` (measured `6435` for Practical Magic, 2026-09-08), so the
//! translation is free where it is needed at all.
//!
//! Cinemeta's own terms remain UNRESOLVED — its manifest carries no licence and
//! it repackages IMDb, TMDb, TheTVDB and Fanart.tv rather than owning the data.
//! Logged, not fixed. It carries the full episode list (title, air
//! date, thumbnail, per-episode rating), poster/background/logo, cast and genres.
//!
//! Endpoints (all GET, all JSON, no auth):
//!   `/catalog/{kind}/{catalog}/search={q}.json`   → thin hits (name, poster, year)
//!   `/catalog/{kind}/{catalog}/genre={g}&skip=N.json`
//!   `/meta/{kind}/{imdb_id}.json`                 → the full record + `videos`
//!
//! Catalog ids are `top`, `year` and `imdbRating` for both kinds.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::commands::vault::VaultError;

const BASE: &str = "https://v3-cinemeta.strem.io";
const USER_AGENT: &str = "Citadel/1.0 (mortar-pestle)";
const TIMEOUT: Duration = Duration::from_secs(20);

/// Cinemeta answers with `cacheMaxAge: 86400` and is CDN-fronted, so a running
/// show's record is a day stale at worst either way.
///
/// ponytail: in-memory only, and no rate limiter — Cinemeta documents neither a
/// quota nor a burst limit, and a browse session is tens of requests, not
/// thousands. If a cold app launch ever feels slow, lift `anime_search.rs`'s
/// on-disk cache + token bucket wholesale; the call seam here is one function.
const TTL_RUNNING: Duration = Duration::from_secs(60 * 60); // 1h
const TTL_ENDED: Duration = Duration::from_secs(7 * 24 * 60 * 60); // 7d
const TTL_CATALOG: Duration = Duration::from_secs(60 * 60);

// ── Wire types ───────────────────────────────────────────────────────────────

/// A catalog / search row. Cinemeta's catalog payload is deliberately thin — no
/// rating, no genres — so a grid card shows poster + name + year and the detail
/// fetch fills the rest.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CineHit {
    pub imdb_id: String,
    pub kind: String,
    pub name: String,
    pub year: Option<String>,
    pub poster: Option<String>,
    pub background: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CineEpisode {
    pub season: i64,
    pub episode: i64,
    pub name: Option<String>,
    pub released: Option<String>,
    pub thumbnail: Option<String>,
    pub rating: Option<String>,
    pub overview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CineDetail {
    pub imdb_id: String,
    pub kind: String,
    pub name: String,
    pub year: Option<String>,
    pub released: Option<String>,
    /// `"Ended"` / `"Continuing"` for series; absent for films.
    pub status: Option<String>,
    pub runtime: Option<String>,
    pub description: Option<String>,
    pub imdb_rating: Option<String>,
    pub genres: Vec<String>,
    pub cast: Vec<String>,
    pub director: Vec<String>,
    pub writer: Vec<String>,
    pub country: Option<String>,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub logo: Option<String>,
    pub trailer_youtube_id: Option<String>,
    /// Episodes, season-then-episode ordered. Empty for films.
    pub episodes: Vec<CineEpisode>,
    /// Season numbers present in `episodes`, ascending. Season 0 is specials.
    pub seasons: Vec<i64>,
    /// True when this looks like anime — Japanese origin plus an Animation
    /// genre. The TV room refuses these and points at the Anime room instead
    /// (one entity, one page), so the check lives here, next to the fields it
    /// reads, rather than being re-derived by each caller.
    pub is_anime: bool,
}

// ── HTTP + cache ─────────────────────────────────────────────────────────────

fn http_client() -> &'static reqwest::Client {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    CELL.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

struct Cached {
    value: Value,
    expires: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CELL: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(url: &str) -> Option<Value> {
    let map = cache().lock().ok()?;
    let hit = map.get(url)?;
    (hit.expires > Instant::now()).then(|| hit.value.clone())
}

fn cache_put(url: &str, value: &Value, ttl: Duration) {
    if let Ok(mut map) = cache().lock() {
        // Drop anything already expired before growing — a browse session's keys
        // are bounded by what the user actually looked at, so this is the whole
        // eviction policy.
        let now = Instant::now();
        map.retain(|_, v| v.expires > now);
        map.insert(
            url.to_string(),
            Cached {
                value: value.clone(),
                expires: now + ttl,
            },
        );
    }
}

/// One GET, JSON-decoded, memoised for `ttl`.
async fn fetch(url: &str, ttl: Duration) -> Result<Value, VaultError> {
    if let Some(v) = cache_get(url) {
        return Ok(v);
    }
    let resp = http_client()
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| VaultError::Io(format!("cinemeta request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(VaultError::Io(format!(
            "cinemeta returned {} for {url}",
            resp.status()
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| VaultError::Io(format!("cinemeta sent no JSON: {e}")))?;
    cache_put(url, &v, ttl);
    Ok(v)
}

// ── Field helpers ────────────────────────────────────────────────────────────

/// `movie` / `series` only — this lands in a URL path, so it comes from an
/// allow-list rather than the caller's string.
fn kind_of(kind: &str) -> Result<&'static str, VaultError> {
    match kind {
        "movie" => Ok("movie"),
        "series" => Ok("series"),
        other => Err(VaultError::Invalid(format!("unknown cinemeta kind: {other}"))),
    }
}

/// `top` / `year` / `imdbRating` — the three catalogs Cinemeta's manifest lists
/// for both kinds. Same allow-list reasoning as `kind_of`.
fn catalog_of(catalog: &str) -> Result<&'static str, VaultError> {
    match catalog {
        "top" => Ok("top"),
        "year" => Ok("year"),
        "imdbRating" => Ok("imdbRating"),
        other => Err(VaultError::Invalid(format!(
            "unknown cinemeta catalog: {other}"
        ))),
    }
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

fn i(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn hit_from(v: &Value) -> Option<CineHit> {
    // `id` and `imdb_id` are the same tt-string on every row observed, but the
    // catalog rows carry `id` and the meta payload carries both — prefer the
    // explicit one and fall back rather than assuming.
    let imdb_id = s(v, "imdb_id").or_else(|| s(v, "id"))?;
    Some(CineHit {
        imdb_id,
        kind: s(v, "type").unwrap_or_else(|| "series".into()),
        name: s(v, "name")?,
        year: s(v, "releaseInfo").or_else(|| s(v, "year")),
        poster: s(v, "poster"),
        background: s(v, "background"),
    })
}

/// Japanese origin plus an Animation genre. Cinemeta's `country` is a
/// comma-joined string ("United Kingdom, United States"), not a list.
fn looks_like_anime(country: Option<&str>, genres: &[String]) -> bool {
    let japanese = country
        .map(|c| c.to_ascii_lowercase().contains("japan"))
        .unwrap_or(false);
    let animated = genres.iter().any(|g| g.eq_ignore_ascii_case("Animation"));
    japanese && animated
}

fn episodes_from(meta: &Value) -> Vec<CineEpisode> {
    let mut out: Vec<CineEpisode> = meta
        .get("videos")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    Some(CineEpisode {
                        season: i(e, "season")?,
                        episode: i(e, "episode").or_else(|| i(e, "number"))?,
                        name: s(e, "name"),
                        released: s(e, "released").or_else(|| s(e, "firstAired")),
                        thumbnail: s(e, "thumbnail"),
                        rating: s(e, "rating"),
                        overview: s(e, "overview").or_else(|| s(e, "description")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|e| (e.season, e.episode));
    out
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Title search. `kind` is `"movie"` or `"series"`.
#[tauri::command]
pub async fn cinemeta_search(kind: String, query: String) -> Result<Vec<CineHit>, VaultError> {
    let k = kind_of(&kind)?;
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!(
        "{BASE}/catalog/{k}/top/search={}.json",
        urlencoding::encode(q)
    );
    let v = fetch(&url, TTL_CATALOG).await?;
    Ok(v.get("metas")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(hit_from).collect())
        .unwrap_or_default())
}

/// A browse row. `catalog` is `"top"`, `"year"` or `"imdbRating"`; `genre`
/// narrows it; `skip` pages (Cinemeta serves 100 per page).
#[tauri::command]
pub async fn cinemeta_catalog(
    kind: String,
    catalog: String,
    genre: Option<String>,
    skip: Option<i64>,
) -> Result<Vec<CineHit>, VaultError> {
    let k = kind_of(&kind)?;
    let c = catalog_of(&catalog)?;
    // Cinemeta's extras are a single `&`-joined path segment, not a query string.
    let mut extras: Vec<String> = Vec::new();
    if let Some(g) = genre.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
        extras.push(format!("genre={}", urlencoding::encode(g)));
    }
    if let Some(n) = skip.filter(|n| *n > 0) {
        extras.push(format!("skip={n}"));
    }
    let url = if extras.is_empty() {
        format!("{BASE}/catalog/{k}/{c}.json")
    } else {
        format!("{BASE}/catalog/{k}/{c}/{}.json", extras.join("&"))
    };
    let v = fetch(&url, TTL_CATALOG).await?;
    Ok(v.get("metas")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(hit_from).collect())
        .unwrap_or_default())
}

/// The full record for one title, episodes included.
#[tauri::command]
pub async fn cinemeta_detail(kind: String, imdb_id: String) -> Result<CineDetail, VaultError> {
    let k = kind_of(&kind)?;
    // The id lands in a URL path. Cinemeta ids are always `tt` + digits, so
    // anything else is refused rather than escaped.
    let id = imdb_id.trim();
    if !(id.starts_with("tt") && id.len() > 2 && id[2..].chars().all(|c| c.is_ascii_digit())) {
        return Err(VaultError::Invalid(format!("not an IMDb id: {id}")));
    }
    let url = format!("{BASE}/meta/{k}/{id}.json");
    // A still-running show gains episodes; an ended one never changes again.
    let v = fetch(&url, TTL_RUNNING).await?;
    let meta = v
        .get("meta")
        .ok_or_else(|| VaultError::NotFound(format!("cinemeta has no {k} {id}")))?;

    let status = s(meta, "status");
    if status.as_deref() == Some("Ended") {
        cache_put(&url, &v, TTL_ENDED);
    }

    let genres = strings(meta, "genres");
    let country = s(meta, "country");
    let episodes = episodes_from(meta);
    let mut seasons: Vec<i64> = episodes.iter().map(|e| e.season).collect();
    seasons.dedup();

    Ok(CineDetail {
        imdb_id: s(meta, "imdb_id").unwrap_or_else(|| id.to_string()),
        kind: s(meta, "type").unwrap_or_else(|| k.to_string()),
        name: s(meta, "name").unwrap_or_else(|| id.to_string()),
        year: s(meta, "year").or_else(|| s(meta, "releaseInfo")),
        released: s(meta, "released"),
        status,
        runtime: s(meta, "runtime"),
        description: s(meta, "description"),
        imdb_rating: s(meta, "imdbRating"),
        is_anime: looks_like_anime(country.as_deref(), &genres),
        cast: strings(meta, "cast"),
        director: strings(meta, "director"),
        writer: strings(meta, "writer"),
        genres,
        country,
        poster: s(meta, "poster"),
        background: s(meta, "background"),
        logo: s(meta, "logo"),
        trailer_youtube_id: meta
            .get("trailers")
            .and_then(|x| x.as_array())
            .and_then(|a| a.first())
            .and_then(|t| s(t, "source")),
        episodes,
        seasons,
    })
}

/// One dated episode, flattened out of the calendar feed's show records.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CineUpcoming {
    pub imdb_id: String,
    pub show: String,
    pub poster: Option<String>,
    pub season: i64,
    pub episode: i64,
    pub name: Option<String>,
    pub released: Option<String>,
}

/// Upcoming episodes for shows the library already holds. Cinemeta has no
/// account, so the caller passes the ids it cares about and the feed answers
/// with one record per show carrying a short `videos` list. Specials (season 0)
/// and anything already aired are dropped — the row is a "what is coming" row.
#[tauri::command]
pub async fn cinemeta_calendar(imdb_ids: Vec<String>) -> Result<Vec<CineUpcoming>, VaultError> {
    // The ids land in a URL path, so they get `cinemeta_detail`'s shape check —
    // plus a cap, because a 500-show library would build a URL no server accepts.
    let ids: Vec<String> = imdb_ids
        .iter()
        .map(|x| x.trim().to_string())
        .filter(|x| x.starts_with("tt") && x.len() > 2 && x[2..].chars().all(|c| c.is_ascii_digit()))
        .take(60)
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!(
        "{BASE}/catalog/series/calendar-videos/calendarVideosIds={}.json",
        ids.join(",")
    );
    let v = fetch(&url, TTL_CATALOG).await?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut out = Vec::new();
    for show in v
        .get("metasDetailed")
        .and_then(|x| x.as_array())
        .into_iter()
        .flatten()
    {
        let name = s(show, "name").unwrap_or_default();
        let poster = s(show, "poster");
        let imdb_id = s(show, "imdb_id").unwrap_or_default();
        for e in show
            .get("videos")
            .and_then(|x| x.as_array())
            .into_iter()
            .flatten()
        {
            let released = s(e, "released").or_else(|| s(e, "firstAired"));
            let upcoming = released
                .as_deref()
                .map(|r| r.len() >= 10 && r.is_char_boundary(10) && &r[..10] >= today.as_str())
                .unwrap_or(false);
            let season = i(e, "season").unwrap_or(0);
            if !upcoming || season == 0 {
                continue;
            }
            out.push(CineUpcoming {
                imdb_id: imdb_id.clone(),
                show: name.clone(),
                poster: poster.clone(),
                season,
                episode: i(e, "episode").or_else(|| i(e, "number")).unwrap_or(0),
                name: s(e, "name"),
                released,
            });
        }
    }
    out.sort_by(|a, b| a.released.cmp(&b.released));
    out.truncate(30);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_and_catalog_are_allow_listed() {
        assert!(kind_of("movie").is_ok());
        assert!(kind_of("series").is_ok());
        // Both land in a URL path, so anything else is refused, not escaped.
        assert!(kind_of("../../meta").is_err());
        assert!(kind_of("").is_err());
        assert!(catalog_of("imdbRating").is_ok());
        assert!(catalog_of("../top").is_err());
    }

    #[test]
    fn anime_needs_both_japan_and_animation() {
        let anim = vec!["Animation".to_string(), "Action".to_string()];
        let drama = vec!["Drama".to_string()];
        assert!(looks_like_anime(Some("Japan"), &anim));
        assert!(looks_like_anime(Some("Japan, United States"), &anim));
        // A Japanese live-action drama is a TV show, not anime.
        assert!(!looks_like_anime(Some("Japan"), &drama));
        // So is a western cartoon — it belongs in the TV room.
        assert!(!looks_like_anime(Some("United States"), &anim));
        assert!(!looks_like_anime(None, &anim));
    }

    #[test]
    fn episodes_sort_by_season_then_episode() {
        let meta = serde_json::json!({
            "videos": [
                { "season": 2, "episode": 1, "name": "b" },
                { "season": 1, "episode": 2, "name": "a2" },
                { "season": 1, "episode": 1, "name": "a1" },
                { "season": 0, "episode": 1, "name": "special" },
                { "name": "no numbers at all" }
            ]
        });
        let eps = episodes_from(&meta);
        // The unnumbered row is dropped, not defaulted to S0E0.
        assert_eq!(eps.len(), 4);
        assert_eq!(
            eps.iter().map(|e| (e.season, e.episode)).collect::<Vec<_>>(),
            vec![(0, 1), (1, 1), (1, 2), (2, 1)]
        );
    }
}

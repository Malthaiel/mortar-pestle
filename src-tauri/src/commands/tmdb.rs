//! TMDb — the user's own film metadata key, for the Library Movies room.
//!
//! **No key ships with the app.** The key belongs to the user, lives in the OS
//! keychain next to every other credential this app holds, and until they add
//! one every command here answers empty rather than failing. That is the whole
//! design, not a limitation: the app is fully local, so a TMDb request only ever
//! leaves the user's machine under the user's own agreement with TMDb. See
//! `Knowledge/Mortar & Pestle/Plans/Bring Your Own Source.md`.
//!
//! TMDb's free key requires attribution — "This product uses the TMDB API but is
//! not endorsed or certified by TMDB" — rendered in Settings → System and beside
//! the key field. Do not remove it.
//!
//! Cinemeta stays the browse/search/poster supplier; this only fills the credits
//! a film card cannot get elsewhere (full cast with character names, crew by
//! job, production companies, budget, box office).
//!
//! Shape deliberately mirrors `cinemeta.rs` — same `OnceLock` client, same
//! `Mutex<HashMap>` TTL cache — so there is one caching style in this module
//! tree, not two.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

const BASE: &str = "https://api.themoviedb.org/3";
/// TMDb's image CDN. `w1280` is the widest backdrop size that still downloads
/// fast enough to paint with the page; the original can exceed 3 MB.
const BACKDROP_BASE: &str = "https://image.tmdb.org/t/p/w1280";
/// Credit portraits. `w185` is TMDb's headshot size -- the cast pairs draw them
/// about 120px wide, so anything larger is bytes nobody sees.
const PROFILE_BASE: &str = "https://image.tmdb.org/t/p/w185";
const USER_AGENT: &str = "Citadel/1.0 (mortar-pestle)";
const TIMEOUT: Duration = Duration::from_secs(20);
/// A released film's credits do not change. The cache exists to keep a browse
/// session off the network, not to track anything.
const TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);


const KR_SERVICE: &str = "mortar-pestle";
const KR_ACCOUNT: &str = "tmdb";

// ── Wire type ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbCredit {
    pub name: String,
    /// Character for cast, job for crew.
    pub role: String,
    /// Headshot, already a full URL. Empty when TMDb has no photo on file --
    /// the card writes a blank entry so the image list stays index-aligned
    /// with the name list.
    pub image: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmdbDetail {
    /// False when no key is configured — the caller renders nothing rather than
    /// an error, because "no key" is the expected state, not a fault.
    pub available: bool,
    pub tmdb_id: Option<i64>,
    pub cast: Vec<TmdbCredit>,
    pub crew: Vec<TmdbCredit>,
    pub studios: Vec<String>,
    pub countries: Vec<String>,
    pub budget: Option<i64>,
    pub revenue: Option<i64>,
    pub tagline: Option<String>,
    /// Theatrical release dates, one flat "YYYY-MM-DD|CC|CERT" line per country
    /// per date -- see `release_dates`.
    pub releases: Vec<String>,
    /// Wide scene still, already a full URL. The film header paints it behind
    /// the poster + title. Credit PORTRAITS stay deleted -- this is the one
    /// image the page asks TMDb for.
    pub backdrop: Option<String>,
}

// ── Key ──────────────────────────────────────────────────────────────────────

fn load_key() -> Option<String> {
    let entry = keyring::Entry::new(KR_SERVICE, KR_ACCOUNT).ok()?;
    let k = entry.get_password().ok()?;
    (!k.trim().is_empty()).then(|| k.trim().to_string())
}

#[tauri::command]
pub fn tmdb_set_api_key(key: String) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KR_SERVICE, KR_ACCOUNT).map_err(|e| format!("keyring open: {e}"))?;
    let key = key.trim();
    if key.is_empty() {
        // Clearing is a normal action, not an error: the user is entitled to
        // take their key back out and have the feature go quiet again.
        return match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring clear: {e}")),
        };
    }
    entry
        .set_password(key)
        .map_err(|e| format!("keyring set: {e}"))
}

/// Whether a key is stored. Never returns the key itself — the UI only needs to
/// know whether to show "connected", and a key that can be read back out of a
/// command is a key that leaks through any probe.
#[tauri::command]
pub fn tmdb_has_api_key() -> bool {
    load_key().is_some()
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

/// Cache keys are the URL **without** the key query, so a rotated key does not
/// orphan the whole cache and the key never sits in a map that a panic could
/// print.
async fn get_json(path: &str, key: &str) -> Result<Value, String> {
    if let Ok(map) = cache().lock() {
        if let Some(hit) = map.get(path) {
            if hit.expires > Instant::now() {
                return Ok(hit.value.clone());
            }
        }
    }
    let sep = if path.contains('?') { '&' } else { '?' };
    let url = format!("{BASE}{path}{sep}api_key={key}");
    let resp = http_client()
        .get(&url)
        .send()
        .await
        // Never print the URL: it carries the key (reqwest's error text appends it).
        .map_err(|e| format!("tmdb request failed: {}", e.without_url()))?;
    if !resp.status().is_success() {
        // Never include the URL: it carries the key.
        return Err(format!("tmdb answered {}", resp.status()));
    }
    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("tmdb sent no JSON: {e}"))?;
    if let Ok(mut map) = cache().lock() {
        let now = Instant::now();
        map.retain(|_, v| v.expires > now);
        map.insert(
            path.to_string(),
            Cached {
                value: value.clone(),
                expires: now + TTL,
            },
        );
    }
    Ok(value)
}

// ── Command ──────────────────────────────────────────────────────────────────

fn strings(v: Option<&Value>, field: &str) -> Vec<String> {
    v.and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| e.get(field).and_then(|n| n.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn credits(v: Option<&Value>, role_field: &str, limit: usize) -> Vec<TmdbCredit> {
    v.and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let name = e.get("name").and_then(|n| n.as_str())?;
                    Some(TmdbCredit {
                        name: name.to_string(),
                        role: e
                            .get(role_field)
                            .and_then(|c| c.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        image: e
                            .get("profile_path")
                            .and_then(|p| p.as_str())
                            .filter(|p| !p.trim().is_empty())
                            .map(|p| format!("{PROFILE_BASE}{p}"))
                            .unwrap_or_default(),
                    })
                })
                .take(limit)
                .collect()
        })
        .unwrap_or_default()
}

/// Theatrical release dates, flattened to "YYYY-MM-DD|CC|CERT" -- one line per
/// country per date, because a flat string list is what a card's frontmatter and
/// `series.rs` both already read, and a nested map would need a parser neither
/// has.
///
/// TMDb's `type` is 1 premiere / 2 limited theatrical / 3 theatrical / 4 digital
/// / 5 physical / 6 TV. Only the first three are the film's RELEASE; the rest are
/// how it later reached a living room, which is a different question and would
/// list most countries three more times.
///
/// Sorted, so the order is the date order the page shows and no JS re-sorts it.
fn release_dates(v: Option<&Value>) -> Vec<String> {
    let mut out: Vec<String> = v
        .and_then(|x| x.get("results"))
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .flat_map(|c| {
                    let code = c
                        .get("iso_3166_1")
                        .and_then(|s| s.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let rows = c
                        .get("release_dates")
                        .and_then(|d| d.as_array())
                        .cloned()
                        .unwrap_or_default();
                    rows.into_iter()
                        .filter(|r| {
                            matches!(r.get("type").and_then(|t| t.as_i64()), Some(1..=3))
                        })
                        .filter_map(|r| {
                            // TMDb sends a full timestamp; the DAY is the fact.
                            let date = r
                                .get("release_date")
                                .and_then(|d| d.as_str())
                                .and_then(|d| d.get(..10))?
                                .to_string();
                            let cert = r
                                .get("certification")
                                .and_then(|c| c.as_str())
                                .unwrap_or_default()
                                .trim()
                                .to_string();
                            Some(format!("{date}|{code}|{cert}"))
                        })
                        .collect::<Vec<_>>()
                })
                .collect()
        })
        .unwrap_or_default();
    // A country with both a limited and a wide date on the SAME day says it once.
    out.sort();
    out.dedup();
    out
}

/// Credits for a film, keyed by its IMDb id.
///
/// Two calls: `/find` translates the IMDb id, then `/movie/{id}` with credits
/// appended. Cinemeta's payload happens to carry `moviedb_id` already, but going
/// through `/find` keeps this independent of a supplier whose own terms are
/// unresolved and which may yet be replaced.
#[tauri::command]
pub async fn tmdb_movie_detail(imdb_id: String) -> Result<TmdbDetail, String> {
    let imdb_id = imdb_id.trim();
    if !(imdb_id.starts_with("tt")
        && imdb_id.len() > 2
        && imdb_id[2..].chars().all(|c| c.is_ascii_digit()))
    {
        return Err(format!("not an IMDb id: {imdb_id}"));
    }
    let Some(key) = load_key() else {
        return Ok(TmdbDetail::default()); // available: false
    };

    let found = get_json(
        &format!("/find/{imdb_id}?external_source=imdb_id"),
        &key,
    )
    .await?;
    let Some(tmdb_id) = found
        .get("movie_results")
        .and_then(|r| r.as_array())
        .and_then(|a| a.first())
        .and_then(|m| m.get("id"))
        .and_then(|i| i.as_i64())
    else {
        // TMDb simply does not have this film. Not an error the user can act on.
        return Ok(TmdbDetail {
            available: true,
            ..Default::default()
        });
    };

    let m = get_json(
        &format!("/movie/{tmdb_id}?append_to_response=credits,release_dates"),
        &key,
    )
    .await?;
    let c = m.get("credits");

    Ok(TmdbDetail {
        available: true,
        tmdb_id: Some(tmdb_id),
        cast: credits(c.and_then(|x| x.get("cast")), "character", 24),
        crew: credits(c.and_then(|x| x.get("crew")), "job", 40),
        studios: strings(m.get("production_companies"), "name"),
        countries: strings(m.get("production_countries"), "name"),
        // TMDb sends 0 for "unknown", which is not the same as a film that made
        // nothing — treat it as absent so the card omits the row entirely.
        budget: m.get("budget").and_then(|b| b.as_i64()).filter(|&b| b > 0),
        revenue: m.get("revenue").and_then(|r| r.as_i64()).filter(|&r| r > 0),
        tagline: m
            .get("tagline")
            .and_then(|t| t.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        // Appended to the same request -- no extra round trip.
        releases: release_dates(m.get("release_dates")),
        // Already on the /movie response -- no extra request.
        backdrop: m
            .get("backdrop_path")
            .and_then(|b| b.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("{BACKDROP_BASE}{s}")),
    })
}

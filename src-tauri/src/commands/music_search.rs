//! Music Browse — MusicBrainz search commands.
//!
//! Read-only outbound HTTP to the MusicBrainz WS/2 API for the Browse page's
//! album + artist discovery: release-group search, artist search, and an
//! artist's discography (browse by artist MBID). Covers are hot-linked from the
//! Cover Art Archive on the frontend; nothing is persisted here.
//!
//! A process-global ≥1.1s throttle keeps us inside MusicBrainz's 1 req/s TOS
//! limit; the `User-Agent` string is mandated by their TOS. Mirrors the curl
//! calls in `Infrastructure/Skills/Ingest/ingest-musicbrainz.md`.
//!
//! Every answer is kept in the shared `http_cache` (`app_cache_dir()/musicbrainz`)
//! and served from there first, so a repeat visit never waits on the gate. An
//! artist's discography (`Fresh::Live`) is re-checked in the background on every
//! read and a changed answer emits `music-mb-refreshed`, which the album-list
//! screens re-read live. Everything else (`Fresh::Week`) is trusted 7 days, then
//! refreshed in the background the same way, silently.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex;

use crate::commands::http_cache::HttpCache;
use crate::commands::vault::VaultError;

const MB_BASE: &str = "https://musicbrainz.org/ws/2";
const MB_USER_AGENT: &str = "Citadel/1.0 (altaccountrawr@proton.me)";
const MB_MIN_INTERVAL: Duration = Duration::from_millis(1100);
const WEEK_SECS: u64 = 7 * 86_400;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseGroupHit {
    pub mbid: String,
    pub title: String,
    pub artist: String,
    pub year: Option<i64>,
    pub primary_type: Option<String>,
    pub secondary_types: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistHit {
    pub mbid: String,
    pub name: String,
    pub disambiguation: Option<String>,
    pub country: Option<String>,
}

/// One MusicBrainz recording (a song), with the release it most plausibly
/// belongs to for display context.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingHit {
    pub mbid: String,
    pub title: String,
    pub artist: String,
    /// Track length in seconds (MusicBrainz reports milliseconds).
    pub length: Option<i64>,
    pub release: Option<String>,
    /// Release-group MBID of the first release carrying this recording, when
    /// MusicBrainz includes it. Lets a song result link straight to its album
    /// page instead of re-running a text search for it.
    pub release_group_mbid: Option<String>,
}

static CACHE: HttpCache = HttpCache::new("musicbrainz");
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

static COVER_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Wire the disk cache, the cover folder and the event handle at startup
/// (`lib.rs` setup).
pub fn init(app: &tauri::AppHandle) {
    use tauri::Manager;
    CACHE.init_dir(app);
    if let Ok(dir) = app.path().app_cache_dir() {
        let dir = dir.join("music-covers");
        if std::fs::create_dir_all(&dir).is_ok() {
            let _ = COVER_DIR.set(dir);
        }
    }
    let _ = APP.set(app.clone());
}

/// Saved-cover folder, for the asset protocol's allow-list (`media.rs`).
pub fn cover_dir() -> Option<&'static PathBuf> {
    COVER_DIR.get()
}

/// A Cover Art Archive thumbnail, saved to disk the first time it's asked for.
/// CAA answers through three hosts (307 → 302 → 200) and the redirects aren't
/// cacheable, so hot-linking re-walked all three on every visit. `kind` is
/// `release-group` or `release`; `size` a CAA thumbnail width (always JPEG).
/// `None` = CAA has no cover; that miss is remembered 7 days. `image` picks one
/// picture of a release by its CAA id (the album page's Artwork tab, from
/// `music_release_artwork`); absent = the front cover.
#[tauri::command]
pub async fn music_cover(kind: String, mbid: String, size: u32, image: Option<String>) -> Result<Option<String>, VaultError> {
    let id_ok = !mbid.is_empty() && mbid.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    let image_ok = image.as_deref().map_or(true, |i| !i.is_empty() && i.chars().all(|c| c.is_ascii_digit()));
    if !matches!(kind.as_str(), "release-group" | "release") || !id_ok || !image_ok || !matches!(size, 250 | 500 | 1200) {
        return Err(VaultError::Invalid("Bad cover request".into()));
    }
    let dir = COVER_DIR.get().ok_or_else(|| VaultError::Io("Cover folder unavailable".into()))?;
    let pic = image.as_deref().unwrap_or("front");
    let stem = match &image {
        Some(i) => format!("{kind}-{mbid}-{i}-{size}"),
        None => format!("{kind}-{mbid}-{size}"),
    };
    let img = dir.join(format!("{stem}.jpg"));
    if img.exists() {
        return Ok(Some(img.to_string_lossy().into_owned()));
    }
    let miss = dir.join(format!("{stem}.miss"));
    let miss_age = std::fs::metadata(&miss).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
    if miss_age.is_some_and(|age| age.as_secs() < WEEK_SECS) {
        return Ok(None);
    }
    // Cards ask for every cover at mount (a discography grid can be 100), so cap
    // the parallel downloads to stay polite to archive.org.
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let _slot = SLOTS.get_or_init(|| tokio::sync::Semaphore::new(6)).acquire().await;
    if img.exists() {
        return Ok(Some(img.to_string_lossy().into_owned()));
    }
    let url = format!("https://coverartarchive.org/{kind}/{mbid}/{pic}-{size}");
    let resp = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| VaultError::Io(format!("Cover request failed: {e}")))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        let _ = std::fs::write(&miss, b"");
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(VaultError::Io(format!("Cover Art Archive returned HTTP {}", resp.status().as_u16())));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| VaultError::Io(format!("Cover download failed: {e}")))?;
    // Write-then-rename so a card asking for the same cover mid-download never
    // gets a half-written file.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!("{stem}.{nonce}.tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| VaultError::Io(format!("Cover save failed: {e}")))?;
    let _ = std::fs::rename(&tmp, &img);
    let _ = std::fs::remove_file(&tmp);
    Ok(Some(img.to_string_lossy().into_owned()))
}

/// How long a saved answer is trusted before a background re-check.
#[derive(Clone, Copy)]
enum Fresh {
    /// Re-checked on every read; a change emits `music-mb-refreshed`.
    Live,
    /// Trusted 7 days, then refreshed silently.
    Week,
}

/// One keep-alive connection for every MusicBrainz call (no TLS handshake per
/// request).
fn http_client() -> &'static reqwest::Client {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    CELL.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(MB_USER_AGENT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Process-global timestamp of the last MusicBrainz request. The lock is held
/// across the sleep AND the request so concurrent callers serialize behind the
/// 1 req/s gate, and a caller that queued behind an identical miss finds the
/// answer already saved instead of asking again.
fn last_request() -> &'static Mutex<Option<Instant>> {
    static CELL: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// URLs with a background re-check in flight (StrictMode double effects and
/// back-to-back visits must not queue the same question twice).
fn refreshing() -> &'static std::sync::Mutex<HashSet<String>> {
    static CELL: OnceLock<std::sync::Mutex<HashSet<String>>> = OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(HashSet::new()))
}

/// One throttled network GET. `reuse_saved` returns an answer another caller
/// saved while this one waited for the gate (the miss path); a background
/// re-check passes false so it always asks.
async fn mb_fetch(url: &str, reuse_saved: bool) -> Result<serde_json::Value, VaultError> {
    let mut guard = last_request().lock().await;
    if reuse_saved {
        if let Some(entry) = CACHE.lookup(url) {
            return Ok(entry.value);
        }
    }
    if let Some(prev) = *guard {
        let elapsed = prev.elapsed();
        if elapsed < MB_MIN_INTERVAL {
            tokio::time::sleep(MB_MIN_INTERVAL - elapsed).await;
        }
    }
    *guard = Some(Instant::now());
    let resp = http_client()
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| VaultError::Io(format!("MusicBrainz request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(VaultError::Io(format!(
            "MusicBrainz returned HTTP {}",
            resp.status().as_u16()
        )));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| VaultError::Io(format!("MusicBrainz JSON parse failed: {e}")))
}

/// Saved answer first (instant); a stale one is returned as-is and re-checked in
/// the background. Only a true miss waits on the network.
// ponytail: every Live read queues a background call on the 1 req/s gate, so fast
// back-and-forth browsing can make a typed search wait behind them. Add a
// priority lane for foreground calls if that ever bites.
async fn mb_get(url: &str, fresh: Fresh) -> Result<serde_json::Value, VaultError> {
    let ttl = match fresh {
        Fresh::Live => 0,
        Fresh::Week => WEEK_SECS,
    };
    if let Some(entry) = CACHE.lookup(url) {
        if !entry.is_fresh() {
            spawn_recheck(url.to_string(), ttl, fresh, entry.value.clone());
        }
        return Ok(entry.value);
    }
    let v = mb_fetch(url, true).await?;
    CACHE.store(url, &v, ttl);
    Ok(v)
}

fn spawn_recheck(url: String, ttl: u64, fresh: Fresh, saved: serde_json::Value) {
    if !refreshing().lock().unwrap_or_else(|e| e.into_inner()).insert(url.clone()) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Ok(v) = mb_fetch(&url, false).await {
            CACHE.store(&url, &v, ttl);
            if matches!(fresh, Fresh::Live) && v != saved {
                if let Some(app) = APP.get() {
                    let _ = app.emit("music-mb-refreshed", &url);
                }
            }
        }
        refreshing().lock().unwrap_or_else(|e| e.into_inner()).remove(&url);
    });
}

/// Flatten an `artist-credit` array into a display string, preserving join
/// phrases (e.g. "Artist feat. Other").
fn join_artist_credit(rg: &serde_json::Value) -> String {
    rg.get("artist-credit")
        .and_then(|x| x.as_array())
        .map(|credits| {
            credits
                .iter()
                .map(|c| {
                    let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    let join = c.get("joinphrase").and_then(|j| j.as_str()).unwrap_or("");
                    format!("{name}{join}")
                })
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn parse_release_group(rg: &serde_json::Value) -> Option<ReleaseGroupHit> {
    let mbid = rg.get("id")?.as_str()?.to_string();
    let title = rg.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let artist = join_artist_credit(rg);
    let year = rg
        .get("first-release-date")
        .and_then(|x| x.as_str())
        .and_then(|d| d.get(0..4))
        .and_then(|y| y.parse::<i64>().ok());
    let primary_type = rg
        .get("primary-type")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    let secondary_types = rg
        .get("secondary-types")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Some(ReleaseGroupHit {
        mbid,
        title,
        artist,
        year,
        primary_type,
        secondary_types,
    })
}

fn parse_release_groups(v: &serde_json::Value) -> Vec<ReleaseGroupHit> {
    v.get("release-groups")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(parse_release_group).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn music_search_releasegroups(
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<ReleaseGroupHit>, VaultError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(25).clamp(1, 100);
    let offset = offset.unwrap_or(0);
    // `dismax=true` — MusicBrainz's multi-field matcher. The default Lucene
    // parser searches the release-group TITLE only, so a natural query that
    // names the artist too ("ohms deftones") treats the band as another title
    // word and buries the right album. dismax weighs title AND artist.
    let url = format!(
        "{MB_BASE}/release-group?query={}&dismax=true&fmt=json&limit={}&offset={}",
        urlencoding::encode(q),
        limit,
        offset
    );
    Ok(parse_release_groups(&mb_get(&url, Fresh::Week).await?))
}

#[tauri::command]
pub async fn music_search_artists(query: String) -> Result<Vec<ArtistHit>, VaultError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!(
        "{MB_BASE}/artist?query={}&fmt=json&limit=25",
        urlencoding::encode(q)
    );
    let v = mb_get(&url, Fresh::Week).await?;
    let hits = v
        .get("artists")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    let mbid = a.get("id")?.as_str()?.to_string();
                    let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let disambiguation = a
                        .get("disambiguation")
                        .and_then(|x| x.as_str())
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                    let country = a.get("country").and_then(|x| x.as_str()).map(str::to_string);
                    Some(ArtistHit {
                        mbid,
                        name,
                        disambiguation,
                        country,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(hits)
}

#[tauri::command]
pub async fn music_search_recordings(query: String) -> Result<Vec<RecordingHit>, VaultError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    // `dismax=true` for the same reason as the release-group search above: the
    // default parser only reads the recording TITLE, so "i think about you all
    // the time deftones" never ranks the Deftones recording.
    let url = format!(
        "{MB_BASE}/recording?query={}&dismax=true&fmt=json&limit=25",
        urlencoding::encode(q)
    );
    let v = mb_get(&url, Fresh::Week).await?;
    let hits = v
        .get("recordings")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let mbid = r.get("id")?.as_str()?.to_string();
                    let title = r.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let length = r
                        .get("length")
                        .and_then(|x| x.as_i64())
                        .map(|ms| ms / 1000);
                    let first_release = r
                        .get("releases")
                        .and_then(|x| x.as_array())
                        .and_then(|a| a.first());
                    let release = first_release
                        .and_then(|rel| rel.get("title"))
                        .and_then(|x| x.as_str())
                        .map(str::to_string);
                    let release_group_mbid = first_release
                        .and_then(|rel| rel.get("release-group"))
                        .and_then(|rg| rg.get("id"))
                        .and_then(|x| x.as_str())
                        .map(str::to_string);
                    Some(RecordingHit {
                        mbid,
                        title,
                        artist: join_artist_credit(r),
                        length,
                        release,
                        release_group_mbid,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(hits)
}

#[tauri::command]
pub async fn music_artist_releasegroups(
    artist_mbid: String,
) -> Result<Vec<ReleaseGroupHit>, VaultError> {
    let id = artist_mbid.trim();
    if id.is_empty() {
        return Ok(Vec::new());
    }
    // Browse request: all album + EP release-groups for this artist. `%7C` is a
    // URL-encoded pipe — MusicBrainz reads `type=album|ep` as a union filter.
    let url = format!(
        "{MB_BASE}/release-group?artist={}&type=album%7Cep&fmt=json&limit=100",
        urlencoding::encode(id)
    );
    let mut hits = parse_release_groups(&mb_get(&url, Fresh::Live).await?);
    // Newest first; undated last.
    hits.sort_by(|a, b| b.year.unwrap_or(0).cmp(&a.year.unwrap_or(0)));
    Ok(hits)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub disc: i64,
    pub position: i64,
    pub title: String,
    pub length_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDetail {
    pub release_group_mbid: String,
    /// The canonical release picked from the group — used for the release-level
    /// cover fallback (decision #10) and as the download target (SF3).
    pub release_mbid: String,
    pub title: String,
    pub artist: String,
    pub year: Option<i64>,
    pub primary_type: Option<String>,
    pub secondary_types: Vec<String>,
    pub track_count: usize,
    pub length_ms: Option<i64>,
    pub multi_disc: bool,
    pub tracks: Vec<TrackInfo>,
}

/// Canonical-release rank for the tiebreak: GB first, then US, then anything.
fn country_rank(r: &serde_json::Value) -> u8 {
    match r.get("country").and_then(|c| c.as_str()) {
        Some("GB") => 0,
        Some("US") => 1,
        _ => 2,
    }
}

/// Pick the canonical release from a release-group's `releases[]`, mirroring
/// `ingest-musicbrainz.md` Phase 1 Step A exactly: prefer `status == "Official"`,
/// then earliest `date`, tiebreak `country == "GB"` then `"US"`. Falls back to the
/// full pool when no release is Official. An empty/missing date sorts last so a
/// dateless release never wins "earliest".
fn pick_canonical_release(releases: &[serde_json::Value]) -> Option<&serde_json::Value> {
    let official: Vec<&serde_json::Value> = releases
        .iter()
        .filter(|r| r.get("status").and_then(|s| s.as_str()) == Some("Official"))
        .collect();
    let pool: Vec<&serde_json::Value> =
        if official.is_empty() { releases.iter().collect() } else { official };
    pool.into_iter().min_by(|a, b| {
        let da = a.get("date").and_then(|d| d.as_str()).filter(|s| !s.is_empty()).unwrap_or("9999");
        let db = b.get("date").and_then(|d| d.as_str()).filter(|s| !s.is_empty()).unwrap_or("9999");
        da.cmp(db).then_with(|| country_rank(a).cmp(&country_rank(b)))
    })
}

/// Album preview: resolve a release-group to its canonical release and full
/// tracklist. Two throttled MB calls (group→releases, then release→recordings) —
/// acceptable for a single user-initiated preview. The canonical pick matches the
/// download script's so the preview tracklist is what actually gets fetched.
#[tauri::command]
pub async fn music_releasegroup_detail(rg_mbid: String) -> Result<ReleaseDetail, VaultError> {
    let id = rg_mbid.trim();
    if id.is_empty() {
        return Err(VaultError::Invalid("Empty release-group MBID".into()));
    }
    // Step A — release-group meta + its releases (for the canonical pick).
    let rg_url = format!(
        "{MB_BASE}/release-group/{}?inc=releases+artist-credits&fmt=json",
        urlencoding::encode(id)
    );
    let rg = mb_get(&rg_url, Fresh::Week).await?;
    let meta = parse_release_group(&rg)
        .ok_or_else(|| VaultError::Io("MusicBrainz returned an unparseable release-group.".into()))?;
    let releases = rg
        .get("releases")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let canonical = pick_canonical_release(&releases)
        .ok_or_else(|| VaultError::Io("MusicBrainz release-group has no releases.".into()))?;
    let release_mbid = canonical
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| VaultError::Io("Canonical release is missing an MBID.".into()))?
        .to_string();

    // Step B — canonical release detail (tracklist).
    let rel_url = format!(
        "{MB_BASE}/release/{}?inc=recordings&fmt=json",
        urlencoding::encode(&release_mbid)
    );
    let rel = mb_get(&rel_url, Fresh::Week).await?;
    let media = rel.get("media").and_then(|x| x.as_array());
    let multi_disc = media.map(|m| m.len() > 1).unwrap_or(false);

    let mut tracks: Vec<TrackInfo> = Vec::new();
    let mut total_ms: i64 = 0;
    let mut any_len = false;
    if let Some(media) = media {
        for (mi, medium) in media.iter().enumerate() {
            let disc = medium
                .get("position")
                .and_then(|p| p.as_i64())
                .unwrap_or((mi + 1) as i64);
            let Some(track_arr) = medium.get("tracks").and_then(|t| t.as_array()) else { continue };
            for t in track_arr {
                let position = t.get("position").and_then(|p| p.as_i64()).unwrap_or(0);
                let title = t
                    .get("title")
                    .and_then(|x| x.as_str())
                    .or_else(|| t.get("recording").and_then(|r| r.get("title")).and_then(|x| x.as_str()))
                    .unwrap_or("")
                    .to_string();
                let length_ms = t
                    .get("length")
                    .and_then(|x| x.as_i64())
                    .or_else(|| t.get("recording").and_then(|r| r.get("length")).and_then(|x| x.as_i64()));
                if let Some(l) = length_ms {
                    total_ms += l;
                    any_len = true;
                }
                tracks.push(TrackInfo { disc, position, title, length_ms });
            }
        }
    }
    if tracks.is_empty() {
        return Err(VaultError::Io("MusicBrainz release has no tracklist.".into()));
    }

    Ok(ReleaseDetail {
        release_group_mbid: meta.mbid,
        release_mbid,
        title: meta.title,
        artist: meta.artist,
        year: meta.year,
        primary_type: meta.primary_type,
        secondary_types: meta.secondary_types,
        track_count: tracks.len(),
        length_ms: if any_len { Some(total_ms) } else { None },
        multi_disc,
        tracks,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtImage {
    /// CAA image id, for `music_cover(.., image)`.
    pub id: String,
    /// What the picture shows: Front, Back, Booklet, Disc, Tray, ...
    pub kind: String,
    /// The 1200px version, the viewer's big picture.
    pub full: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArtwork {
    pub release_mbid: Option<String>,
    pub images: Vec<ArtImage>,
}

/// Every scanned picture of an album, for the viewer the album page's sleeve
/// opens. Taken from whichever edition has the MOST pictures on the Cover Art
/// Archive (the browse answer counts them per edition), not the canonical one,
/// which is often a bare digital release with a front cover only.
// ponytail: one browse page (100 editions); page with `offset` if an album
// with more ever misses its best-scanned edition.
#[tauri::command]
pub async fn music_release_artwork(rg_mbid: String) -> Result<ReleaseArtwork, VaultError> {
    let id = rg_mbid.trim();
    if id.is_empty() {
        return Err(VaultError::Invalid("Empty release-group MBID".into()));
    }
    let url = format!("{MB_BASE}/release?release-group={}&fmt=json&limit=100", urlencoding::encode(id));
    let editions = mb_get(&url, Fresh::Live).await?;
    let Some(rel) = most_pictured(&editions) else {
        return Ok(ReleaseArtwork { release_mbid: None, images: Vec::new() });
    };
    // Through the same saved-answer cache and polite gate as MusicBrainz.
    let listing = mb_get(&format!("https://coverartarchive.org/release/{rel}"), Fresh::Week).await?;
    Ok(ReleaseArtwork { release_mbid: Some(rel), images: art_images(&listing) })
}

/// The edition with the most CAA pictures; the first one listed wins a tie.
/// `None` when no edition has any.
fn most_pictured(editions: &serde_json::Value) -> Option<String> {
    let mut best: Option<(u64, &str)> = None;
    for r in editions.get("releases").and_then(|x| x.as_array()).into_iter().flatten() {
        let n = r.get("cover-art-archive").and_then(|c| c.get("count")).and_then(|c| c.as_u64()).unwrap_or(0);
        let Some(id) = r.get("id").and_then(|x| x.as_str()) else { continue };
        if n > 0 && best.map_or(true, |(b, _)| n > b) {
            best = Some((n, id));
        }
    }
    best.map(|(_, id)| id.to_string())
}

fn art_images(listing: &serde_json::Value) -> Vec<ArtImage> {
    listing
        .get("images")
        .and_then(|x| x.as_array())
        .into_iter()
        .flatten()
        .filter_map(|i| {
            // CAA ids arrive as numbers, older answers as strings.
            let id = i.get("id").and_then(|v| v.as_u64().map(|n| n.to_string()).or_else(|| v.as_str().map(str::to_string)))?;
            let kind = match i.get("types").and_then(|t| t.as_array()).and_then(|t| t.first()).and_then(|t| t.as_str()) {
                Some("Medium") => "Disc",
                Some(t) => t,
                None => "Other",
            }
            .to_string();
            let th = i.get("thumbnails");
            let full = ["1200", "large"]
                .iter()
                .find_map(|k| th.and_then(|t| t.get(*k)).and_then(|u| u.as_str()))
                .or_else(|| i.get("image").and_then(|u| u.as_str()))?
                .replacen("http://", "https://", 1);
            Some(ArtImage { id, kind, full })
        })
        .collect()
}

#[cfg(test)]
mod artwork_tests {
    #[test]
    fn picks_the_most_pictured_edition_and_names_each_picture() {
        let eds = serde_json::json!({ "releases": [
            { "id": "a", "cover-art-archive": { "count": 1 } },
            { "id": "b", "cover-art-archive": { "count": 27 } },
            { "id": "c", "cover-art-archive": { "count": 27 } },
            { "id": "d" } ]});
        assert_eq!(super::most_pictured(&eds).as_deref(), Some("b"));
        assert_eq!(super::most_pictured(&serde_json::json!({ "releases": [{ "id": "a" }] })), None);
        let listing = serde_json::json!({ "images": [
            { "id": 6496048047u64, "types": ["Front"], "thumbnails": { "1200": "http://coverartarchive.org/x-1200.jpg" } },
            { "id": "32966164370", "types": ["Medium"], "thumbnails": { "large": "http://coverartarchive.org/y-500.jpg" } },
            { "id": 5, "types": [], "image": "https://coverartarchive.org/z.jpg" },
            { "types": ["Back"], "image": "https://coverartarchive.org/no-id.jpg" } ]});
        let got: Vec<(String, String, String)> = super::art_images(&listing).into_iter().map(|a| (a.id, a.kind, a.full)).collect();
        assert_eq!(got, vec![
            ("6496048047".into(), "Front".into(), "https://coverartarchive.org/x-1200.jpg".into()),
            ("32966164370".into(), "Disc".into(), "https://coverartarchive.org/y-500.jpg".into()),
            ("5".into(), "Other".into(), "https://coverartarchive.org/z.jpg".into()),
        ]);
    }
}

/// One credited contributor on a release: a person/group plus their role
/// (humanized from the MusicBrainz relationship type, or the instrument/vocal
/// attribute when the type is generic). `detail` carries extra attribute text
/// (e.g. "co" / "additional") when present and not already folded into the role.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditEntry {
    pub name: String,
    pub mbid: Option<String>,
    pub role: String,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePersonnel {
    pub release_mbid: String,
    pub credits: Vec<CreditEntry>,
}

/// Capitalize the first character (rest untouched) — "guitar" → "Guitar".
fn cap_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Display label for a MusicBrainz relationship `type`. A few common types read
/// awkwardly capitalized verbatim ("mix" → "Mixing"); the rest just cap-first.
fn humanize_role(t: &str) -> String {
    match t {
        "mix" => "Mixing".into(),
        "recording" => "Recording".into(),
        "vocal" => "Vocals".into(),
        "instrument" => "Performer".into(),
        "" => "Contributor".into(),
        other => cap_first(other),
    }
}

/// Main + featured artists from a release's `artist-credit[]`. Index 0 is the
/// primary artist; later entries are collaborators/features.
fn parse_artist_credits(rel: &serde_json::Value) -> Vec<CreditEntry> {
    let Some(arr) = rel.get("artist-credit").and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, c) in arr.iter().enumerate() {
        let artist = c.get("artist");
        let name = artist
            .and_then(|a| a.get("name"))
            .and_then(|x| x.as_str())
            .or_else(|| c.get("name").and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let mbid = artist
            .and_then(|a| a.get("id"))
            .and_then(|x| x.as_str())
            .map(str::to_string);
        let role = if i == 0 { "Primary artist" } else { "Featured artist" }.to_string();
        out.push(CreditEntry { name, mbid, role, detail: None });
    }
    out
}

/// Turn one relationship object into a credit, if it targets an artist. For
/// instrument/vocal rels the specific instrument/voice in `attributes` becomes
/// the role; other attributes ride along as `detail`.
fn credit_from_relation(r: &serde_json::Value) -> Option<CreditEntry> {
    let artist = r.get("artist")?;
    let name = artist.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if name.is_empty() {
        return None;
    }
    let mbid = artist.get("id").and_then(|x| x.as_str()).map(str::to_string);
    let rtype = r.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let attrs: Vec<String> = r
        .get("attributes")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let (role, detail) = if matches!(rtype, "instrument" | "vocal") && !attrs.is_empty() {
        (cap_first(&attrs.join(", ")), None)
    } else if attrs.is_empty() {
        (humanize_role(rtype), None)
    } else {
        (humanize_role(rtype), Some(attrs.join(", ")))
    };
    Some(CreditEntry { name, mbid, role, detail })
}

/// Every artist-credit from a `relations[]` array on any entity (release or
/// recording).
fn collect_relations(holder: &serde_json::Value) -> Vec<CreditEntry> {
    holder
        .get("relations")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(credit_from_relation).collect())
        .unwrap_or_default()
}

/// Recording-level credits, walked across every track's recording. This is where
/// MusicBrainz actually stores performers / instruments / producers for most
/// albums (release-level rels are usually sparse), so it's the rich source.
fn parse_recording_credits(rel: &serde_json::Value) -> Vec<CreditEntry> {
    let mut out = Vec::new();
    let Some(media) = rel.get("media").and_then(|x| x.as_array()) else {
        return out;
    };
    for m in media {
        let Some(tracks) = m.get("tracks").and_then(|x| x.as_array()) else { continue };
        for t in tracks {
            if let Some(rec) = t.get("recording") {
                out.extend(collect_relations(rec));
            }
        }
    }
    out
}

/// Drop exact (name, role, detail) duplicates, preserving first-seen order, and
/// cap the list so a heavily-credited release can't render a wall of chips.
fn dedup_credits(credits: Vec<CreditEntry>) -> Vec<CreditEntry> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for c in credits {
        let key = format!("{}\u{1}{}\u{1}{}", c.name, c.role, c.detail.as_deref().unwrap_or(""));
        if seen.insert(key) {
            out.push(c);
        }
        if out.len() >= 60 {
            break;
        }
    }
    out
}

/// Album credits: resolve a release-group to its canonical release, then pull
/// personnel — main/featured artists, release-level relationships, and
/// recording-level relationships aggregated across every track (where most
/// performer / instrument / producer credits actually live). Two throttled MB
/// calls, matching `music_releasegroup_detail`'s cost. Work-level rels (composer
/// / lyricist via linked works) are intentionally excluded to keep the second
/// call lean — they'd require an extra `work-level-rels` hop.
#[tauri::command]
pub async fn music_release_personnel(rg_mbid: String) -> Result<ReleasePersonnel, VaultError> {
    let id = rg_mbid.trim();
    if id.is_empty() {
        return Err(VaultError::Invalid("Empty release-group MBID".into()));
    }
    let rg_url = format!(
        "{MB_BASE}/release-group/{}?inc=releases&fmt=json",
        urlencoding::encode(id)
    );
    let rg = mb_get(&rg_url, Fresh::Week).await?;
    let releases = rg
        .get("releases")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let canonical = pick_canonical_release(&releases)
        .ok_or_else(|| VaultError::Io("MusicBrainz release-group has no releases.".into()))?;
    let release_mbid = canonical
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| VaultError::Io("Canonical release is missing an MBID.".into()))?
        .to_string();

    let rel_url = format!(
        "{MB_BASE}/release/{}?inc=artist-credits+artist-rels+recordings+recording-level-rels&fmt=json",
        urlencoding::encode(&release_mbid)
    );
    let rel = mb_get(&rel_url, Fresh::Week).await?;
    let mut credits = parse_artist_credits(&rel);
    credits.extend(collect_relations(&rel));        // release-level (often sparse)
    credits.extend(parse_recording_credits(&rel));  // recording-level (the rich set)
    Ok(ReleasePersonnel {
        release_mbid,
        credits: dedup_credits(credits),
    })
}

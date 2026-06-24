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

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Mutex;

use crate::commands::vault::VaultError;

const MB_BASE: &str = "https://musicbrainz.org/ws/2";
const MB_USER_AGENT: &str = "Citadel/1.0 (altaccountrawr@proton.me)";
const MB_MIN_INTERVAL: Duration = Duration::from_millis(1100);

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

/// Process-global timestamp of the last MusicBrainz request. The lock is held
/// across the sleep so concurrent callers serialize behind the 1 req/s gate.
fn last_request() -> &'static Mutex<Option<Instant>> {
    static CELL: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

async fn mb_get(url: &str) -> Result<serde_json::Value, VaultError> {
    {
        let mut guard = last_request().lock().await;
        if let Some(prev) = *guard {
            let elapsed = prev.elapsed();
            if elapsed < MB_MIN_INTERVAL {
                tokio::time::sleep(MB_MIN_INTERVAL - elapsed).await;
            }
        }
        *guard = Some(Instant::now());
    }
    let resp = reqwest::Client::new()
        .get(url)
        .header(reqwest::header::USER_AGENT, MB_USER_AGENT)
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
    let url = format!(
        "{MB_BASE}/release-group?query={}&fmt=json&limit={}&offset={}",
        urlencoding::encode(q),
        limit,
        offset
    );
    Ok(parse_release_groups(&mb_get(&url).await?))
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
    let v = mb_get(&url).await?;
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
    let mut hits = parse_release_groups(&mb_get(&url).await?);
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
    let rg = mb_get(&rg_url).await?;
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
    let rel = mb_get(&rel_url).await?;
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
    let rg = mb_get(&rg_url).await?;
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
    let rel = mb_get(&rel_url).await?;
    let mut credits = parse_artist_credits(&rel);
    credits.extend(collect_relations(&rel));        // release-level (often sparse)
    credits.extend(parse_recording_credits(&rel));  // recording-level (the rich set)
    Ok(ReleasePersonnel {
        release_mbid,
        credits: dedup_credits(credits),
    })
}

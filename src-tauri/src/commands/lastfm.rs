//! Last.fm — the user's own key, for each album song's worldwide play count.
//!
//! Same keychain shape as `tmdb.rs`: no key ships with the app, the user's key
//! lives in the OS keychain, and until they add one every call answers `None`
//! rather than failing. Last.fm's terms require attribution — it is credited
//! in Settings → System → Credits. Do not remove it.
//!
//! Nothing is cached here: the album page keeps the last answer per album and
//! asks again, one song at a time, on every visit (`useWorldPlays` in
//! `AlbumDetail.jsx`), the same way its music-video part does. See
//! `Knowledge/Mortar & Pestle/Plans/Last.fm World Plays.md`.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const BASE: &str = "https://ws.audioscrobbler.com/2.0/";
const USER_AGENT: &str = "Citadel/1.0 (mortar-pestle)";
const TIMEOUT: Duration = Duration::from_secs(20);

const KR_SERVICE: &str = "mortar-pestle";
const KR_ACCOUNT: &str = "lastfm";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LastfmPlays {
    /// Every scrobble of the song, worldwide.
    pub playcount: u64,
    /// The song's Last.fm page.
    pub url: String,
}

// ── Key ──────────────────────────────────────────────────────────────────────

fn load_key() -> Option<String> {
    let entry = keyring::Entry::new(KR_SERVICE, KR_ACCOUNT).ok()?;
    let k = entry.get_password().ok()?;
    (!k.trim().is_empty()).then(|| k.trim().to_string())
}

#[tauri::command]
pub fn lastfm_set_api_key(key: String) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KR_SERVICE, KR_ACCOUNT).map_err(|e| format!("keyring open: {e}"))?;
    let key = key.trim();
    if key.is_empty() {
        // Clearing is a normal action: the play counts just go back to dashes.
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

/// Whether a key is stored. Never returns the key itself (see `tmdb_has_api_key`).
#[tauri::command]
pub fn lastfm_has_api_key() -> bool {
    load_key().is_some()
}

// ── Command ──────────────────────────────────────────────────────────────────

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

/// One song's worldwide plays. `None` = no key stored, or Last.fm doesn't know
/// the song; both are expected states, not faults.
#[tauri::command]
pub async fn lastfm_track_plays(artist: String, title: String) -> Result<Option<LastfmPlays>, String> {
    let Some(key) = load_key() else { return Ok(None) };
    let resp = http_client()
        .get(BASE)
        .query(&[
            ("method", "track.getInfo"),
            ("artist", artist.as_str()),
            ("track", title.as_str()),
            ("autocorrect", "1"),
            ("format", "json"),
            ("api_key", key.as_str()),
        ])
        .send()
        .await
        // Never print the URL: it carries the key.
        .map_err(|e| format!("last.fm request failed: {}", e.without_url()))?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|_| format!("last.fm answered {status}"))?;
    parse_plays(&v)
}

/// Last.fm reports its own errors in the body (6 = track not found), and sends
/// the counts as strings.
fn parse_plays(v: &Value) -> Result<Option<LastfmPlays>, String> {
    if let Some(code) = v.get("error") {
        if code.as_i64() == Some(6) {
            return Ok(None);
        }
        let msg = v.get("message").and_then(Value::as_str).unwrap_or("error");
        return Err(format!("last.fm: {msg}"));
    }
    let t = &v["track"];
    let playcount = t["playcount"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| t["playcount"].as_u64());
    Ok(playcount.map(|playcount| LastfmPlays {
        playcount,
        url: t["url"].as_str().unwrap_or_default().to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_string_counts_and_not_found() {
        let ok = json!({ "track": { "playcount": "12400000", "listeners": "900", "url": "https://www.last.fm/music/A/_/B" } });
        assert_eq!(
            parse_plays(&ok).unwrap(),
            Some(LastfmPlays { playcount: 12_400_000, url: "https://www.last.fm/music/A/_/B".into() })
        );
        assert_eq!(parse_plays(&json!({ "error": 6, "message": "Track not found" })).unwrap(), None);
        assert!(parse_plays(&json!({ "error": 10, "message": "Invalid API key" })).is_err());
    }
}

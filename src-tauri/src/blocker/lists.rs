//! Shield runtime list-refresh (SF4b) — hosts + cosmetics only.
//!
//! Fetches EasyList + EasyPrivacy from pinned HTTPS URLs (reqwest/rustls),
//! distills the `||host^` pure-domain rules into the proxy host set and the
//! generic `##selector` rules into a cosmetic stylesheet, hot-swaps both into
//! `crate::blocker`, and caches the raw lists on disk. Content-filters and
//! scriptlets are NOT refreshed at runtime — their WebKit-safe-regex / scriptlet
//! conversion is involved and stays with the offline regen tool (SF5).
//!
//! Trust model: pinned URL + TLS (no integrity hash is possible for an
//! auto-updating list — same posture as the MAL/MusicBrainz fetches). A network
//! failure leaves whatever is already loaded (cached or vendored seed) intact.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

const EASYLIST_URL: &str = "https://easylist.to/easylist/easylist.txt";
const EASYPRIVACY_URL: &str = "https://easylist.to/easylist/easyprivacy.txt";
const STALE_AFTER: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_LIST_BYTES: usize = 16 * 1024 * 1024;
const MIN_LIST_BYTES: usize = 1000;
const MIN_HOSTS: usize = 1000;

static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Capture the per-app cache dir at startup (from `lib.rs` setup). If the dir
/// can't be resolved/created the on-disk list cache silently disables (the
/// vendored seed still loads, and refresh still hot-swaps in memory).
pub fn init_cache_dir(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_cache_dir() {
        let shield = dir.join("shield");
        match std::fs::create_dir_all(&shield) {
            Ok(()) => {
                let _ = CACHE_DIR.set(shield);
            }
            Err(e) => eprintln!("shield cache dir create failed: {e} — list cache disabled"),
        }
    }
}

fn cache_path(name: &str) -> Option<PathBuf> {
    CACHE_DIR.get().map(|d| d.join(name))
}

fn http_client() -> &'static reqwest::Client {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    CELL.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("mortar-pestle-Shield/1.0")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Unix-seconds mtime of the cached EasyList, or None if not yet cached. Drives
/// the Settings "last updated" readout.
pub fn cached_at() -> Option<u64> {
    let mt = std::fs::metadata(cache_path("easylist.txt")?)
        .ok()?
        .modified()
        .ok()?;
    mt.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

fn is_stale() -> bool {
    match cache_path("easylist.txt")
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
    {
        Some(mt) => mt.elapsed().map(|e| e > STALE_AFTER).unwrap_or(true),
        None => true,
    }
}

async fn fetch(url: &str) -> Result<String, String> {
    let resp = http_client()
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("fetch {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch {url}: HTTP {}", resp.status()));
    }
    let body = resp.text().await.map_err(|e| format!("read {url}: {e}"))?;
    if !(MIN_LIST_BYTES..=MAX_LIST_BYTES).contains(&body.len()) {
        return Err(format!("fetch {url}: implausible size {} bytes", body.len()));
    }
    Ok(body)
}

/// Refresh from the network: fetch both lists, parse, hot-swap, cache. Returns
/// the new host-rule count. On any failure the current lists are left untouched.
pub async fn refresh() -> Result<usize, String> {
    let easylist = fetch(EASYLIST_URL).await?;
    let easyprivacy = fetch(EASYPRIVACY_URL).await?;
    let combined = format!("{easylist}\n{easyprivacy}");
    let hosts = super::parse_hosts(&combined);
    if hosts.len() < MIN_HOSTS {
        return Err(format!("parsed only {} hosts — refusing to swap", hosts.len()));
    }
    let n = hosts.len();
    super::replace_hosts(hosts);
    super::replace_cosmetics(super::parse_cosmetics(&combined));
    // Cache raw lists (best-effort). `cached_at` reads the easylist mtime, so
    // write it last as the freshness marker.
    if let Some(p) = cache_path("easyprivacy.txt") {
        let _ = std::fs::write(p, &easyprivacy);
    }
    if let Some(p) = cache_path("easylist.txt") {
        let _ = std::fs::write(p, &easylist);
    }
    log::info!("blocker: refreshed lists — {n} host rules");
    Ok(n)
}

/// Startup: load a fresher cached copy over the vendored seed if present, then
/// kick a background network refresh when the cache is stale or missing.
pub fn spawn_startup_refresh() {
    if let (Some(el), Some(ep)) = (cache_path("easylist.txt"), cache_path("easyprivacy.txt")) {
        if let (Ok(a), Ok(b)) = (std::fs::read_to_string(&el), std::fs::read_to_string(&ep)) {
            let combined = format!("{a}\n{b}");
            let hosts = super::parse_hosts(&combined);
            if hosts.len() >= MIN_HOSTS {
                log::info!("blocker: loaded {} host rules from cache", hosts.len());
                super::replace_hosts(hosts);
                super::replace_cosmetics(super::parse_cosmetics(&combined));
            }
        }
    }
    if is_stale() {
        tauri::async_runtime::spawn(async {
            match refresh().await {
                Ok(n) => log::info!("blocker: startup refresh ok — {n} host rules"),
                Err(e) => log::warn!(
                    "blocker: startup refresh failed: {e} (using {} cached/seed rules)",
                    super::host_rule_count()
                ),
            }
        });
    }
}

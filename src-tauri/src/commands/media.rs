//! Sub-feature 7 — Media metadata + `mortar-pestle-asset://` host commands.
//!
//! 17 `#[tauri::command]` fns covering music/video readers + writers. The 2
//! ffmpeg-transcoded video paths (`/api/video/stream`, `/api/video/subs`) are
//! deferred to Sub-feature 7.5 — Tauri 2.11's protocol response API requires
//! buffered `Cow<'static, [u8]>` bodies (no native stream-into-response).
//!
//! The `mortar-pestle-asset://` URI scheme is registered in `lib.rs::run` and served
//! from `crate::asset_protocol`; this module owns the `media_roots()` config
//! consulted by both the protocol handler and any future absolute-path
//! command (e.g. probe).

use std::path::PathBuf;
use std::sync::OnceLock;


use crate::commands::vault::{vault_root, VaultError};
use crate::parsers::{albums, probe_cache, series};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Lazy-parse `AGENTIC_MEDIA_ROOTS` (colon-separated absolute paths) into a
/// vector of canonicalized roots. Mirrors Node's `config.mediaRoots` from
/// `server/src/config.js:17` — colon-separated for Unix parity. When the env
/// var is unset or yields no valid roots, falls back to `<home>/Anime`,
/// matching Fastify's default. Tests can override per-process by setting the
/// env var before any media command runs.
pub fn media_roots() -> &'static Vec<PathBuf> {
    static CELL: OnceLock<Vec<PathBuf>> = OnceLock::new();
    CELL.get_or_init(|| {
        let raw = std::env::var("AGENTIC_MEDIA_ROOTS").unwrap_or_default();
        compute_media_roots(&raw, dirs::home_dir())
    })
}

fn compute_media_roots(env_value: &str, home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = env_value
        .split(':')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter_map(|s| std::fs::canonicalize(&s).ok())
        .collect();
    if roots.is_empty() {
        if let Some(home) = home {
            if let Ok(canon) = std::fs::canonicalize(home.join("Anime")) {
                roots.push(canon);
            }
        }
    }
    roots
}

// ─── Music ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn music_list_albums() -> Result<Vec<albums::AlbumSummary>, VaultError> {
    albums::list_albums()
}

#[tauri::command]
pub fn music_read_album(path: String) -> Result<albums::Album, VaultError> {
    albums::read_album(&path)
}

#[tauri::command]
pub fn music_search_tracks(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<albums::TrackHit>, VaultError> {
    albums::search_tracks(&query, limit.unwrap_or(30).clamp(1, 200))
}

#[tauri::command]
pub fn music_mark_status(
    path: String,
    status: String,
    base_mtime: Option<f64>,
) -> Result<albums::MarkStatusResponse, VaultError> {
    albums::mark_status(&path, &status, base_mtime)
}

#[tauri::command]
pub fn music_mark_rating(
    path: String,
    rating: f64,
    base_mtime: Option<f64>,
) -> Result<albums::MarkRatingResponse, VaultError> {
    albums::mark_rating(&path, rating, base_mtime)
}

#[tauri::command]
pub fn music_set_notes(
    path: String,
    notes: String,
    base_mtime: Option<f64>,
) -> Result<albums::NotesResponse, VaultError> {
    albums::write_notes(&path, &notes, base_mtime)
}

#[tauri::command]
pub fn music_delete_album(app: AppHandle, path: String) -> Result<(), VaultError> {
    let f = albums::collect_album_files(&path)?;
    // Albums live under the `library` mount; the local cover + the whole
    // track-audio folder ride into the recycling bin with the card as ONE
    // restorable item.
    crate::commands::recycle_bin::trash_album(
        &app,
        Some("library".into()),
        &f.card_rel,
        &f.card_abs,
        &f.sidecars,
        f.track_folder,
    )
}

// ─── Video ──────────────────────────────────────────────────────────────────

/// Lists one domain's series catalog — `"Anime"` (the default, so every existing
/// call site is unchanged) or `"TV Shows"`. Both share `parsers::series`; only
/// the catalog folder differs.
///
/// Also arms the airing-episode poller (once per app run) — the first time the
/// library is listed is the first moment anime matters in a session, and it
/// keeps the arming out of the currently foreign-dirty `lib.rs`. Only the Anime
/// domain arms it; the poller's backlog sweep is Nyaa-specific.
#[tauri::command]
pub fn video_list_series(
    app: tauri::AppHandle,
    domain: Option<String>,
) -> Result<Vec<series::SeriesSummary>, VaultError> {
    let domain = domain.as_deref().unwrap_or(series::DEFAULT_DOMAIN);
    if domain == series::DEFAULT_DOMAIN {
        crate::commands::anime_download::arm_airing_poll(app);
    }
    series::list_series(domain)
}

#[tauri::command]
pub fn video_read_series(path: String) -> Result<series::Series, VaultError> {
    series::read_series(&path)
}

#[tauri::command]
pub fn video_probe(path: String) -> Result<probe_cache::ProbeResult, VaultError> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err(VaultError::Invalid(
            "video_probe expects an absolute path".into(),
        ));
    }
    let canonical = std::fs::canonicalize(&p)
        .map_err(|_| VaultError::NotFound(path.clone()))?;
    if !is_under_allowed_root(&canonical) {
        return Err(VaultError::Invalid(
            "Path is not under an allowed media root".into(),
        ));
    }
    probe_cache::probe(&canonical)
}

#[tauri::command]
pub fn video_mark_episode_watched(
    series_path: String,
    episode: i64,
    season: Option<String>,
    base_mtime: Option<f64>,
) -> Result<series::MarkEpisodeResponse, VaultError> {
    series::mark_episode_watched(&series_path, episode, season.as_deref(), base_mtime)
}

/// `finished` is an optional `Finished:` watch date written in the same pass as
/// the status. A caller that omits it leaves the field alone — see
/// `series::mark_status`.
#[tauri::command]
pub fn video_mark_series_status(
    series_path: String,
    status: String,
    season: Option<String>,
    finished: Option<String>,
    base_mtime: Option<f64>,
) -> Result<series::MarkSeriesStatusResponse, VaultError> {
    series::mark_status(
        &series_path,
        &status,
        season.as_deref(),
        finished.as_deref(),
        base_mtime,
    )
}

#[tauri::command]
pub fn video_mark_series_rating(
    series_path: String,
    rating: f64,
    base_mtime: Option<f64>,
) -> Result<series::MarkSeriesRatingResponse, VaultError> {
    series::mark_rating(&series_path, rating, base_mtime)
}

// ─── Reveal-in-file-manager (Sub-feature 11) ────────────────────────────────

/// Open the host file manager with the given path highlighted. Mirrors the
/// containment check from Node's `POST /api/reveal` (`server/src/routes.js`):
/// vault-relative paths resolve against `vault_root()`; absolute paths stay
/// absolute; canonical form must sit under the vault or one of the configured
/// `media_roots()`. Behavior diverges from Node deliberately — Node used
/// `xdg-open` (which *opens* the file in its default application), this uses
/// the opener plugin's `reveal_item_in_dir` (which *highlights* the file in
/// the OS file manager). The function name `revealInFiles` always meant the
/// latter; Node was misnamed.
#[tauri::command]
pub fn reveal_in_files(app: tauri::AppHandle, path: String) -> Result<(), VaultError> {
    if path.is_empty() {
        return Err(VaultError::Invalid("path required".into()));
    }
    let abs = if path.starts_with('/') {
        PathBuf::from(&path)
    } else {
        PathBuf::from(vault_root()).join(&path)
    };
    let canonical = std::fs::canonicalize(&abs)
        .map_err(|_| VaultError::NotFound(format!("Path not found: {path}")))?;
    if !is_under_allowed_root(&canonical) {
        return Err(VaultError::Invalid("path not under an allowed root".into()));
    }
    app.opener()
        .reveal_item_in_dir(&canonical)
        .map_err(|e| VaultError::Io(e.to_string()))
}

/// Open the host file manager INTO the given path — for a folder, it shows the
/// folder's contents (the "open into" counterpart to `reveal_in_files`, which
/// *highlights* an item inside its parent). Same containment check. The tree
/// sidebars' "Reveal in files" button uses this for folder targets (vault root,
/// the Library / Skills / Docs folders) and `reveal_in_files` for a single file.
#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String, root: Option<String>) -> Result<(), VaultError> {
    if path.is_empty() {
        return Err(VaultError::Invalid("path required".into()));
    }
    // A relative path resolves against the named mount (content default, or
    // app/pulse/library) so e.g. the Docs sidebar can open the App vault's Docs
    // folder without hardcoding an absolute home path. Absolute paths pass through.
    let abs = if path.starts_with('/') {
        PathBuf::from(&path)
    } else {
        let base = crate::commands::vault::RootKind::from_opt(root.as_deref()).root();
        PathBuf::from(base).join(&path)
    };
    let canonical = std::fs::canonicalize(&abs)
        .map_err(|_| VaultError::NotFound(format!("Path not found: {path}")))?;
    if !is_under_allowed_root(&canonical) {
        return Err(VaultError::Invalid("path not under an allowed root".into()));
    }
    app.opener()
        .open_path(canonical.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| VaultError::Io(e.to_string()))
}

// ─── Shared helper used by both probe + asset_protocol ──────────────────────

/// Check a canonicalized path against `vault_root()` + every `media_roots()`
/// entry. The asset-protocol handler enforces this on every request; the
/// `video_probe` command enforces it before spawning ffprobe to keep
/// untrusted callers from reading arbitrary files.
pub fn is_under_allowed_root(canonical: &std::path::Path) -> bool {
    let vault = std::fs::canonicalize(crate::commands::vault::vault_root()).ok();
    if let Some(v) = vault {
        if canonical.starts_with(&v) {
            return true;
        }
    }
    // Library vault (writable media catalogs — Library Migration Phase 2). Album
    // / playlist audio + playlist covers live here, outside vault_root().
    let library = std::fs::canonicalize(crate::commands::vault::library_vault_root()).ok();
    if let Some(l) = library {
        if canonical.starts_with(&l) {
            return true;
        }
    }
    // App vault (Mortar & Pestle Docs / Decisions / DESIGN.md) — read by the Docs
    // sidebar's "Reveal in files". Lives outside vault_root(), under the app's
    // config dir, so it needs its own allowance.
    let app_vault = std::fs::canonicalize(crate::commands::vault::app_vault_root()).ok();
    if let Some(a) = app_vault {
        if canonical.starts_with(&a) {
            return true;
        }
    }
    // Game Capture clips live in `captures_dir()` (`%USERPROFILE%\Videos\Mortar & Pestle`
    // on Windows — decision #11), outside every vault root, so the media server /
    // asset protocol / reveal need an explicit allowance to serve clip + poster files.
    let captures = std::fs::canonicalize(crate::commands::vault::captures_dir()).ok();
    if let Some(c) = captures {
        if canonical.starts_with(&c) {
            return true;
        }
    }
    for root in media_roots() {
        if canonical.starts_with(root) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(prefix: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("mortar-pestle-media-roots-{prefix}-{stamp}"))
    }

    #[test]
    fn empty_env_falls_back_to_home_anime() {
        let home = unique_tmp("home");
        let anime = home.join("Anime");
        std::fs::create_dir_all(&anime).unwrap();
        let roots = compute_media_roots("", Some(home.clone()));
        let canon = std::fs::canonicalize(&anime).unwrap();
        assert_eq!(roots, vec![canon]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn explicit_env_takes_precedence_over_default() {
        let explicit = unique_tmp("explicit");
        let home = unique_tmp("home2");
        std::fs::create_dir_all(&explicit).unwrap();
        std::fs::create_dir_all(home.join("Anime")).unwrap();
        let canon = std::fs::canonicalize(&explicit).unwrap();
        let roots = compute_media_roots(canon.to_str().unwrap(), Some(home.clone()));
        assert_eq!(roots, vec![canon]);
        let _ = std::fs::remove_dir_all(&explicit);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_home_anime_yields_empty() {
        let home = unique_tmp("no-anime");
        std::fs::create_dir_all(&home).unwrap();
        let roots = compute_media_roots("", Some(home.clone()));
        assert!(roots.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}

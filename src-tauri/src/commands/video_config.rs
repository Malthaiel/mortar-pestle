//! Where downloaded anime **video files** are saved. Persists `{ videoRoot }`
//! in `video.json` under the app config dir. Empty /
//! unset = the default `<library>/Anime/Videos`. Cards, covers and episode
//! metadata are unaffected — only the big video folders relocate.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::vault::{self, VaultError};

const VIDEO_CONFIG_FILE: &str = "video.json";

/// Every field is `#[serde(default)]` so a `video.json` written before a field
/// existed still loads — the file is the user's, and an older one must never be
/// an error.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoStored {
    #[serde(default)]
    video_root: String,
    /// Torrent index addresses. **Empty by default, deliberately** — the app
    /// ships with nowhere to search and stays that way until the user supplies
    /// an address. See `Knowledge/Mortar & Pestle/Plans/Bring Your Own Source.md`.
    #[serde(default)]
    torrentio_base: String,
    #[serde(default)]
    eztv_base: String,
    #[serde(default)]
    nyaa_base: String,
}

/// The three index addresses, read in one pass because a search needs to know
/// about more than one of them before it can decide it has nowhere to look.
#[derive(Debug, Clone, Default)]
pub struct TorrentSources {
    pub torrentio: String,
    pub eztv: String,
    pub nyaa: String,
}

/// The user's configured index addresses. All-empty is the expected state of a
/// fresh install, not a fault.
pub fn torrent_sources(app: &AppHandle) -> TorrentSources {
    let s = load_stored(app);
    TorrentSources {
        torrentio: s.torrentio_base.trim().to_string(),
        eztv: s.eztv_base.trim().to_string(),
        nyaa: s.nyaa_base.trim().to_string(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoConfig {
    /// The user's choice verbatim; empty means "use the default".
    pub video_root: String,
    /// Where videos actually land right now — always an absolute path.
    pub effective_root: String,
    pub is_default: bool,
    pub torrentio_base: String,
    pub eztv_base: String,
    pub nyaa_base: String,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(crate::commands::sidebar::app_config_root(app)?.join(VIDEO_CONFIG_FILE))
}

fn load_stored(app: &AppHandle) -> VideoStored {
    let Ok(path) = config_path(app) else {
        return VideoStored::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return VideoStored::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// The save root for anime videos: the configured folder when set, else the
/// historical `<library>/Anime/Videos`. Files land directly at `<root>/<Series>`.
pub fn anime_video_root(app: &AppHandle, library: &str) -> PathBuf {
    let stored = load_stored(app);
    let chosen = stored.video_root.trim();
    if chosen.is_empty() {
        Path::new(library).join("Anime").join("Videos")
    } else {
        PathBuf::from(chosen)
    }
}

/// The save root for TV videos, a sibling of the anime one under the SAME
/// configured folder: `<video root>/TV Shows`, else `<library>/TV Shows/Videos`.
/// One setting covers both rooms — there is deliberately no separate TV folder
/// picker until anime and TV actually need to live on different drives.
///
/// A show's files land at `<root>/<Title>/<Season N>/`, which is what the
/// season-section reader already scans (`parsers/series.rs` joins the card's
/// `Local Path` with each section's name).
pub fn tv_video_root(app: &AppHandle, library: &str) -> PathBuf {
    room_video_root(app, library, "TV Shows")
}

/// The save root for films, the same arrangement one room over: `<video
/// root>/Movies`, else `<library>/Movies/Videos`. A film's file lands at
/// `<root>/<Title (Year)>/` — no season folder, since there are no seasons.
pub fn movies_video_root(app: &AppHandle, library: &str) -> PathBuf {
    room_video_root(app, library, "Movies")
}

/// Both Stremio rooms arrange their videos identically and differ only in the
/// folder they sit in, so they share one body rather than two near-copies.
fn room_video_root(app: &AppHandle, library: &str, room: &str) -> PathBuf {
    let stored = load_stored(app);
    let chosen = stored.video_root.trim();
    if chosen.is_empty() {
        Path::new(library).join(room).join("Videos")
    } else {
        PathBuf::from(chosen).join(room)
    }
}

#[tauri::command]
pub fn video_get_config(app: AppHandle) -> Result<VideoConfig, VaultError> {
    let stored = load_stored(&app);
    let video_root = stored.video_root.trim().to_string();
    let library = vault::library_vault_root();
    Ok(VideoConfig {
        is_default: video_root.is_empty(),
        effective_root: anime_video_root(&app, &library).to_string_lossy().into_owned(),
        video_root,
        torrentio_base: stored.torrentio_base,
        eztv_base: stored.eztv_base,
        nyaa_base: stored.nyaa_base,
    })
}

/// Patch, never replace: every field is optional and `None` leaves the stored
/// value alone. Whole-struct replacement was the old shape and would silently
/// wipe the index addresses every time the folder picker saved.
#[tauri::command]
pub fn video_set_config(
    app: AppHandle,
    video_root: Option<String>,
    torrentio_base: Option<String>,
    eztv_base: Option<String>,
    nyaa_base: Option<String>,
) -> Result<(), VaultError> {
    let mut stored = load_stored(&app);
    for (field, value) in [
        (&mut stored.video_root, video_root),
        (&mut stored.torrentio_base, torrentio_base),
        (&mut stored.eztv_base, eztv_base),
        (&mut stored.nyaa_base, nyaa_base),
    ] {
        if let Some(v) = value {
            *field = v.trim().to_string();
        }
    }
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| VaultError::Io(format!("mkdir {parent:?}: {e}")))?;
    }
    let mut text = serde_json::to_string_pretty(&stored)
        .map_err(|e| VaultError::Io(format!("serialize video.json: {e}")))?;
    text.push('\n');
    vault::atomic_write(&path, text.as_bytes())
}

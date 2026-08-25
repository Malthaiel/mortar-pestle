//! Where downloaded anime **video files** are saved. Persists `{ videoRoot }`
//! in `video.json` under the app config dir. Empty /
//! unset = the default `<library>/Anime/Videos`. Cards, covers and episode
//! metadata are unaffected — only the big video folders relocate.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::vault::{self, VaultError};

const VIDEO_CONFIG_FILE: &str = "video.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoStored {
    #[serde(default)]
    video_root: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoConfig {
    /// The user's choice verbatim; empty means "use the default".
    pub video_root: String,
    /// Where videos actually land right now — always an absolute path.
    pub effective_root: String,
    pub is_default: bool,
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

#[tauri::command]
pub fn video_get_config(app: AppHandle) -> Result<VideoConfig, VaultError> {
    let video_root = load_stored(&app).video_root.trim().to_string();
    let library = vault::library_vault_root();
    Ok(VideoConfig {
        is_default: video_root.is_empty(),
        effective_root: anime_video_root(&app, &library).to_string_lossy().into_owned(),
        video_root,
    })
}

#[tauri::command]
pub fn video_set_config(app: AppHandle, video_root: String) -> Result<(), VaultError> {
    let stored = VideoStored {
        video_root: video_root.trim().to_string(),
    };
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

//! User-curated music playlist commands.
//!
//! Thin wrappers over `parsers::playlists`. Playlist hub pages + cover images
//! are written under `Knowledge/Music/Playlists/`; reads resolve each track row
//! to a play-ready object (audio path + resolved album cover). Page writes reuse
//! the vault's atomic write; the cover is a raw `Vec<u8>` sent from the webview's
//! file picker.

use tauri::AppHandle;

use crate::commands::recycle_bin;
use crate::commands::vault::VaultError;
use crate::parsers::playlists::{self, Playlist, PlaylistSummary, TrackRefInput};

#[tauri::command]
pub fn music_list_playlists() -> Result<Vec<PlaylistSummary>, VaultError> {
    playlists::list_playlists()
}

#[tauri::command]
pub fn music_read_playlist(path: String) -> Result<Playlist, VaultError> {
    playlists::read_playlist(&path)
}

#[tauri::command]
pub fn music_write_playlist(
    title: String,
    tracks: Vec<TrackRefInput>,
    original_path: Option<String>,
    cover_path: Option<String>,
) -> Result<Playlist, VaultError> {
    playlists::write_playlist(&title, tracks, original_path, cover_path)
}

#[tauri::command]
pub fn music_save_playlist_cover(
    title: String,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, VaultError> {
    playlists::save_playlist_cover(&title, bytes, &ext)
}

#[tauri::command]
pub fn music_delete_playlist(app: AppHandle, path: String) -> Result<(), VaultError> {
    let files = playlists::collect_playlist_files(&path)?;
    let (card_rel, card_abs) = files[0].clone();
    // Playlists live under the `library` mount; covers ride along as sidecars.
    recycle_bin::trash_playlist(&app, Some("library".into()), &card_rel, &card_abs, &files[1..])
}

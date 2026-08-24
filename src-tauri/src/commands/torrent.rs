//! Built-in BitTorrent engine (librqbit), replacing the external qBittorrent
//! Web UI for the Anime download pipeline.
//!
//! One process instead of five: the old path was app → `download_anime.py` →
//! `qbittorrent_client.py` → HTTP → qBittorrent → disk, and every hop was a
//! place a path, a login or a port could break it. See
//! `Knowledge/Mortar & Pestle/Plans/Built-in Torrent Engine.md`.
//!
//! Seeding policy (locked in the plan): seed **while downloading**, stop on
//! completion. `watch_until_finished` pauses each torrent the moment it
//! finishes so nothing uploads forever in the background.

use std::path::PathBuf;
use std::sync::Arc;

use librqbit::api::TorrentIdOrHash;
use librqbit::{AddTorrent, AddTorrentOptions, ManagedTorrent, Session};
use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::OnceCell;

/// One `Session` for the whole app, built on first use. Holds the DHT, the
/// listener and every managed torrent, so it must outlive individual downloads.
static SESSION: OnceCell<Arc<Session>> = OnceCell::const_new();

/// Where torrents land when an add doesn't name a folder: the configured anime
/// video root, same one `anime_download` uses.
fn default_output_folder(app: &AppHandle) -> PathBuf {
    let library = crate::commands::vault::library_vault_root();
    crate::commands::video_config::anime_video_root(app, &library)
}

/// The shared session, created on first call.
///
/// ponytail: no `SessionPersistence` yet — a download interrupted by an app
/// restart starts over rather than resuming. Add `SessionOptions.persistence`
/// (JSON, under the app config dir) when restarts during a download actually
/// bite; it needs a folder and a schema decision, and SF1 doesn't need it.
async fn session(app: &AppHandle) -> Result<Arc<Session>, String> {
    SESSION
        .get_or_try_init(|| async {
            let root = default_output_folder(app);
            // The engine writes here directly, so a missing/unplugged drive must
            // surface now rather than as a torrent that silently never writes.
            std::fs::create_dir_all(&root)
                .map_err(|e| format!("torrent output folder unavailable ({}): {e}", root.display()))?;
            Session::new(root)
                .await
                .map_err(|e| format!("failed to start the torrent engine: {e}"))
        })
        .await
        .cloned()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentAdded {
    pub id: usize,
    pub info_hash: String,
    pub name: Option<String>,
}

/// One torrent's live numbers. Field names mirror what the old qBittorrent
/// `state` call returned, so the anime poll loop reads the same shape.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentStat {
    pub id: usize,
    pub info_hash: String,
    pub name: Option<String>,
    /// 0.0 - 1.0. Zero total (metadata still resolving) reports 0.
    pub progress: f64,
    pub size: u64,
    pub completed: u64,
    /// Bytes per second, measured by the engine — 0 while paused or initializing.
    pub dlspeed: u64,
    /// Seconds remaining, derived from the measured speed. `None` when stalled
    /// or finished — never a guess.
    pub eta: Option<u64>,
    pub state: String,
    pub finished: bool,
    pub error: Option<String>,
}

fn stat_of(handle: &Arc<ManagedTorrent>) -> TorrentStat {
    let s = handle.stats();
    let dlspeed = s.live.as_ref().map(|l| l.download_speed.as_bytes()).unwrap_or(0);
    let remaining = s.total_bytes.saturating_sub(s.progress_bytes);
    TorrentStat {
        id: handle.id(),
        info_hash: handle.info_hash().as_string(),
        name: handle.name(),
        progress: if s.total_bytes == 0 {
            0.0
        } else {
            s.progress_bytes as f64 / s.total_bytes as f64
        },
        size: s.total_bytes,
        completed: s.progress_bytes,
        dlspeed,
        eta: (dlspeed > 0 && remaining > 0).then(|| remaining / dlspeed),
        state: s.state.to_string(),
        finished: s.finished,
        error: s.error,
    }
}

/// Seed while downloading, stop on completion — pause the torrent the moment it
/// finishes so nothing uploads forever in the background.
fn watch_until_finished(session: Arc<Session>, handle: Arc<ManagedTorrent>) {
    tokio::spawn(async move {
        if let Err(e) = handle.wait_until_completed().await {
            log::warn!("[torrent] {} never completed: {e}", handle.info_hash().as_string());
            return;
        }
        if let Err(e) = session.pause(&handle).await {
            log::warn!("[torrent] finished but could not stop seeding {}: {e}", handle.info_hash().as_string());
        }
    });
}

/// Add a magnet (or a `.torrent` URL / local path). `output_dir` overrides the
/// session default — the anime pipeline passes the per-series folder.
#[tauri::command]
pub async fn torrent_add(
    app: AppHandle,
    magnet: String,
    output_dir: Option<String>,
) -> Result<TorrentAdded, String> {
    let session = session(&app).await?;
    let handle = session
        .add_torrent(
            AddTorrent::from_url(magnet),
            Some(AddTorrentOptions {
                // Resuming or re-downloading an episode must be allowed to write
                // over what's already on disk, otherwise a retry dead-ends.
                overwrite: true,
                output_folder: output_dir,
                ..Default::default()
            }),
        )
        .await
        .map_err(|e| format!("could not add the torrent: {e}"))?
        .into_handle()
        .ok_or_else(|| "the torrent was listed, not added".to_string())?;

    watch_until_finished(session, handle.clone());

    Ok(TorrentAdded {
        id: handle.id(),
        info_hash: handle.info_hash().as_string(),
        name: handle.name(),
    })
}

/// Live stats for every torrent the session manages. Callers filter by id or
/// info-hash — the engine is the single source of truth for progress.
#[tauri::command]
pub async fn torrent_state(app: AppHandle) -> Result<Vec<TorrentStat>, String> {
    let session = session(&app).await?;
    Ok(session.with_torrents(|it| it.map(|(_, h)| stat_of(h)).collect()))
}

/// Remove a torrent, optionally deleting what it wrote.
#[tauri::command]
pub async fn torrent_delete(app: AppHandle, id: usize, delete_files: bool) -> Result<(), String> {
    let session = session(&app).await?;
    session
        .delete(TorrentIdOrHash::Id(id), delete_files)
        .await
        .map_err(|e| format!("could not remove the torrent: {e}"))
}

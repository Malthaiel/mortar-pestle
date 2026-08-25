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
///
/// An explicit `output_dir` also makes the engine write **flat** into it
/// (`session.rs` picks the folder verbatim instead of appending the torrent's
/// own root name), which is what the anime pipeline's episode scan expects.
pub async fn add(
    app: &AppHandle,
    magnet: String,
    output_dir: Option<String>,
) -> Result<TorrentAdded, String> {
    let session = session(app).await?;
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

/// Live stats for every torrent the session manages.
pub async fn state(app: &AppHandle) -> Result<Vec<TorrentStat>, String> {
    let session = session(app).await?;
    Ok(session.with_torrents(|it| it.map(|(_, h)| stat_of(h)).collect()))
}

/// Live stats for a specific set of ids. An id the session no longer knows is
/// simply absent — callers treat an empty result as "gone", not as an error.
pub async fn stats_for(app: &AppHandle, ids: &[usize]) -> Result<Vec<TorrentStat>, String> {
    let session = session(app).await?;
    Ok(session.with_torrents(|it| {
        it.filter(|(id, _)| ids.contains(id)).map(|(_, h)| stat_of(h)).collect()
    }))
}

/// Remove every torrent writing into `folder`, optionally deleting the files.
/// Returns how many were removed.
///
/// This is the tag replacement: librqbit has no tags, so a series' torrents are
/// identified by the folder they were pointed at. Nothing is persisted across
/// restarts, so after one this finds nothing — which is the truth, since a
/// finished torrent was already paused and holds no resources.
pub async fn delete_under(
    app: &AppHandle,
    folder: &std::path::Path,
    delete_files: bool,
) -> Result<usize, String> {
    let session = session(app).await?;
    let ids: Vec<usize> =
        session.with_torrents(|it| it.filter(|(_, h)| h.output_folder() == folder).map(|(id, _)| id).collect());
    let mut removed = 0;
    for id in ids {
        match session.delete(TorrentIdOrHash::Id(id), delete_files).await {
            Ok(_) => removed += 1,
            Err(e) => log::warn!("[torrent] could not remove {id}: {e}"),
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn torrent_add(
    app: AppHandle,
    magnet: String,
    output_dir: Option<String>,
) -> Result<TorrentAdded, String> {
    add(&app, magnet, output_dir).await
}

#[tauri::command]
pub async fn torrent_state(app: AppHandle) -> Result<Vec<TorrentStat>, String> {
    state(&app).await
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// `delete_under` finds a series' torrents by comparing the engine's stored
    /// output folder against the card's `Local Path` — the replacement for
    /// qBittorrent's tags. That match is the whole mechanism, so the equality it
    /// relies on is pinned here: a silent mismatch would make uninstall quietly
    /// remove nothing at all.
    #[test]
    fn output_folder_match_survives_separator_and_trailing_slash() {
        let stored = Path::new(r"C:\Users\m\Videos\Anime\Show");
        assert_eq!(stored, Path::new("C:/Users/m/Videos/Anime/Show"));
        assert_eq!(stored, Path::new(r"C:\Users\m\Videos\Anime\Show\"));
        assert_eq!(stored, Path::new("C:/Users/m/Videos/Anime/Show/"));
        // Case still matters on Windows paths in Rust, and a different folder is
        // still a different folder — uninstall must not over-reach.
        assert_ne!(stored, Path::new(r"C:\Users\m\Videos\Anime\Show 2"));

        // The trap this actually hit: a card's `Local Path` is RELATIVE to the
        // library root, the engine's output folder is ABSOLUTE. They must never
        // compare equal, which is why `anime_uninstall` joins before matching —
        // without the join uninstall silently strands every torrent.
        assert_ne!(stored, Path::new(r"Videos\Anime\Show"));
        let library = Path::new(r"C:\Users\m");
        assert_eq!(stored, library.join(r"Videos\Anime\Show"));
    }
}

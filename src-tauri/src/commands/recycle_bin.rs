//! Global Recycling Bin — central, persistent soft-delete store.
//!
//! Every soft-deleted item across the app lands here as a *tombstone* (metadata
//! in `index.json`) plus its payload under `blobs/<id>/`. File-backed deletes
//! move the bytes into the blob (`content` for a file, `tree/` for a folder);
//! record-backed deletes (later phases) inline a serialized snapshot instead.
//! The store lives under app-config (`<app_config>/RecycleBin/`) so it survives
//! restarts, and it is the single source of truth — the React bin is a thin view
//! over these commands. Retention (age + count) is swept on app start and on bin
//! open, configured via `retention.json` (mirrored from Settings localStorage,
//! which Rust can't read directly).
//!
//! The tombstone *envelope* is fixed for all surfaces forever; adding a surface
//! is an additive `Source` / `RestoreStrategy` / `Payload` variant — no envelope
//! change. Phase 1 implements the vault file/folder strategies only.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::sidebar::app_config_root;
use crate::commands::vault::{atomic_write, RootKind, VaultError};

/// Serializes load→mutate→persist of `index.json` so concurrent deletes /
/// restores / purges can't interleave and drop a tombstone. Mirrors
/// `music_listen::WRITE_LOCK`; `Mutex::new` is const since 1.63.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

const SCHEMA_VERSION: u32 = 1;
const DEFAULT_RETENTION_DAYS: u64 = 30;
const DEFAULT_MAX_ITEMS: u64 = 200;

// ── Path helpers (under app-config, AGENTIC_APP_CONFIG_ROOT-overridable) ──

fn trash_root(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(app_config_root(app)?.join("RecycleBin"))
}
fn blobs_dir(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(trash_root(app)?.join("blobs"))
}
fn index_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(trash_root(app)?.join("index.json"))
}
fn retention_path(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(trash_root(app)?.join("retention.json"))
}

// ── Tombstone schema ──

/// Which surface a deleted item came from. Complete taxonomy (mirrors the bin's
/// source filter); only `Vault` is produced in Phase 1.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Vault,
    Planner,
    Pulse,
    Music,
    Anime,
    Studio,
}

/// How `recycle_bin_restore` re-applies an item. Phase 1 implements the two
/// vault strategies; `MusicPlaylist` (Phase 2) restores a card + its covers.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RestoreStrategy {
    VaultFile,
    VaultFolder,
    MusicPlaylist,
    MusicAlbum,
    Anime,
    /// A Video Editor project folder (Studio/Projects/<Name>) — restored
    /// whole via the generic blob-move path.
    VideoProject,
    /// A Game Capture clip (a single `.mp4` under Captures/) — restored via the
    /// generic single-file blob-move path.
    GameClip,
    /// A block of lines removed from inside a still-living markdown file (a
    /// Planner session or a Pulse quick note). Restores by re-inserting the
    /// saved text under its section heading — no blob is moved.
    RecordBlock,
}

/// Restore-specific data, discriminated by `kind`. The envelope never changes
/// when a surface is added — only this enum grows a variant.
#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Payload {
    #[serde(rename_all = "camelCase")]
    VaultFile {
        root: Option<String>,
        original_rel: String,
    },
    #[serde(rename_all = "camelCase")]
    VaultFolder {
        root: Option<String>,
        original_rel: String,
    },
    /// A music playlist: the `.md` card (blob `card`) plus its cover sidecars
    /// (blob `sidecars/<filename>`). Every path resolves under `root`.
    #[serde(rename_all = "camelCase")]
    MusicPlaylist {
        root: Option<String>,
        card_rel: String,
        sidecar_rels: Vec<String>,
    },
    /// A music album: the `.md` card (blob `card`), local cover sidecars (blob
    /// `sidecars/<filename>`), and the whole track-audio folder (blob `tracks/`).
    /// Every path resolves under `root`.
    #[serde(rename_all = "camelCase")]
    MusicAlbum {
        root: Option<String>,
        card_rel: String,
        sidecar_rels: Vec<String>,
        track_folder_rel: Option<String>,
    },
    /// An anime series: the `.md` card (blob `card`), local cover sidecar (blob
    /// `sidecars/<filename>`), and the video folder (blob `tracks/`). Restorable;
    /// the removed qBittorrent torrents + RSS rule are NOT (see the tombstone's
    /// `external_irreversible`).
    #[serde(rename_all = "camelCase")]
    Anime {
        root: Option<String>,
        card_rel: String,
        sidecar_rels: Vec<String>,
        video_folder_rel: Option<String>,
    },
    /// A Video Editor project: the whole project folder moves as blob `tree/`
    /// (project.json + any future per-project assets). Resolves under `root`
    /// (the `library` mount). Editor proxies are shared cache, NOT
    /// project-owned, so nothing external is lost (no `external_irreversible`).
    #[serde(rename_all = "camelCase")]
    VideoProject {
        root: Option<String>,
        folder_rel: String,
    },
    /// A Game Capture clip: a single `.mp4` whose bytes move to blob `content`.
    /// Resolves under `root` (the `library` mount). No sidecars — posters are not
    /// generated yet (3-SF4).
    #[serde(rename_all = "camelCase")]
    GameClip {
        root: Option<String>,
        clip_rel: String,
    },
    /// A record removed from inside a still-living markdown file — a block of
    /// lines under a section heading (a Planner session or a Pulse quick note).
    /// The removed text is the blob `record` file (NOT a moved payload); restore
    /// re-inserts it under `section_heading` near `line_hint`. It still owns a
    /// blob dir so the `recycle_bin_list` self-heal keeps it.
    #[serde(rename_all = "camelCase")]
    RecordBlock {
        root: Option<String>,
        file_rel: String,
        section_heading: String,
        line_hint: Option<u32>,
    },
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub id: String,
    pub schema_version: u32,
    pub source: Source,
    pub restore_strategy: RestoreStrategy,
    /// Row title, e.g. `Notes.md` or a folder name.
    pub label: String,
    /// Secondary row text — the original parent folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sublabel: Option<String>,
    /// RFC3339 UTC (sorts lexically = chronologically).
    pub deleted_at: String,
    pub size_bytes: u64,
    /// Folders: file count in the subtree. Files: `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_count: Option<u32>,
    /// Surfaced warning for side effects that can't be undone (e.g. a removed
    /// qBittorrent torrent in a later phase). `None` in Phase 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_irreversible: Option<String>,
    pub payload: Payload,
}

// ── Index R/W (callers hold INDEX_LOCK) ──

fn read_index_unlocked(app: &AppHandle) -> Vec<Tombstone> {
    let Ok(path) = index_path(app) else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_index_unlocked(app: &AppHandle, items: &[Tombstone]) -> Result<(), VaultError> {
    let path = index_path(app)?;
    let bytes = serde_json::to_vec_pretty(items).map_err(|e| VaultError::Io(e.to_string()))?;
    atomic_write(&path, &bytes) // creates parent dirs
}

fn append_tombstone(app: &AppHandle, t: Tombstone) -> Result<(), VaultError> {
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut items = read_index_unlocked(app);
    items.push(t); // oldest-first on disk; list reverses for display
    write_index_unlocked(app, &items)
}

// ── EXDEV-safe move (the one place silent data loss could occur) ──

/// True if `e` is a cross-filesystem-boundary rename error (`EXDEV` on Unix,
/// `ERROR_NOT_SAME_DEVICE` on Windows). Triggers the copy+remove fallback —
/// on Windows the bin / Library / vault can sit on different drive letters, so
/// this is a real path there, not just an edge case.
#[cfg(unix)]
fn is_cross_device(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(libc::EXDEV)
}
#[cfg(windows)]
fn is_cross_device(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(17) // ERROR_NOT_SAME_DEVICE
}

/// Move `src` → `dst`, falling back to copy+remove across filesystems (a vault
/// on a different device than app-config). Strict order: the source is only
/// unlinked after the copy fully succeeds, so a mid-copy failure leaves the
/// source intact and cleans up the partial destination.
fn move_path(src: &Path, dst: &Path) -> Result<(), VaultError> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| VaultError::Io(e.to_string()))?;
    }
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            if src.is_dir() {
                if let Err(err) = copy_dir_recursive(src, dst) {
                    let _ = fs::remove_dir_all(dst);
                    return Err(err);
                }
                fs::remove_dir_all(src).map_err(|e| VaultError::Io(e.to_string()))?;
            } else {
                fs::copy(src, dst).map_err(|e| VaultError::Io(e.to_string()))?;
                fs::remove_file(src).map_err(|e| VaultError::Io(e.to_string()))?;
            }
            Ok(())
        }
        Err(e) => Err(VaultError::Io(e.to_string())),
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), VaultError> {
    fs::create_dir_all(dst).map_err(|e| VaultError::Io(e.to_string()))?;
    for entry in fs::read_dir(src).map_err(|e| VaultError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| VaultError::Io(e.to_string()))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| VaultError::Io(e.to_string()))?;
        }
    }
    Ok(())
}

// ── Small helpers ──

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn leaf_name(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}
fn parent_dir(rel: &str) -> Option<String> {
    rel.rfind('/')
        .map(|i| rel[..i].to_string())
        .filter(|s| !s.is_empty())
}

/// Recursive (file count, total bytes) for a folder being trashed.
fn dir_stats(dir: &Path) -> (u32, u64) {
    let mut count = 0u32;
    let mut size = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                let (c, s) = dir_stats(&p);
                count += c;
                size += s;
            } else {
                count += 1;
                size += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (count, size)
}

/// `Name (restored).ext` — used when the original path is occupied and the user
/// chooses Rename.
fn suggested_rename(label: &str) -> String {
    match label.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} (restored).{ext}"),
        _ => format!("{label} (restored)"),
    }
}

/// Resolve a restore target, tolerant of a missing parent dir (the
/// `parent_missing` conflict case, where `vault::resolve_in` would error on
/// `canonicalize`). `rel` was produced by `resolve_in` at delete time, so it is
/// already normalized; the traversal check is belt-and-suspenders.
fn resolve_target(root_opt: &Option<String>, rel: &str) -> Result<PathBuf, VaultError> {
    if rel.split('/').any(|c| c == "..") {
        return Err(VaultError::Invalid("Restore path traversal".into()));
    }
    let kind = RootKind::from_opt(root_opt.as_deref());
    let root = fs::canonicalize(kind.root()).unwrap_or_else(|_| PathBuf::from(kind.root()));
    let abs = root.join(rel);
    if !abs.starts_with(&root) {
        return Err(VaultError::Invalid("Restore path escapes vault root".into()));
    }
    Ok(abs)
}

// ── Capture (called by the vault delete chokepoints) ──

/// Soft-delete a file: move its bytes into the bin + record a tombstone.
pub fn trash_file(
    app: &AppHandle,
    root: Option<String>,
    rel: &str,
    abs: &Path,
) -> Result<(), VaultError> {
    let size = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
    let id = new_id();
    let dest = blobs_dir(app)?.join(&id).join("content");
    move_path(abs, &dest)?;
    append_tombstone(
        app,
        Tombstone {
            id,
            schema_version: SCHEMA_VERSION,
            source: Source::Vault,
            restore_strategy: RestoreStrategy::VaultFile,
            label: leaf_name(rel),
            sublabel: parent_dir(rel),
            deleted_at: now_rfc3339(),
            size_bytes: size,
            item_count: None,
            external_irreversible: None,
            payload: Payload::VaultFile {
                root,
                original_rel: rel.to_string(),
            },
        },
    )
}

/// Soft-delete a folder as ONE bin item: move the whole subtree into the bin +
/// record a single tombstone (restoring brings it all back together).
pub fn trash_folder(
    app: &AppHandle,
    root: Option<String>,
    rel: &str,
    abs: &Path,
) -> Result<(), VaultError> {
    let (count, size) = dir_stats(abs);
    let id = new_id();
    let dest = blobs_dir(app)?.join(&id).join("tree");
    move_path(abs, &dest)?;
    append_tombstone(
        app,
        Tombstone {
            id,
            schema_version: SCHEMA_VERSION,
            source: Source::Vault,
            restore_strategy: RestoreStrategy::VaultFolder,
            label: leaf_name(rel),
            sublabel: parent_dir(rel),
            deleted_at: now_rfc3339(),
            size_bytes: size,
            item_count: Some(count),
            external_irreversible: None,
            payload: Payload::VaultFolder {
                root,
                original_rel: rel.to_string(),
            },
        },
    )
}

/// Soft-delete a Video Editor project folder as ONE bin item (Studio arm).
/// Clone of `trash_folder` that stamps the Studio source/strategy and returns
/// the tombstone id so the editor's delete Toast can offer a direct Restore.
pub fn trash_video_project(
    app: &AppHandle,
    root: Option<String>,
    rel: &str,
    abs: &Path,
) -> Result<String, VaultError> {
    let (count, size) = dir_stats(abs);
    let id = new_id();
    let dest = blobs_dir(app)?.join(&id).join("tree");
    move_path(abs, &dest)?;
    append_tombstone(
        app,
        Tombstone {
            id: id.clone(),
            schema_version: SCHEMA_VERSION,
            source: Source::Studio,
            restore_strategy: RestoreStrategy::VideoProject,
            label: leaf_name(rel),
            sublabel: parent_dir(rel),
            deleted_at: now_rfc3339(),
            size_bytes: size,
            item_count: Some(count),
            external_irreversible: None,
            payload: Payload::VideoProject {
                root,
                folder_rel: rel.to_string(),
            },
        },
    )?;
    Ok(id)
}

/// Soft-delete a Game Capture clip (a single `.mp4`) as ONE bin item (Studio arm).
/// Single-file variant of [`trash_video_project`]: the file's bytes move to blob
/// `content`; returns the tombstone id so the Capture page's undo Toast can offer
/// a direct Restore.
pub fn trash_clip(
    app: &AppHandle,
    root: Option<String>,
    rel: &str,
    abs: &Path,
) -> Result<String, VaultError> {
    let size = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
    let id = new_id();
    let dest = blobs_dir(app)?.join(&id).join("content");
    move_path(abs, &dest)?;
    append_tombstone(
        app,
        Tombstone {
            id: id.clone(),
            schema_version: SCHEMA_VERSION,
            source: Source::Studio,
            restore_strategy: RestoreStrategy::GameClip,
            label: leaf_name(rel),
            sublabel: parent_dir(rel),
            deleted_at: now_rfc3339(),
            size_bytes: size,
            item_count: None,
            external_irreversible: None,
            payload: Payload::GameClip {
                root,
                clip_rel: rel.to_string(),
            },
        },
    )?;
    Ok(id)
}

/// Soft-delete a music playlist as ONE bin item: the `.md` card plus every cover
/// sidecar move into the blob together and restore together. `sidecars` is
/// (vault-relative, absolute) pairs sharing the card's `root` (the `library`
/// mount). A cover that fails to move is left on disk and omitted — it never
/// aborts the delete.
pub fn trash_playlist(
    app: &AppHandle,
    root: Option<String>,
    card_rel: &str,
    card_abs: &Path,
    sidecars: &[(String, PathBuf)],
) -> Result<(), VaultError> {
    let id = new_id();
    let blob = blobs_dir(app)?.join(&id);
    let mut size = fs::metadata(card_abs).map(|m| m.len()).unwrap_or(0);
    move_path(card_abs, &blob.join("card"))?;
    let mut sidecar_rels: Vec<String> = Vec::new();
    for (rel, abs) in sidecars {
        let bytes = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
        if move_path(abs, &blob.join("sidecars").join(leaf_name(rel))).is_ok() {
            size += bytes;
            sidecar_rels.push(rel.clone());
        }
    }
    append_tombstone(
        app,
        Tombstone {
            id,
            schema_version: SCHEMA_VERSION,
            source: Source::Music,
            restore_strategy: RestoreStrategy::MusicPlaylist,
            label: leaf_name(card_rel),
            sublabel: parent_dir(card_rel),
            deleted_at: now_rfc3339(),
            size_bytes: size,
            item_count: None,
            external_irreversible: None,
            payload: Payload::MusicPlaylist {
                root,
                card_rel: card_rel.to_string(),
                sidecar_rels,
            },
        },
    )
}

/// Soft-delete a music album as ONE bin item: the `.md` card, its local cover
/// sidecars, and the entire track-audio folder move into the blob together and
/// restore together. `sidecars` is (vault-relative, absolute) cover pairs;
/// `track_folder` is the (vault-relative, absolute) audio folder (may be absent).
/// All share the card's `root` (the `library` mount). `item_count` is the audio
/// file count.
pub fn trash_album(
    app: &AppHandle,
    root: Option<String>,
    card_rel: &str,
    card_abs: &Path,
    sidecars: &[(String, PathBuf)],
    track_folder: Option<(String, PathBuf)>,
) -> Result<(), VaultError> {
    let id = new_id();
    let blob = blobs_dir(app)?.join(&id);
    let mut size = fs::metadata(card_abs).map(|m| m.len()).unwrap_or(0);
    move_path(card_abs, &blob.join("card"))?;
    let mut sidecar_rels: Vec<String> = Vec::new();
    for (rel, abs) in sidecars {
        let bytes = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
        if move_path(abs, &blob.join("sidecars").join(leaf_name(rel))).is_ok() {
            size += bytes;
            sidecar_rels.push(rel.clone());
        }
    }
    let mut track_folder_rel: Option<String> = None;
    let mut item_count: Option<u32> = None;
    if let Some((rel, abs)) = track_folder {
        if abs.is_dir() {
            let (count, bytes) = dir_stats(&abs);
            if move_path(&abs, &blob.join("tracks")).is_ok() {
                size += bytes;
                item_count = Some(count);
                track_folder_rel = Some(rel);
            }
        }
    }
    append_tombstone(
        app,
        Tombstone {
            id,
            schema_version: SCHEMA_VERSION,
            source: Source::Music,
            restore_strategy: RestoreStrategy::MusicAlbum,
            label: leaf_name(card_rel),
            sublabel: parent_dir(card_rel),
            deleted_at: now_rfc3339(),
            size_bytes: size,
            item_count,
            external_irreversible: None,
            payload: Payload::MusicAlbum {
                root,
                card_rel: card_rel.to_string(),
                sidecar_rels,
                track_folder_rel,
            },
        },
    )
}

/// Soft-delete an anime series as ONE bin item: the `.md` card, its local cover
/// sidecar, and (when supplied) the video folder move into the blob together and
/// restore together. `external` records side effects the bin can't undo (removed
/// qBittorrent torrents / RSS rule) — surfaced on the item.
pub fn trash_anime(
    app: &AppHandle,
    root: Option<String>,
    card_rel: &str,
    card_abs: &Path,
    sidecars: &[(String, PathBuf)],
    video_folder: Option<(String, PathBuf)>,
    external: Option<String>,
) -> Result<(), VaultError> {
    let id = new_id();
    let blob = blobs_dir(app)?.join(&id);
    let mut size = fs::metadata(card_abs).map(|m| m.len()).unwrap_or(0);
    move_path(card_abs, &blob.join("card"))?;
    let mut sidecar_rels: Vec<String> = Vec::new();
    for (rel, abs) in sidecars {
        let bytes = fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
        if move_path(abs, &blob.join("sidecars").join(leaf_name(rel))).is_ok() {
            size += bytes;
            sidecar_rels.push(rel.clone());
        }
    }
    let mut video_folder_rel: Option<String> = None;
    let mut item_count: Option<u32> = None;
    if let Some((rel, abs)) = video_folder {
        if abs.is_dir() {
            let (count, bytes) = dir_stats(&abs);
            if move_path(&abs, &blob.join("tracks")).is_ok() {
                size += bytes;
                item_count = Some(count);
                video_folder_rel = Some(rel);
            }
        }
    }
    append_tombstone(
        app,
        Tombstone {
            id,
            schema_version: SCHEMA_VERSION,
            source: Source::Anime,
            restore_strategy: RestoreStrategy::Anime,
            label: leaf_name(card_rel),
            sublabel: parent_dir(card_rel),
            deleted_at: now_rfc3339(),
            size_bytes: size,
            item_count,
            external_irreversible: external,
            payload: Payload::Anime {
                root,
                card_rel: card_rel.to_string(),
                sidecar_rels,
                video_folder_rel,
            },
        },
    )
}

/// Soft-delete a *record* — text removed from inside a still-living file (a
/// session block, a quick-note bullet, or a frontmatter value). Unlike the
/// file-backed helpers there is no source file to move: the caller passes the
/// exact removed bytes, which are written to the blob `record` file. The
/// destructive in-file edit is the caller's to perform *after* this returns
/// (capture-before-destroy — a failed edit then leaves a visible
/// duplicate-on-restore, never silent loss). The blob dir keeps the tombstone
/// alive through the `recycle_bin_list` self-heal. Returns the new tombstone id.
#[allow(clippy::too_many_arguments)]
pub fn trash_record(
    app: &AppHandle,
    source: Source,
    strategy: RestoreStrategy,
    label: String,
    sublabel: Option<String>,
    record_bytes: &[u8],
    payload: Payload,
) -> Result<String, VaultError> {
    let id = new_id();
    let dest = blobs_dir(app)?.join(&id).join("record");
    atomic_write(&dest, record_bytes)?; // creates parent dirs
    append_tombstone(
        app,
        Tombstone {
            id: id.clone(),
            schema_version: SCHEMA_VERSION,
            source,
            restore_strategy: strategy,
            label,
            sublabel,
            deleted_at: now_rfc3339(),
            size_bytes: record_bytes.len() as u64,
            item_count: None,
            external_irreversible: None,
            payload,
        },
    )?;
    Ok(id)
}

// ── Commands ──

/// Snapshot a still-living vault file into the bin WITHOUT deleting it — the
/// recoverable pre-edit backup for an in-place rewrite (e.g. the Concierge
/// organize-md recipe). Capture-before-destroy: the caller overwrites the file
/// only after this returns Ok, so a failed rewrite leaves the file intact + a
/// harmless extra backup. The copy lands at the standard `content` blob, so it
/// restores via the normal VaultFile path — re-applying it over the rewritten
/// file goes through the usual occupied-conflict prompt (i.e. "undo the rewrite").
#[tauri::command]
pub fn recycle_bin_snapshot(
    app: AppHandle,
    path: String,
    root: Option<String>,
) -> Result<String, VaultError> {
    if path.is_empty() || path.split('/').any(|c| c == "..") {
        return Err(VaultError::Invalid("Invalid snapshot path".into()));
    }
    let abs = resolve_target(&root, &path)?;
    if !abs.is_file() {
        return Err(VaultError::NotFound(format!("snapshot target {path}")));
    }
    let size = fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
    let id = new_id();
    let dest = blobs_dir(&app)?.join(&id).join("content");
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| VaultError::Io(e.to_string()))?;
    }
    fs::copy(&abs, &dest).map_err(|e| VaultError::Io(e.to_string()))?;
    append_tombstone(
        &app,
        Tombstone {
            id: id.clone(),
            schema_version: SCHEMA_VERSION,
            source: Source::Vault,
            restore_strategy: RestoreStrategy::VaultFile,
            label: leaf_name(&path),
            sublabel: parent_dir(&path),
            deleted_at: now_rfc3339(),
            size_bytes: size,
            item_count: None,
            external_irreversible: None,
            payload: Payload::VaultFile {
                root,
                original_rel: path.clone(),
            },
        },
    )?;
    Ok(id)
}

#[tauri::command]
pub fn recycle_bin_list(app: AppHandle) -> Result<Vec<Tombstone>, VaultError> {
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let items = read_index_unlocked(&app);
    // Self-heal: drop tombstones whose blob payload vanished (manual wipe / crash).
    let blobs = blobs_dir(&app)?;
    let (mut live, dead): (Vec<Tombstone>, Vec<Tombstone>) =
        items.into_iter().partition(|t| blobs.join(&t.id).exists());
    if !dead.is_empty() {
        write_index_unlocked(&app, &live)?;
    }
    live.reverse(); // newest-first for display
    Ok(live)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinPreview {
    /// "markdown" | "text" | "binary" | "folder"
    pub kind: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree: Option<Vec<String>>,
}

#[tauri::command]
pub fn recycle_bin_read(app: AppHandle, id: String) -> Result<BinPreview, VaultError> {
    let t = {
        let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read_index_unlocked(&app)
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| VaultError::NotFound(format!("bin item {id}")))?
    };
    let blob = blobs_dir(&app)?.join(&t.id);
    match t.restore_strategy {
        RestoreStrategy::VaultFile => {
            let bytes = fs::read(blob.join("content")).map_err(|e| VaultError::Io(e.to_string()))?;
            let lower = t.label.to_lowercase();
            if lower.ends_with(".md") || lower.ends_with(".markdown") {
                let src = String::from_utf8_lossy(&bytes);
                Ok(BinPreview {
                    kind: "markdown".into(),
                    title: t.label,
                    html: Some(crate::render::markdown::render_string(&src)),
                    text: None,
                    tree: None,
                })
            } else if let Ok(text) = String::from_utf8(bytes) {
                Ok(BinPreview {
                    kind: "text".into(),
                    title: t.label,
                    html: None,
                    text: Some(text),
                    tree: None,
                })
            } else {
                Ok(BinPreview {
                    kind: "binary".into(),
                    title: t.label,
                    html: None,
                    text: None,
                    tree: None,
                })
            }
        }
        RestoreStrategy::GameClip => {
            // A clip is a (possibly multi-GB) .mp4 — never read it into memory for a
            // preview; the bin row just shows it as a binary item.
            Ok(BinPreview {
                kind: "binary".into(),
                title: t.label,
                html: None,
                text: None,
                tree: None,
            })
        }
        RestoreStrategy::VaultFolder | RestoreStrategy::VideoProject => {
            let base = blob.join("tree");
            Ok(BinPreview {
                kind: "folder".into(),
                title: t.label,
                html: None,
                text: None,
                tree: Some(list_tree(&base, &base)),
            })
        }
        RestoreStrategy::MusicPlaylist | RestoreStrategy::MusicAlbum | RestoreStrategy::Anime => {
            let bytes = fs::read(blob.join("card")).map_err(|e| VaultError::Io(e.to_string()))?;
            let src = String::from_utf8_lossy(&bytes);
            Ok(BinPreview {
                kind: "markdown".into(),
                title: t.label,
                html: Some(crate::render::markdown::render_string(&src)),
                text: None,
                tree: None,
            })
        }
        RestoreStrategy::RecordBlock => {
            let bytes = fs::read(blob.join("record")).map_err(|e| VaultError::Io(e.to_string()))?;
            let src = String::from_utf8_lossy(&bytes);
            Ok(BinPreview {
                kind: "markdown".into(),
                title: t.label,
                html: Some(crate::render::markdown::render_string(&src)),
                text: None,
                tree: None,
            })
        }
    }
}

fn list_tree(base: &Path, dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().to_string();
            if p.is_dir() {
                out.push(format!("{rel}/"));
                out.extend(list_tree(base, &p));
            } else {
                out.push(rel);
            }
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOut {
    /// "restored" | "skipped" | "conflict"
    pub status: String,
    /// "occupied" | "parent_missing" (when status == "conflict")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_rel: Option<String>,
}

/// Restore an item. `conflict` ∈ {overwrite, rename, skip}; with `conflict=None`
/// and a real conflict, returns a `conflict` status so the frontend can prompt
/// and re-call. Rust stays stateless across the prompt.
#[tauri::command]
pub fn recycle_bin_restore(
    app: AppHandle,
    id: String,
    conflict: Option<String>,
    rename_to: Option<String>,
) -> Result<RestoreOut, VaultError> {
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let items = read_index_unlocked(&app);
    let idx = items
        .iter()
        .position(|t| t.id == id)
        .ok_or_else(|| VaultError::NotFound(format!("bin item {id}")))?;
    let t = items[idx].clone();
    let blob_root = blobs_dir(&app)?.join(&t.id);

    // Record surfaces (a block removed from inside a living file) restore by
    // re-inserting text into the host file, never via the blob-move path below.
    if let Payload::RecordBlock { .. } = &t.payload {
        return restore_record(&app, items, idx, &t, conflict.as_deref());
    }

    let (root_opt, original_rel, blob_payload, is_dir, sidecar_rels, track_folder_rel) = match &t.payload {
        Payload::VaultFile { root, original_rel } => {
            (root.clone(), original_rel.clone(), blob_root.join("content"), false, Vec::new(), None)
        }
        Payload::VaultFolder { root, original_rel } => {
            (root.clone(), original_rel.clone(), blob_root.join("tree"), true, Vec::new(), None)
        }
        Payload::MusicPlaylist { root, card_rel, sidecar_rels } => {
            (root.clone(), card_rel.clone(), blob_root.join("card"), false, sidecar_rels.clone(), None)
        }
        Payload::MusicAlbum { root, card_rel, sidecar_rels, track_folder_rel } => {
            (root.clone(), card_rel.clone(), blob_root.join("card"), false, sidecar_rels.clone(), track_folder_rel.clone())
        }
        Payload::Anime { root, card_rel, sidecar_rels, video_folder_rel } => {
            (root.clone(), card_rel.clone(), blob_root.join("card"), false, sidecar_rels.clone(), video_folder_rel.clone())
        }
        Payload::VideoProject { root, folder_rel } => {
            (root.clone(), folder_rel.clone(), blob_root.join("tree"), true, Vec::new(), None)
        }
        Payload::GameClip { root, clip_rel } => {
            (root.clone(), clip_rel.clone(), blob_root.join("content"), false, Vec::new(), None)
        }
        Payload::RecordBlock { .. } => unreachable!("record payloads return early via restore_record"),
    };

    let target = resolve_target(&root_opt, &original_rel)?;
    let parent_missing = target.parent().map(|p| !p.exists()).unwrap_or(false);
    let occupied = target.exists();
    let choice = conflict.as_deref();

    // Conflict gates — only when the caller hasn't already chosen.
    if parent_missing && choice.is_none() {
        return Ok(RestoreOut {
            status: "conflict".into(),
            conflict_kind: Some("parent_missing".into()),
            suggested_name: None,
            restored_rel: None,
        });
    }
    if occupied && choice.is_none() {
        return Ok(RestoreOut {
            status: "conflict".into(),
            conflict_kind: Some("occupied".into()),
            suggested_name: Some(suggested_rename(&t.label)),
            restored_rel: None,
        });
    }
    if occupied && choice == Some("skip") {
        return Ok(RestoreOut {
            status: "skipped".into(),
            conflict_kind: None,
            suggested_name: None,
            restored_rel: None,
        });
    }

    // Final destination: original path, or a sibling rename on Rename.
    let final_target = if occupied && choice == Some("rename") {
        let name = rename_to.unwrap_or_else(|| suggested_rename(&t.label));
        target
            .parent()
            .map(|p| p.join(&name))
            .unwrap_or_else(|| PathBuf::from(&name))
    } else {
        target.clone()
    };

    // Recreate any missing parent dirs (covers parent_missing + rename).
    if let Some(parent) = final_target.parent() {
        fs::create_dir_all(parent).map_err(|e| VaultError::Io(e.to_string()))?;
    }
    // Never silently clobber: only an explicit Overwrite removes an existing
    // destination. A Rename onto an already-taken name (or any now-occupied
    // path) re-prompts as a conflict instead of overwriting.
    if final_target.exists() {
        if choice == Some("overwrite") {
            if is_dir {
                fs::remove_dir_all(&final_target).map_err(|e| VaultError::Io(e.to_string()))?;
            } else {
                fs::remove_file(&final_target).map_err(|e| VaultError::Io(e.to_string()))?;
            }
        } else {
            return Ok(RestoreOut {
                status: "conflict".into(),
                conflict_kind: Some("occupied".into()),
                suggested_name: Some(suggested_rename(&t.label)),
                restored_rel: None,
            });
        }
    }

    move_path(&blob_payload, &final_target)?;

    // Music playlist: bring the cover sidecars back alongside the card — before
    // the blob dir is wiped below. Non-clobbering: a cover whose original path is
    // now occupied is left behind (discarded with the blob) rather than
    // overwriting another playlist's art, EXCEPT when the card was Overwritten
    // (then its matching cover is replaced too). Covers are derived art, so a
    // skipped one only means the restored playlist falls back to its collage.
    for rel in &sidecar_rels {
        let src = blob_root.join("sidecars").join(leaf_name(rel));
        if !src.exists() {
            continue;
        }
        let Ok(dst) = resolve_target(&root_opt, rel) else { continue };
        if dst.exists() {
            if choice == Some("overwrite") {
                let _ = fs::remove_file(&dst);
            } else {
                continue;
            }
        }
        if let Some(parent) = dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = move_path(&src, &dst);
    }

    // Music album: restore the whole track-audio folder alongside the card — same
    // non-clobbering rule as covers (overwrite only when the card was
    // overwritten). Runs before the blob dir is wiped below.
    if let Some(tf_rel) = &track_folder_rel {
        let src = blob_root.join("tracks");
        if src.is_dir() {
            if let Ok(dst) = resolve_target(&root_opt, tf_rel) {
                let proceed = if dst.exists() {
                    if choice == Some("overwrite") {
                        let _ = fs::remove_dir_all(&dst);
                        true
                    } else {
                        false
                    }
                } else {
                    true
                };
                if proceed {
                    if let Some(parent) = dst.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = move_path(&src, &dst);
                }
            }
        }
    }

    let mut items = items;
    items.remove(idx);
    write_index_unlocked(&app, &items)?;
    let _ = fs::remove_dir_all(&blob_root);

    let restored_rel = final_target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .or(Some(original_rel));
    Ok(RestoreOut {
        status: "restored".into(),
        conflict_kind: None,
        suggested_name: None,
        restored_rel,
    })
}

/// Restore a record-backed tombstone: splice the saved text back into its host
/// file under the section heading. No blob is moved. If the host file is gone we
/// surface a `parent_missing` conflict and otherwise no-op — we never recreate a
/// whole daily log to hold one restored line.
fn restore_record(
    app: &AppHandle,
    mut items: Vec<Tombstone>,
    idx: usize,
    t: &Tombstone,
    choice: Option<&str>,
) -> Result<RestoreOut, VaultError> {
    let blob_root = blobs_dir(app)?.join(&t.id);
    let record = fs::read(blob_root.join("record")).map_err(|e| VaultError::Io(e.to_string()))?;

    let (root_opt, file_rel, section_heading, line_hint) = match &t.payload {
        Payload::RecordBlock {
            root,
            file_rel,
            section_heading,
            line_hint,
        } => (root.clone(), file_rel.clone(), section_heading.clone(), *line_hint),
        _ => return Err(VaultError::Invalid("restore_record on non-record payload".into())),
    };

    let target = resolve_target(&root_opt, &file_rel)?;
    if !target.exists() {
        if choice.is_none() {
            return Ok(RestoreOut {
                status: "conflict".into(),
                conflict_kind: Some("parent_missing".into()),
                suggested_name: None,
                restored_rel: None,
            });
        }
        // Any choice on a missing host file is a no-op skip.
        return Ok(RestoreOut {
            status: "skipped".into(),
            conflict_kind: None,
            suggested_name: None,
            restored_rel: None,
        });
    }

    let content = fs::read_to_string(&target).map_err(|e| VaultError::Io(e.to_string()))?;
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();
    let block: Vec<String> = String::from_utf8_lossy(&record)
        .split('\n')
        .map(|s| s.to_string())
        .collect();

    if let Some(h) = lines.iter().position(|l| l.trim() == section_heading.trim()) {
        // Section present: insert at the clamped line hint (kept within the
        // section body), else at the section's end.
        let mut body_end = h + 1;
        while body_end < lines.len() && !lines[body_end].starts_with("## ") {
            body_end += 1;
        }
        let at = line_hint
            .map(|n| (n as usize).clamp(h + 1, body_end))
            .unwrap_or(body_end);
        let tail = lines.split_off(at);
        lines.extend(block);
        lines.extend(tail);
    } else {
        // Section gone: re-create the heading + block at EOF.
        if lines.last().map(|l| !l.trim().is_empty()).unwrap_or(false) {
            lines.push(String::new());
        }
        lines.push(section_heading.clone());
        lines.push(String::new());
        lines.extend(block);
    }

    atomic_write(&target, lines.join("\n").as_bytes())?;

    items.remove(idx);
    write_index_unlocked(app, &items)?;
    let _ = fs::remove_dir_all(&blob_root);
    Ok(RestoreOut {
        status: "restored".into(),
        conflict_kind: None,
        suggested_name: None,
        restored_rel: Some(file_rel),
    })
}

#[tauri::command]
pub fn recycle_bin_delete(app: AppHandle, id: String) -> Result<(), VaultError> {
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut items = read_index_unlocked(&app);
    let before = items.len();
    items.retain(|t| t.id != id);
    if items.len() == before {
        return Err(VaultError::NotFound(format!("bin item {id}")));
    }
    write_index_unlocked(&app, &items)?;
    let _ = fs::remove_dir_all(blobs_dir(&app)?.join(&id));
    Ok(())
}

#[tauri::command]
pub fn recycle_bin_empty(app: AppHandle) -> Result<u32, VaultError> {
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let n = read_index_unlocked(&app).len() as u32;
    write_index_unlocked(&app, &[])?;
    let _ = fs::remove_dir_all(blobs_dir(&app)?); // wipe all payloads
    Ok(n)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeReport {
    pub removed: u32,
    pub remaining: u32,
}

#[tauri::command]
pub fn recycle_bin_purge(
    app: AppHandle,
    max_age_days: u64,
    max_count: u64,
) -> Result<PurgeReport, VaultError> {
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    purge_inner(&app, max_age_days, max_count)
}

/// Drop items older than `max_age_days`, then trim oldest-first to `max_count`.
/// Unparseable timestamps are kept (never lose data on a bad clock).
fn purge_inner(app: &AppHandle, max_age_days: u64, max_count: u64) -> Result<PurgeReport, VaultError> {
    let mut items = read_index_unlocked(app); // oldest-first
    let mut removed_ids: Vec<String> = Vec::new();

    let cutoff = chrono::Utc::now() - chrono::Duration::days(max_age_days as i64);
    items.retain(|t| {
        let keep = chrono::DateTime::parse_from_rfc3339(&t.deleted_at)
            .map(|d| d.with_timezone(&chrono::Utc) >= cutoff)
            .unwrap_or(true);
        if !keep {
            removed_ids.push(t.id.clone());
        }
        keep
    });

    if max_count > 0 && items.len() as u64 > max_count {
        let overflow = items.len() - max_count as usize;
        for t in items.drain(0..overflow) {
            removed_ids.push(t.id);
        }
    }

    if !removed_ids.is_empty() {
        write_index_unlocked(app, &items)?;
        let blobs = blobs_dir(app)?;
        for id in &removed_ids {
            let _ = fs::remove_dir_all(blobs.join(id));
        }
    }
    Ok(PurgeReport {
        removed: removed_ids.len() as u32,
        remaining: items.len() as u32,
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Retention {
    days: u64,
    max_count: u64,
}

/// Mirror the Settings retention config to disk so the Rust startup-purge can
/// read it (Settings live in localStorage, unreadable from Rust).
#[tauri::command]
pub fn recycle_bin_set_retention(app: AppHandle, days: u64, max_count: u64) -> Result<(), VaultError> {
    let bytes = serde_json::to_vec_pretty(&Retention { days, max_count })
        .map_err(|e| VaultError::Io(e.to_string()))?;
    atomic_write(&retention_path(&app)?, &bytes)
}

fn read_retention(app: &AppHandle) -> Retention {
    retention_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Retention {
            days: DEFAULT_RETENTION_DAYS,
            max_count: DEFAULT_MAX_ITEMS,
        })
}

/// Best-effort retention sweep at app start. Reads `retention.json` (defaults if
/// absent), purges, and never errors out the setup path.
pub fn startup_purge(app: &AppHandle) -> PurgeReport {
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let r = read_retention(app);
    purge_inner(app, r.days, r.max_count).unwrap_or(PurgeReport {
        removed: 0,
        remaining: 0,
    })
}

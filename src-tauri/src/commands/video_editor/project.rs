// Video Editor — project storage commands (split from mod.rs, plan 026 B2).
// Projects are folders: <Library vault>/Studio/Projects/<Name>/project.json.
// Pure code motion; the `pub use project::*;` shim in mod.rs keeps every
// `commands::video_editor::vedit_project_*` path and ACL entry resolving.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::commands::vault::{atomic_write, library_vault_root, mtime_ms, VaultError};
use crate::parsers::playlists::sanitize_name;
use crate::parsers::editor_proxy;

pub fn projects_root() -> PathBuf {
    PathBuf::from(library_vault_root())
        .join("Studio")
        .join("Projects")
}

/// Sanitized folder name + project.json path for a user-facing project name.
pub fn project_paths(name: &str) -> Result<(String, PathBuf), VaultError> {
    let clean = sanitize_name(name);
    if clean.is_empty() {
        return Err(VaultError::Invalid(
            "Project name is empty after sanitizing".into(),
        ));
    }
    let file = projects_root().join(&clean).join("project.json");
    Ok((clean, file))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListEntry {
    pub name: String,
    pub mtime: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectReadOut {
    pub name: String,
    pub data: serde_json::Value,
    pub mtime: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWriteOut {
    pub ok: bool,
    pub name: String,
    pub mtime: f64,
}

// Async wrapper: run the (blocking) directory scan off the main-thread command
// path via spawn_blocking, so a future main-thread stall can't starve content
// loads (resilience hardening after the 2026-06-24 Windows browser deadlock).
#[tauri::command]
pub async fn vedit_project_list() -> Result<Vec<ProjectListEntry>, VaultError> {
    tauri::async_runtime::spawn_blocking(vedit_project_list_inner)
        .await
        .map_err(|e| VaultError::Io(e.to_string()))?
}

fn vedit_project_list_inner() -> Result<Vec<ProjectListEntry>, VaultError> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(projects_root()) else {
        return Ok(out); // no Studio/Projects yet — empty picker, not an error
    };
    for entry in rd.flatten() {
        let file = entry.path().join("project.json");
        if let Ok(meta) = fs::metadata(&file) {
            if meta.is_file() {
                out.push(ProjectListEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    mtime: mtime_ms(&meta),
                });
            }
        }
    }
    out.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

#[tauri::command]
pub fn vedit_project_read(name: String) -> Result<ProjectReadOut, VaultError> {
    let (clean, file) = project_paths(&name)?;
    let meta = fs::metadata(&file).map_err(|_| VaultError::NotFound(clean.clone()))?;
    let raw = fs::read_to_string(&file)?;
    let data = serde_json::from_str(&raw)
        .map_err(|e| VaultError::Io(format!("project.json parse failed: {e}")))?;
    Ok(ProjectReadOut {
        name: clean,
        data,
        mtime: mtime_ms(&meta),
    })
}

/// `mtime: None` = create (errors instead of clobbering an existing project);
/// `Some` = guarded update returning CONFLICT on drift (vault contract,
/// 1 ms tolerance like vault_write_file).
#[tauri::command]
pub fn vedit_project_save(
    name: String,
    data: serde_json::Value,
    mtime: Option<f64>,
) -> Result<ProjectWriteOut, VaultError> {
    let (clean, file) = project_paths(&name)?;
    match (mtime, fs::metadata(&file)) {
        (None, Ok(_)) => {
            return Err(VaultError::Invalid(format!(
                "Project \"{clean}\" already exists"
            )));
        }
        (Some(expected), Ok(meta)) => {
            let current = mtime_ms(&meta);
            if (current - expected).abs() > 1.0 {
                return Err(VaultError::Conflict {
                    current_mtime: current,
                });
            }
        }
        (Some(_), Err(_)) => return Err(VaultError::NotFound(clean)),
        (None, Err(_)) => {}
    }
    let bytes = serde_json::to_vec_pretty(&data)
        .map_err(|e| VaultError::Io(format!("project serialize failed: {e}")))?;
    atomic_write(&file, &bytes)?;
    let meta = fs::metadata(&file)?;
    Ok(ProjectWriteOut {
        ok: true,
        name: clean,
        mtime: mtime_ms(&meta),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOut {
    pub ok: bool,
    pub bin_id: String,
}

/// Immediate trash, never a confirm modal (locked UX decision): the whole
/// project folder moves into the recycling bin's Studio arm and the picker
/// raises a Toast whose Restore calls recycle_bin_restore with the returned
/// id. No direct-unlink path exists by design. SF4 additionally wires
/// vedit_remux_release here to drop the project's proxy pins.
#[tauri::command]
pub fn vedit_project_delete(
    app: tauri::AppHandle,
    name: String,
) -> Result<DeleteOut, VaultError> {
    let (clean, file) = project_paths(&name)?;
    let dir = file
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| VaultError::Invalid("project folder has no parent".into()))?;
    if !dir.is_dir() {
        return Err(VaultError::NotFound(clean));
    }
    // Release the project's proxy pins before trashing (SF4): unpinned
    // proxies stay on disk (no eviction pass in Phase 1) but stop counting
    // as project-held.
    if let Ok(raw) = fs::read_to_string(&file) {
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) {
            let hashes: Vec<String> = doc
                .get("media")
                .and_then(|m| m.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.get("proxyHash").and_then(|h| h.as_str()))
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            editor_proxy::release(&hashes);
        }
    }
    let rel = format!("Studio/Projects/{clean}");
    let bin_id =
        crate::commands::recycle_bin::trash_video_project(&app, Some("library".into()), &rel, &dir)?;
    Ok(DeleteOut { ok: true, bin_id })
}

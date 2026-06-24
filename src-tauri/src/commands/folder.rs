//! Folder browser commands.
//!
//! Reads the filesystem (`readdir`) for subfolders and `.md` files, frontmatter
//! for each `.md` via `parsers::frontmatter_cache`, and the manifest for
//! nested-folder counts. Two readers remain — the Pulse browser
//! (`pulse_get_folder`) and the recursive Vault File Tree's raw one-level
//! listing (`vault_get_folder`) — plus the tree's create/rename/delete
//! mutations. (The former Knowledge/Infrastructure card-view readers and the
//! `.view.json` config subsystem were removed with the folder-view feature.)
//!
//! Path safety: `resolve_root_path` canonicalizes the joined path and asserts
//! containment under the canonical vault root + root subdir — stricter than
//! Node's `startsWith` check.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::commands::vault::{
    pulse_vault_root, resolve_in, vault_root, DeleteOut, RootKind, VaultError,
};
use crate::parsers::frontmatter_cache::get_frontmatter;
use crate::render::manifest;

// ── Folder-counts cache, keyed by (root, manifest mtime) ───────────────────

struct AreaCache {
    folder_counts: HashMap<String, u32>, // full vault-relative path -> count
    loaded_mtime: f64,
}

fn area_cache_for(root: &str) -> AreaCache {
    let cur_mtime = manifest::current_mtime();
    let entries = manifest::all_entries();
    let prefix = format!("{}/", root);
    let mut counts: HashMap<String, u32> = HashMap::new();
    for e in entries {
        if !e.path.starts_with(&prefix) {
            continue;
        }
        let parts: Vec<&str> = e.path.split('/').collect();
        if parts.len() < 3 {
            continue;
        }
        // Increment counts for every ancestor folder under root.
        for i in 2..parts.len() {
            let folder_path = parts[..i].join("/");
            *counts.entry(folder_path).or_insert(0) += 1;
        }
    }
    AreaCache {
        folder_counts: counts,
        loaded_mtime: cur_mtime,
    }
}

fn caches() -> &'static RwLock<HashMap<String, AreaCache>> {
    static C: OnceLock<RwLock<HashMap<String, AreaCache>>> = OnceLock::new();
    C.get_or_init(|| RwLock::new(HashMap::new()))
}

fn with_cache<R>(root: &str, f: impl FnOnce(&AreaCache) -> R) -> R {
    let cur_mtime = manifest::current_mtime();
    {
        let map = caches().read().unwrap();
        if let Some(c) = map.get(root) {
            if (c.loaded_mtime - cur_mtime).abs() < 0.5 && cur_mtime > 0.0 {
                return f(c);
            }
        }
    }
    let fresh = area_cache_for(root);
    let result = f(&fresh);
    caches().write().unwrap().insert(root.to_string(), fresh);
    result
}

// ── Path safety ────────────────────────────────────────────────────────────

fn canonical_root() -> PathBuf {
    let v = vault_root();
    fs::canonicalize(&v).unwrap_or_else(|_| PathBuf::from(v))
}

/// Pulse browser resolves against the Pulse Vault (multi-mount); falls back to
/// the content vault until the Pulse Vault is registered (SF4).
fn canonical_pulse_root() -> PathBuf {
    let v = pulse_vault_root();
    fs::canonicalize(&v).unwrap_or_else(|_| PathBuf::from(v))
}

pub fn resolve_root_path(rel: &str, root: &str) -> Option<PathBuf> {
    resolve_root_path_in(rel, root, &canonical_root())
}

fn resolve_root_path_in(rel: &str, root: &str, canon_root: &Path) -> Option<PathBuf> {
    let base = canon_root.join(root);
    let target = if rel.is_empty() {
        base.clone()
    } else {
        base.join(rel)
    };
    let canon_target = if target.exists() {
        fs::canonicalize(&target).ok()?
    } else {
        let parent = target.parent()?;
        let canon_parent = fs::canonicalize(parent).ok()?;
        canon_parent.join(target.file_name()?)
    };
    let canon_base = fs::canonicalize(&base).ok()?;
    if canon_target != canon_base
        && !canon_target
            .strip_prefix(&canon_base)
            .map(|_| true)
            .unwrap_or(false)
    {
        return None;
    }
    Some(canon_target)
}

// ── mtime formatting (millisecond-Z, mirrors Node toISOString) ─────────────

fn iso_millis_z(t: SystemTime) -> Option<String> {
    let dt: DateTime<Utc> = t.into();
    Some(dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

// ── Output types ───────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Subfolder {
    pub name: String,
    pub path: String,
    pub count: u32,
}

#[derive(Serialize)]
pub struct BreadcrumbSeg {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct FolderResult {
    pub slug: String,
    pub name: String,
    pub path: String,
    pub breadcrumb: Vec<BreadcrumbSeg>,
    pub subfolders: Vec<Subfolder>,
    pub pages: Vec<TreePage>,
}

#[derive(Serialize)]
pub struct TreePage {
    pub path: String,
    pub name: String,
    pub title: String,
    pub mtime: Option<String>,
    pub created: Option<String>,
}

#[derive(Serialize)]
pub struct PulseFolderResult {
    pub name: String,
    pub path: String,
    pub breadcrumb: Vec<BreadcrumbSeg>,
    pub subfolders: Vec<Subfolder>,
    pub pages: Vec<PulsePage>,
}

#[derive(Serialize)]
pub struct PulsePage {
    pub path: String,
    pub name: String,
    pub title: String,
    pub mtime: Option<String>,
}

// ── Folder reader shared logic ─────────────────────────────────────────────

struct DirScan {
    subfolders: Vec<Subfolder>,
    page_files: Vec<String>,
}

fn scan_dir(abs: &Path) -> Result<DirScan, VaultError> {
    let mut entries: Vec<(String, bool)> = Vec::new();
    let read = fs::read_dir(abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => VaultError::NotFound(format!("Folder not found: {}", abs.display())),
        _ => VaultError::Io(e.to_string()),
    })?;
    for ent in read.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = match ent.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        entries.push((name, file_type.is_dir()));
    }
    let mut subfolders: Vec<Subfolder> = Vec::new();
    let mut page_files: Vec<String> = Vec::new();
    for (name, is_dir) in entries {
        if is_dir {
            subfolders.push(Subfolder {
                name: name.clone(),
                path: name,
                count: 0,
            });
        } else if name.ends_with(".md") {
            page_files.push(name);
        }
    }
    subfolders.sort_by(|a, b| a.name.cmp(&b.name));
    page_files.sort();
    Ok(DirScan {
        subfolders,
        page_files,
    })
}

/// Read each `.md`'s frontmatter for title + mtime. The recursive tree only
/// needs path/name/title (+ mtime); no field projection or `.view.json`.
fn folder_read_pages(
    abs: &Path,
    rel: &str,
    page_files: Vec<String>,
    root_with_area_path: &str,
) -> Vec<TreePage> {
    let mut pages: Vec<TreePage> = Vec::new();
    for filename in &page_files {
        let file_abs = abs.join(filename);
        let stem = filename.trim_end_matches(".md").to_string();
        let (meta, mtime, created) = match fs::metadata(&file_abs) {
            Ok(meta) => {
                let m: Map<String, Value> = get_frontmatter(&file_abs);
                let mt = meta.modified().ok().and_then(iso_millis_z);
                let ct = meta.created().ok().and_then(iso_millis_z);
                (m, mt, ct)
            }
            Err(_) => (Map::new(), None, None),
        };
        let child_rel = if rel.is_empty() {
            filename.clone()
        } else {
            format!("{}/{}", rel, filename)
        };
        let full_path = format!("{}/{}", root_with_area_path, child_rel);
        let title = meta
            .get("Title")
            .or_else(|| meta.get("title"))
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| stem.clone());
        pages.push(TreePage {
            path: full_path,
            name: stem,
            title,
            mtime,
            created,
        });
    }
    pages
}

fn build_breadcrumb_no_area(root: &str, rel: &str) -> Vec<BreadcrumbSeg> {
    let mut crumbs = vec![BreadcrumbSeg {
        name: root.to_string(),
        path: String::new(),
    }];
    if !rel.is_empty() {
        let mut cur = String::new();
        for part in rel.split('/') {
            if cur.is_empty() {
                cur = part.to_string();
            } else {
                cur = format!("{}/{}", cur, part);
            }
            crumbs.push(BreadcrumbSeg {
                name: part.to_string(),
                path: cur.clone(),
            });
        }
    }
    crumbs
}

// ── Public Tauri commands ──────────────────────────────────────────────────

#[tauri::command]
pub fn pulse_get_folder(path: Option<String>) -> Result<PulseFolderResult, VaultError> {
    let root = "Pulse";
    let rel = path.unwrap_or_default();
    let abs = resolve_root_path_in(&rel, root, &canonical_pulse_root())
        .ok_or_else(|| VaultError::NotFound(format!("Folder not found: Pulse/{}", rel)))?;
    if !abs.exists() {
        return Err(VaultError::NotFound(format!(
            "Folder not found: {}",
            abs.display()
        )));
    }

    let scan = scan_dir(&abs)?;
    let mut subfolders = scan.subfolders;
    let mut sub_counts = with_cache(root, |c| c.folder_counts.clone());
    for sf in subfolders.iter_mut() {
        let child_rel = if rel.is_empty() {
            sf.name.clone()
        } else {
            format!("{}/{}", rel, sf.name)
        };
        let full_path = format!("{}/{}", root, child_rel);
        sf.path = child_rel;
        sf.count = sub_counts.remove(&full_path).unwrap_or(0);
    }

    let mut pages: Vec<PulsePage> = Vec::new();
    for filename in scan.page_files {
        let file_abs = abs.join(&filename);
        let stem = filename.trim_end_matches(".md").to_string();
        let (meta, mtime) = match fs::metadata(&file_abs) {
            Ok(meta) => {
                let m: Map<String, Value> = get_frontmatter(&file_abs);
                let mt = meta.modified().ok().and_then(iso_millis_z);
                (m, mt)
            }
            Err(_) => (Map::new(), None),
        };
        let title = meta
            .get("Title")
            .or_else(|| meta.get("title"))
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| stem.clone());
        let child_rel = if rel.is_empty() {
            filename.clone()
        } else {
            format!("{}/{}", rel, filename)
        };
        pages.push(PulsePage {
            path: format!("{}/{}", root, child_rel),
            name: stem,
            title,
            mtime,
        });
    }

    let name = if rel.is_empty() {
        root.to_string()
    } else {
        rel.rsplit('/').next().unwrap_or(rel.as_str()).to_string()
    };

    Ok(PulseFolderResult {
        name,
        path: rel.clone(),
        breadcrumb: build_breadcrumb_no_area(root, &rel),
        subfolders,
        pages,
    })
}

/// Raw one-level folder listing for the recursive Vault File Tree. Browses any
/// top-level folder of the ACTIVE content vault by name — subfolders + `.md`
/// pages only, with no `.view.json`, filtering, sorting, or field projection
/// (the tree sorts client-side and shows every file). Manifest-free: subfolder
/// counts come from the manifest cache when present, else 0.
#[tauri::command]
pub fn vault_get_folder(
    slug: String,
    path: Option<String>,
    root: Option<String>,
) -> Result<FolderResult, VaultError> {
    let rel = path.unwrap_or_default();
    // Multi-mount: list against the requested root (None → content, back-compat).
    let root_path = RootKind::from_opt(root.as_deref()).root();
    let canon_root = fs::canonicalize(&root_path).unwrap_or_else(|_| PathBuf::from(&root_path));
    let abs = resolve_root_path_in(&rel, &slug, &canon_root)
        .ok_or_else(|| VaultError::NotFound(format!("Folder not found: {}/{}", slug, rel)))?;
    if !abs.exists() {
        return Err(VaultError::NotFound(format!(
            "Folder not found: {}",
            abs.display()
        )));
    }

    let scan = scan_dir(&abs)?;
    let mut subfolders = scan.subfolders;

    // The top folder itself is the "area"; subfolder counts come from the
    // manifest cache keyed by that prefix (0 when the vault has no manifest).
    let root_with_area_path = slug.clone();
    let mut sub_counts = with_cache(&slug, |c| c.folder_counts.clone());
    for sf in subfolders.iter_mut() {
        let child_rel = if rel.is_empty() {
            sf.name.clone()
        } else {
            format!("{}/{}", rel, sf.name)
        };
        let full_path = format!("{}/{}", root_with_area_path, child_rel);
        sf.path = child_rel;
        sf.count = sub_counts.remove(&full_path).unwrap_or(0);
    }

    let pages = folder_read_pages(&abs, &rel, scan.page_files, &root_with_area_path);

    let name = if rel.is_empty() {
        slug.clone()
    } else {
        rel.rsplit('/').next().unwrap_or(rel.as_str()).to_string()
    };

    Ok(FolderResult {
        slug: slug.clone(),
        name,
        path: rel.clone(),
        breadcrumb: build_breadcrumb_no_area(&slug, &rel),
        subfolders,
        pages,
    })
}

// ── File-tree mutation commands (Vault File Tree) ───────────────────────────
// Create / rename / delete folders for the recursive sidebar tree. File create
// + delete reuse vault_write_file / vault_delete_file. Path safety rides on
// resolve_in (canonicalizes + asserts vault-root containment, rejects `..`).

#[derive(Serialize)]
pub struct PathOut {
    pub ok: bool,
    pub path: String,
}

#[tauri::command]
pub fn vault_create_folder(path: String, root: Option<String>) -> Result<PathOut, VaultError> {
    let (rel, abs) = resolve_in(&path, RootKind::from_opt(root.as_deref()))?;
    if abs.exists() {
        return Err(VaultError::Invalid(format!("Already exists: {}", rel)));
    }
    fs::create_dir_all(&abs).map_err(|e| VaultError::Io(e.to_string()))?;
    Ok(PathOut { ok: true, path: rel })
}

/// Rename or move a file/folder. Same parent → rename; different parent → move
/// (Obsidian treats a rename containing `/` as a move). Rejects clobbering an
/// existing target.
#[tauri::command]
pub fn vault_rename_path(
    from: String,
    to: String,
    root: Option<String>,
) -> Result<PathOut, VaultError> {
    let kind = RootKind::from_opt(root.as_deref());
    let (from_rel, from_abs) = resolve_in(&from, kind)?;
    let (to_rel, to_abs) = resolve_in(&to, kind)?;
    if !from_abs.exists() {
        return Err(VaultError::NotFound(from_rel));
    }
    if to_abs.exists() {
        return Err(VaultError::Invalid(format!("Target exists: {}", to_rel)));
    }
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent).map_err(|e| VaultError::Io(e.to_string()))?;
    }
    fs::rename(&from_abs, &to_abs).map_err(|e| VaultError::Io(e.to_string()))?;
    if kind == RootKind::Content {
        crate::commands::manifest_gen::patch_content_manifest_rename(
            &from_rel,
            &to_rel,
            to_abs.is_dir(),
        );
    }
    Ok(PathOut { ok: true, path: to_rel })
}

/// Soft-delete a folder and its contents as ONE recycling-bin item (restoring
/// brings the whole subtree back together). Still gated behind a confirm modal.
#[tauri::command]
pub fn vault_delete_folder(
    app: AppHandle,
    path: String,
    root: Option<String>,
) -> Result<DeleteOut, VaultError> {
    let kind = RootKind::from_opt(root.as_deref());
    let (rel, abs) = resolve_in(&path, kind)?;
    let meta = fs::metadata(&abs).map_err(|_| VaultError::NotFound(rel.clone()))?;
    if !meta.is_dir() {
        return Err(VaultError::Invalid(format!("Not a folder: {}", rel)));
    }
    crate::commands::recycle_bin::trash_folder(&app, root, &rel, &abs)?;
    if kind == RootKind::Content {
        crate::commands::manifest_gen::patch_content_manifest_remove_prefix(&rel);
    }
    Ok(DeleteOut { ok: true, deleted: rel })
}

// Helper for the time-since-epoch ms, mirroring `parsers::frontmatter_cache`.
#[allow(dead_code)]
fn mtime_ms(t: SystemTime) -> f64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

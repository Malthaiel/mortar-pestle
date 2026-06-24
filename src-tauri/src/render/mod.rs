//! Markdown render pipeline for the vault.
//!
//! Public entry: `render_path(vault_relative_path) -> Result<RenderOutput>`.
//! Mirrors `server/src/vault/reference.js::renderPath` with a Rust pulldown-cmark
//! pipeline. Disk cache at `Infrastructure/.cache/rendered/<sha1>.html`, key
//! bound to `RENDERER_VERSION` (bumped to 3 — Node uses 2, so the two caches
//! co-exist during the parallel period).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::commands::vault::RootKind;

pub mod manifest;
pub mod markdown;

pub use markdown::{resolve_link, ResolveLinkOut};

/// Bump whenever rendering output changes (wikilink href, embed format, task
/// list HTML, etc.). Distinct from the Node renderer's version (2).
const RENDERER_VERSION: u32 = 3;

fn render_cache_dir_in(root: &str) -> PathBuf {
    PathBuf::from(format!("{}/Infrastructure/.cache/rendered", root))
}

#[derive(Debug)]
pub enum RenderError {
    Invalid(String),
    NotFound(String),
    NotFile,
    Io(String),
}

impl From<std::io::Error> for RenderError {
    fn from(e: std::io::Error) -> Self {
        RenderError::Io(e.to_string())
    }
}

#[derive(Serialize, Debug)]
pub struct RenderOutput {
    pub path: String,
    pub html: String,
    pub mtime: f64,
    pub title: Option<String>,
}

fn normalize_input(rel_in: &str) -> Result<String, RenderError> {
    let mut rel = rel_in.trim_start_matches('/').to_string();
    if !rel.ends_with(".md") {
        rel.push_str(".md");
    }
    // Reject .. / NUL after the trim — match Node renderPath behavior.
    if rel.contains('\0') {
        return Err(RenderError::Invalid("NUL in path".into()));
    }
    let mut parts: Vec<&str> = Vec::new();
    for comp in Path::new(&rel).components() {
        use std::path::Component::*;
        match comp {
            Normal(s) => parts.push(s.to_str().ok_or_else(|| RenderError::Invalid("non-utf8".into()))?),
            CurDir => {}
            ParentDir => return Err(RenderError::Invalid("Parent traversal".into())),
            RootDir | Prefix(_) => return Err(RenderError::Invalid("Absolute path".into())),
        }
    }
    if parts.is_empty() {
        return Err(RenderError::Invalid("Empty path".into()));
    }
    Ok(parts.join("/"))
}

fn mtime_ms_of(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn cache_key(abs: &Path, mtime_ms: f64) -> String {
    let mut h = Sha1::new();
    // Use bit-precise mtime serialization to avoid float-formatting drift.
    h.update(format!("{}|{}|{}", RENDERER_VERSION, abs.display(), mtime_ms.to_bits()).as_bytes());
    format!("{:x}", h.finalize())
}

pub fn render_path(rel_in: &str) -> Result<RenderOutput, RenderError> {
    render_path_in(rel_in, RootKind::Content)
}

/// Render a reference from a specific mounted vault root (content/app/pulse).
/// App-doc bodies render from the App Vault; in-body wikilinks still resolve
/// against the content vault's manifest (App/Pulse carry no manifest yet) — a
/// known, accepted degradation for cross-vault in-body links.
pub fn render_path_in(rel_in: &str, kind: RootKind) -> Result<RenderOutput, RenderError> {
    let norm = normalize_input(rel_in)?;
    let root = kind.root();
    let abs = PathBuf::from(&root).join(&norm);
    let canon = fs::canonicalize(&abs).map_err(|_| RenderError::NotFound(norm.clone()))?;
    let canon_root = fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    if !canon.starts_with(&canon_root) {
        return Err(RenderError::Invalid("Path escapes vault root".into()));
    }
    let meta = fs::metadata(&canon).map_err(|_| RenderError::NotFound(norm.clone()))?;
    if !meta.is_file() {
        return Err(RenderError::NotFile);
    }
    let mtime = mtime_ms_of(&meta);

    let path_no_ext = norm.trim_end_matches(".md").to_string();

    let cache_dir = render_cache_dir_in(&root);
    let key = cache_key(&canon, mtime);
    let cache_file = cache_dir.join(format!("{}.html", key));

    let source = fs::read_to_string(&canon)?;
    let title = markdown::parse_frontmatter_title(&source);

    if let Ok(cached) = fs::read_to_string(&cache_file) {
        return Ok(RenderOutput {
            path: path_no_ext,
            html: cached,
            mtime,
            title,
        });
    }

    let html = markdown::render_string(&source);
    let _ = fs::create_dir_all(&cache_dir);
    let _ = fs::write(&cache_file, &html);
    Ok(RenderOutput {
        path: path_no_ext,
        html,
        mtime,
        title,
    })
}

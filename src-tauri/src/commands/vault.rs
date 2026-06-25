//! Sub-feature 2 — Vault file IO.
//!
//! Ports five endpoints from the Fastify sidecar to Tauri IPC commands. The
//! Fastify server stays alive in parallel during this sub-feature; deletion
//! happens in Sub-feature 12.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Serialize, Serializer};
use tauri::AppHandle;

use crate::render;

/// Vault root. Precedence: `AGENTIC_VAULT_ROOT` env (tests) → the active vault
/// from the multi-vault registry (`commands::vaults`) → built-in Citadel
/// fallback (first-run / pre-init). Re-read on every call so a vault switch or
/// a per-test tempdir takes effect immediately.
pub fn vault_root() -> String {
    if let Ok(v) = std::env::var("AGENTIC_VAULT_ROOT") {
        return v;
    }
    if let Some(p) = crate::commands::vaults::active_vault_path() {
        return p;
    }
    dirs::document_dir()
        .map(|d| d.join("Citadel").to_string_lossy().into_owned())
        .unwrap_or_else(|| "Citadel".to_string())
}

/// App Vault root — backs the Docs + Releases surfaces. Precedence:
/// `AGENTIC_APP_VAULT_ROOT` env (tests) → the registered `role:app` vault →
/// the content vault (fallback before SF4 registers the App vault, so the
/// per-surface re-root stays inert until the migration populates it).
pub fn app_vault_root() -> String {
    if let Ok(v) = std::env::var("AGENTIC_APP_VAULT_ROOT") {
        return v;
    }
    crate::commands::vaults::app_vault_path().unwrap_or_else(vault_root)
}

/// Pulse Vault root — backs the planner surface. Same precedence as
/// `app_vault_root`, with `AGENTIC_PULSE_VAULT_ROOT` / `role:pulse`.
pub fn pulse_vault_root() -> String {
    if let Ok(v) = std::env::var("AGENTIC_PULSE_VAULT_ROOT") {
        return v;
    }
    crate::commands::vaults::pulse_vault_path().unwrap_or_else(vault_root)
}

/// Library Vault root — the writable, app-managed media catalog. Precedence:
/// `AGENTIC_LIBRARY_VAULT_ROOT` env (tests) → the registered `role:library`
/// vault → the content vault (fallback before `init_library_vault` registers it
/// on first boot).
pub fn library_vault_root() -> String {
    if let Ok(v) = std::env::var("AGENTIC_LIBRARY_VAULT_ROOT") {
        return v;
    }
    crate::commands::vaults::library_vault_path().unwrap_or_else(vault_root)
}

/// GameWiki Vault root — the read-only, app-managed multi-game reference vault.
/// Precedence: `AGENTIC_GAMEWIKI_VAULT_ROOT` env (tests) → the registered
/// `role:gamewiki` vault → the content vault (fallback before
/// `init_gamewiki_vault` registers it on first boot).
pub fn gamewiki_vault_root() -> String {
    if let Ok(v) = std::env::var("AGENTIC_GAMEWIKI_VAULT_ROOT") {
        return v;
    }
    crate::commands::vaults::gamewiki_vault_path().unwrap_or_else(vault_root)
}

/// User-chosen captures-dir override (WI-2 — configurable recordings folder).
/// In-process cache that `captures_dir()` reads; the persistence-of-record is
/// `<app_config>/captures-dir.json`, loaded here at startup and rewritten on every
/// set/reset (`commands::capture`). `None` ⇒ fall through to the platform default.
/// Held in a singleton so `captures_dir()` — which has no `AppHandle` — resolves it.
static CAPTURES_OVERRIDE: OnceLock<RwLock<Option<String>>> = OnceLock::new();
fn captures_override_cell() -> &'static RwLock<Option<String>> {
    CAPTURES_OVERRIDE.get_or_init(|| RwLock::new(None))
}
/// The active captures-dir override (in-process cache), if any.
pub fn captures_override() -> Option<String> {
    captures_override_cell()
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}
/// Set/clear the captures-dir override cache. Empty/whitespace ⇒ cleared. The
/// command layer persists to disk; this only updates the value `captures_dir()` reads.
pub fn set_captures_override(path: Option<String>) {
    *captures_override_cell().write().unwrap_or_else(|p| p.into_inner()) =
        path.filter(|p| !p.trim().is_empty());
}

/// Game Capture clip output root. Precedence: `AGENTIC_CAPTURES_ROOT` env (tests)
/// → the user override (WI-2) → platform default. Multi-GB media must NOT live in
/// roaming app-data (decision #11): the Windows default is `%USERPROFILE%\Videos\
/// Iskariel`, Linux the historical `library_vault_root()/Captures`. The daemon
/// spawn (`ISKARIEL_CAPTURES_DIR`), the clip-list scan, the reveal allowlist, AND
/// `RootKind::Captures` (the bin restore target) all resolve through here, so they
/// agree by construction — including under a user override.
pub fn captures_dir() -> String {
    if let Ok(v) = std::env::var("AGENTIC_CAPTURES_ROOT") {
        return v;
    }
    if let Some(p) = captures_override() {
        return p;
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(up) = std::env::var("USERPROFILE") {
            return format!("{up}\\Videos\\Iskariel");
        }
    }
    // Linux (and the Windows fallback if USERPROFILE is unset): the historical
    // library-rooted captures dir.
    PathBuf::from(library_vault_root())
        .join("Captures")
        .to_string_lossy()
        .into_owned()
}

/// Which mounted vault a path resolves against (multi-mount — Multi-Vault P2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootKind {
    Content,
    App,
    Pulse,
    Library,
    GameWiki,
    /// Game Capture clip output dir (`captures_dir()`) — NOT a markdown vault;
    /// used so the recycle bin can resolve a clip's restore path back to where
    /// clips live (outside the Library on Windows). See decision #11.
    Captures,
}

impl RootKind {
    /// Map the IPC `root` discriminator. Unknown/absent → Content (back-compat).
    pub fn from_opt(s: Option<&str>) -> Self {
        match s {
            Some("app") => RootKind::App,
            Some("pulse") => RootKind::Pulse,
            Some("library") => RootKind::Library,
            Some("gamewiki") => RootKind::GameWiki,
            Some("captures") => RootKind::Captures,
            _ => RootKind::Content,
        }
    }
    /// The (possibly non-canonical) root path string for this mount.
    pub fn root(self) -> String {
        match self {
            RootKind::Content => vault_root(),
            RootKind::App => app_vault_root(),
            RootKind::Pulse => pulse_vault_root(),
            RootKind::Library => library_vault_root(),
            RootKind::GameWiki => gamewiki_vault_root(),
            RootKind::Captures => captures_dir(),
        }
    }
}

fn canonical_root_of(kind: RootKind) -> PathBuf {
    let v = kind.root();
    fs::canonicalize(&v).unwrap_or_else(|_| PathBuf::from(v))
}

#[derive(Debug)]
pub enum VaultError {
    Invalid(String),
    NotFound(String),
    NotFile,
    Conflict { current_mtime: f64 },
    ManifestUnavailable,
    Io(String),
}

impl Serialize for VaultError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(3))?;
        match self {
            VaultError::Invalid(msg) => {
                m.serialize_entry("code", "INVALID")?;
                m.serialize_entry("message", msg)?;
            }
            VaultError::NotFound(msg) => {
                m.serialize_entry("code", "NOT_FOUND")?;
                m.serialize_entry("message", msg)?;
            }
            VaultError::NotFile => {
                m.serialize_entry("code", "NOT_FILE")?;
                m.serialize_entry("message", "Not a file")?;
            }
            VaultError::Conflict { current_mtime } => {
                m.serialize_entry("code", "CONFLICT")?;
                m.serialize_entry("message", "File modified externally")?;
                m.serialize_entry("currentMtime", current_mtime)?;
            }
            VaultError::ManifestUnavailable => {
                m.serialize_entry("code", "MANIFEST_UNAVAILABLE")?;
                m.serialize_entry("message", "Manifest not yet loaded")?;
            }
            VaultError::Io(msg) => {
                m.serialize_entry("code", "IO")?;
                m.serialize_entry("message", msg)?;
            }
        }
        m.end()
    }
}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self {
        VaultError::Io(e.to_string())
    }
}

/// Sub-feature 8 — skills runner error type. Separate from `VaultError`
/// because the code set differs (`INTERACTIVE`, `SPAWN_FAILED`, `CONFLICT`-
/// with-jobId rather than mtime) and Skills don't have an mtime contract.
#[derive(Debug)]
pub enum SkillError {
    NotFound(String),
    Interactive(String),
    Conflict { active_job_id: String },
    SpawnFailed(String),
    Invalid(String),
    Io(String),
}

impl Serialize for SkillError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(3))?;
        match self {
            SkillError::NotFound(msg) => {
                m.serialize_entry("code", "NOT_FOUND")?;
                m.serialize_entry("message", msg)?;
            }
            SkillError::Interactive(msg) => {
                m.serialize_entry("code", "INTERACTIVE")?;
                m.serialize_entry("message", msg)?;
            }
            SkillError::Conflict { active_job_id } => {
                m.serialize_entry("code", "CONFLICT")?;
                m.serialize_entry("message", "Skill is already running")?;
                m.serialize_entry("activeJobId", active_job_id)?;
            }
            SkillError::SpawnFailed(msg) => {
                m.serialize_entry("code", "SPAWN_FAILED")?;
                m.serialize_entry("message", msg)?;
            }
            SkillError::Invalid(msg) => {
                m.serialize_entry("code", "INVALID")?;
                m.serialize_entry("message", msg)?;
            }
            SkillError::Io(msg) => {
                m.serialize_entry("code", "IO")?;
                m.serialize_entry("message", msg)?;
            }
        }
        m.end()
    }
}

impl From<std::io::Error> for SkillError {
    fn from(e: std::io::Error) -> Self {
        SkillError::Io(e.to_string())
    }
}

/// Sub-feature 9 — PTY command surface. Same shape as SkillError but trimmed:
/// no Interactive (PTY *is* the interactive surface), no Conflict (each tab
/// is its own session), no Invalid (cols/rows validation collapses into
/// SpawnFailed). Serializes as `{ code, message }`.
#[derive(Debug)]
pub enum PtyError {
    NotFound(String),
    SpawnFailed(String),
    Io(String),
}

impl Serialize for PtyError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(2))?;
        match self {
            PtyError::NotFound(msg) => {
                m.serialize_entry("code", "NOT_FOUND")?;
                m.serialize_entry("message", msg)?;
            }
            PtyError::SpawnFailed(msg) => {
                m.serialize_entry("code", "SPAWN_FAILED")?;
                m.serialize_entry("message", msg)?;
            }
            PtyError::Io(msg) => {
                m.serialize_entry("code", "IO")?;
                m.serialize_entry("message", msg)?;
            }
        }
        m.end()
    }
}

impl From<std::io::Error> for PtyError {
    fn from(e: std::io::Error) -> Self {
        PtyError::Io(e.to_string())
    }
}

/// Normalize a vault-relative path, rejecting empty / NUL / `..` traversal.
/// Returns the cleaned relative path.
fn normalize_rel(input: &str) -> Result<String, VaultError> {
    let trimmed = input.trim_start_matches('/');
    if trimmed.is_empty() {
        return Err(VaultError::Invalid("Empty path".into()));
    }
    if trimmed.contains('\0') {
        return Err(VaultError::Invalid("NUL in path".into()));
    }
    let mut parts: Vec<&str> = Vec::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(s) => {
                parts.push(s.to_str().ok_or_else(|| VaultError::Invalid("Non-UTF8 path".into()))?);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(VaultError::Invalid("Parent traversal".into()));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(VaultError::Invalid("Absolute path not allowed".into()));
            }
        }
    }
    if parts.is_empty() {
        return Err(VaultError::Invalid("Empty path after normalize".into()));
    }
    Ok(parts.join("/"))
}

/// Resolve a content-vault-relative path to an absolute path, rejecting
/// symlink escapes via canonicalize. Thin alias over `resolve_in(Content)`.
pub fn resolve(rel_in: &str) -> Result<(String, PathBuf), VaultError> {
    resolve_in(rel_in, RootKind::Content)
}

/// Resolve a path under the given mounted vault's root (content / app / pulse),
/// rejecting symlink/`..` escapes via canonicalize.
pub fn resolve_in(rel_in: &str, kind: RootKind) -> Result<(String, PathBuf), VaultError> {
    let rel = normalize_rel(rel_in)?;
    let root = canonical_root_of(kind);
    let abs = root.join(&rel);
    // Try canonicalize the full path. If the leaf — and possibly some
    // intermediate dirs — don't exist yet (a new-file write into a not-yet-
    // created subdir), canonicalize the NEAREST EXISTING ancestor (so symlinks
    // in real dirs are still resolved + containment-checked), then re-append the
    // missing tail. `normalize_rel` stripped `..`, and the missing dirs can't be
    // symlinks (they don't exist), so the tail can't escape root; `atomic_write`
    // creates the tail dirs on write. (Previously this canonicalized the
    // immediate parent and failed when it didn't exist — which rejected every
    // first write into a fresh Health/<sub>, Splits/Cardio + Nutrition alike.)
    let canon = match fs::canonicalize(&abs) {
        Ok(c) => c,
        Err(_) => {
            let mut existing = abs.clone();
            let mut tail: Vec<std::ffi::OsString> = Vec::new();
            while !existing.exists() {
                let leaf = existing
                    .file_name()
                    .ok_or_else(|| VaultError::Invalid("No leaf".into()))?
                    .to_os_string();
                tail.push(leaf);
                if !existing.pop() {
                    return Err(VaultError::Invalid("Path escapes vault root".into()));
                }
            }
            let mut candidate =
                fs::canonicalize(&existing).map_err(|e| VaultError::Io(e.to_string()))?;
            for leaf in tail.iter().rev() {
                candidate.push(leaf);
            }
            if !candidate.starts_with(&root) {
                return Err(VaultError::Invalid("Path escapes vault root".into()));
            }
            return Ok((rel, candidate));
        }
    };
    if !canon.starts_with(&root) {
        return Err(VaultError::Invalid("Path escapes vault root".into()));
    }
    Ok((rel, canon))
}

pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Atomically write `content` to `path` via tmp file + POSIX rename. Mirrors
/// Node's `server/src/vault/notes.js::atomicWrite` — same tmp-name shape (so
/// crash-recovery sweeps recognize both) plus fsync for crash-safety
/// (stricter than Node).
pub fn atomic_write(path: &Path, content: &[u8]) -> Result<(), VaultError> {
    let parent = path
        .parent()
        .ok_or_else(|| VaultError::Invalid("No parent dir".into()))?;
    fs::create_dir_all(parent)?;
    let pid = std::process::id();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let leaf = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| VaultError::Invalid("No leaf".into()))?;
    let tmp = path.with_file_name(format!("{}.tmp.{}.{}.{}", leaf, pid, ts, n));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content)?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(VaultError::Io(e.to_string()));
    }
    Ok(())
}

/// Mtime-conflict gate shared by every writer. `None` skips the check (matches
/// Node behavior for unmigrated callers). If the file doesn't exist yet, no
/// conflict is possible — the writer is creating it.
pub fn check_mtime(path: &Path, base_mtime: Option<f64>) -> Result<(), VaultError> {
    let Some(expected) = base_mtime else {
        return Ok(());
    };
    if let Ok(meta) = fs::metadata(path) {
        let current = mtime_ms(&meta);
        if (current - expected).abs() > 1.0 {
            return Err(VaultError::Conflict {
                current_mtime: current,
            });
        }
    }
    Ok(())
}

fn mime_for(rel: &str) -> &'static str {
    let ext = Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" => "text/markdown; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "opus" => "audio/ogg; codecs=opus",
        "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

#[derive(Serialize)]
pub struct ReadFileOut {
    pub content: String,
    pub mime: &'static str,
    pub mtime: f64,
}

#[derive(Serialize)]
pub struct WriteOut {
    pub ok: bool,
    pub mtime: f64,
}

#[derive(Serialize)]
pub struct DeleteOut {
    pub ok: bool,
    pub deleted: String,
}

#[derive(Serialize)]
pub struct ToggleOut {
    pub ok: bool,
    pub checked: bool,
    pub mtime: f64,
}

// Async wrapper: run the (blocking) file read off the main-thread command path
// via spawn_blocking, so a future main-thread stall can't starve content loads
// (resilience hardening after the 2026-06-24 Windows browser deadlock).
#[tauri::command]
pub async fn vault_read_file(path: String, root: Option<String>) -> Result<ReadFileOut, VaultError> {
    tauri::async_runtime::spawn_blocking(move || vault_read_file_inner(path, root))
        .await
        .map_err(|e| VaultError::Io(e.to_string()))?
}

fn vault_read_file_inner(path: String, root: Option<String>) -> Result<ReadFileOut, VaultError> {
    let (rel, abs) = resolve_in(&path, RootKind::from_opt(root.as_deref()))?;
    let meta = fs::metadata(&abs).map_err(|_| VaultError::NotFound(rel.clone()))?;
    if !meta.is_file() {
        return Err(VaultError::NotFile);
    }
    let bytes = fs::read(&abs)?;
    let content = String::from_utf8(bytes)
        .map_err(|_| VaultError::Invalid("File is not valid UTF-8 (use binary asset path)".into()))?;
    Ok(ReadFileOut {
        content,
        mime: mime_for(&rel),
        mtime: mtime_ms(&meta),
    })
}

#[tauri::command]
pub fn vault_write_file(
    path: String,
    content: String,
    mtime: Option<f64>,
    root: Option<String>,
) -> Result<WriteOut, VaultError> {
    let kind = RootKind::from_opt(root.as_deref());
    let (rel, abs) = resolve_in(&path, kind)?;
    if let Some(expected) = mtime {
        if let Ok(meta) = fs::metadata(&abs) {
            let current = mtime_ms(&meta);
            if (current - expected).abs() > 1.0 {
                return Err(VaultError::Conflict { current_mtime: current });
            }
        }
    }
    atomic_write(&abs, content.as_bytes())?;
    let meta = fs::metadata(&abs)?;
    if kind == RootKind::Content {
        crate::commands::manifest_gen::patch_content_manifest(&rel, false);
    }
    Ok(WriteOut { ok: true, mtime: mtime_ms(&meta) })
}

#[tauri::command]
pub fn vault_delete_file(
    app: AppHandle,
    path: String,
    root: Option<String>,
) -> Result<DeleteOut, VaultError> {
    let kind = RootKind::from_opt(root.as_deref());
    let (rel, abs) = resolve_in(&path, kind)?;
    let meta = fs::metadata(&abs).map_err(|_| VaultError::NotFound(rel.clone()))?;
    if !meta.is_file() {
        return Err(VaultError::NotFile);
    }
    // Soft-delete: move the file into the global recycling bin instead of
    // unlinking. recycle_bin_delete / recycle_bin_empty do the hard delete.
    crate::commands::recycle_bin::trash_file(&app, root, &rel, &abs)?;
    if kind == RootKind::Content {
        crate::commands::manifest_gen::patch_content_manifest(&rel, true);
    }
    Ok(DeleteOut { ok: true, deleted: rel })
}

fn task_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\s*[-*+]\s+)\[([ xX])\](\s.*)?$").unwrap())
}

#[tauri::command]
pub fn vault_toggle_task(
    path: String,
    line: usize,
    root: Option<String>,
) -> Result<ToggleOut, VaultError> {
    let kind = RootKind::from_opt(root.as_deref());
    let (rel, abs) = resolve_in(&path, kind)?;
    if !abs.is_file() {
        return Err(VaultError::NotFound(rel));
    }
    let text = fs::read_to_string(&abs)?;
    let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    if line >= lines.len() {
        return Err(VaultError::Invalid("Line out of range".into()));
    }
    let m = task_line_re()
        .captures(&lines[line])
        .ok_or_else(|| VaultError::Invalid("No task marker on that line".into()))?;
    let prefix = m.get(1).unwrap().as_str().to_string();
    let marker = m.get(2).unwrap().as_str();
    let suffix = m.get(3).map(|s| s.as_str().to_string()).unwrap_or_default();
    let was_checked = marker.eq_ignore_ascii_case("x");
    let new_marker = if was_checked { "[ ]" } else { "[x]" };
    lines[line] = format!("{prefix}{new_marker}{suffix}");
    atomic_write(&abs, lines.join("\n").as_bytes())?;
    let meta = fs::metadata(&abs)?;
    if kind == RootKind::Content {
        crate::commands::manifest_gen::patch_content_manifest(&rel, false);
    }
    Ok(ToggleOut {
        ok: true,
        checked: !was_checked,
        mtime: mtime_ms(&meta),
    })
}

#[tauri::command]
pub fn vault_render_reference(
    path: String,
    root: Option<String>,
) -> Result<render::RenderOutput, VaultError> {
    render::render_path_in(&path, RootKind::from_opt(root.as_deref())).map_err(|e| match e {
        render::RenderError::Invalid(s) => VaultError::Invalid(s),
        render::RenderError::NotFound(s) => VaultError::NotFound(s),
        render::RenderError::NotFile => VaultError::NotFile,
        render::RenderError::Io(s) => VaultError::Io(s),
    })
}

/// Resolve a wikilink/embed target to a vault path for the Live Preview editor.
/// Infallible — an unresolved target returns `{ resolved: false, kind: "unresolved" }`.
#[tauri::command]
pub fn vault_resolve_link(target: String, embed: bool) -> render::ResolveLinkOut {
    render::resolve_link(&target, embed)
}

#[cfg(test)]
mod library_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn from_opt_maps_library_role() {
        assert_eq!(RootKind::from_opt(Some("library")), RootKind::Library);
        assert_eq!(RootKind::from_opt(Some("captures")), RootKind::Captures);
        assert_eq!(RootKind::from_opt(Some("app")), RootKind::App);
        assert_eq!(RootKind::from_opt(Some("pulse")), RootKind::Pulse);
        assert_eq!(RootKind::from_opt(None), RootKind::Content);
        assert_eq!(RootKind::from_opt(Some("bogus")), RootKind::Content);
    }

    // Sole owner of AGENTIC_LIBRARY_VAULT_ROOT — no other test reads/writes it,
    // so this stays race-free under cargo's parallel runner.
    #[test]
    fn library_root_env_and_round_trip() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().into_owned();
        std::env::set_var("AGENTIC_LIBRARY_VAULT_ROOT", &root);

        // Env override wins (highest precedence in library_vault_root()).
        assert_eq!(library_vault_root(), root);

        // A write+read round-trip via root:"library" lands in the tempdir,
        // proving the RootKind::Library plumbing end to end.
        let w = vault_write_file(
            "smoke.md".into(),
            "hello library".into(),
            None,
            Some("library".into()),
        )
        .expect("write to library root");
        assert!(w.ok);

        let canon = std::fs::canonicalize(tmp.path()).unwrap();
        assert!(canon.join("smoke.md").is_file());

        let r = vault_read_file_inner("smoke.md".into(), Some("library".into()))
            .expect("read from library root");
        assert_eq!(r.content, "hello library");

        // Regression (Health Column sub-plan 4): a NEW file in a not-yet-existing
        // NESTED subdir must resolve + write — resolve_in walks to the nearest
        // existing ancestor, atomic_write creates the dirs. Previously rejected
        // (canonicalize of the missing parent failed), which broke every first
        // Health/<sub> save (Splits/Cardio + Nutrition Meals/Supplements/Goals).
        let w2 = vault_write_file(
            "Health/Splits/PPL.md".into(),
            "split".into(),
            None,
            Some("library".into()),
        )
        .expect("write to a new nested subdir");
        assert!(w2.ok);
        assert!(canon.join("Health").join("Splits").join("PPL.md").is_file());

        std::env::remove_var("AGENTIC_LIBRARY_VAULT_ROOT");
    }
}

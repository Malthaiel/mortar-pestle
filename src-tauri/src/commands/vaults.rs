//! Multi-Vault — vault registry, active-vault state, `.obsidian/` validation,
//! and per-vault manifest wiring.
//!
//! The registry persists at `<app_config>/vaults.json` (mirrors the
//! `sidebar.json` pattern in `commands::sidebar`). This module is the sole
//! writer of the active-vault globals that `commands::vault::vault_root` and
//! `render::manifest::manifest_path` read — so a vault switch propagates to
//! every IPC command (all of which resolve paths through `vault_root()`) with
//! no per-command signature change.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::commands::sidebar::app_config_root;
use crate::commands::vault::{atomic_write, VaultError};

/// First-run default content-vault location: `<Documents>/Citadel`, resolved
/// per-OS (Linux `~/Documents/Citadel`, Windows `%USERPROFILE%\Documents\Citadel`).
fn default_citadel() -> String {
    dirs::document_dir()
        .map(|d| d.join("Citadel").to_string_lossy().into_owned())
        .unwrap_or_else(|| "Citadel".to_string())
}

// ---------------------------------------------------------------------------
// Active-vault path — read by commands::vault::vault_root (highest precedence
// after the AGENTIC_VAULT_ROOT test env var).
// ---------------------------------------------------------------------------
static ACTIVE_VAULT: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn active_cell() -> &'static RwLock<Option<String>> {
    ACTIVE_VAULT.get_or_init(|| RwLock::new(None))
}

/// Current active vault path, or `None` before `init_active_vault` runs.
pub fn active_vault_path() -> Option<String> {
    active_cell().read().ok().and_then(|g| g.clone())
}

fn set_active_global(path: &str) {
    if let Ok(mut g) = active_cell().write() {
        *g = Some(path.to_string());
    }
}

// ---------------------------------------------------------------------------
// Active-vault adapter mapping (SF4) — read by commands::knowledge +
// commands::folder to re-root the Knowledge/Infrastructure readers onto a
// foreign vault's folders. `None` (the default) → literal "Knowledge" /
// "Infrastructure", so Citadel + every unmapped vault are unchanged.
// ---------------------------------------------------------------------------
static ACTIVE_MAPPING: OnceLock<RwLock<Option<VaultMapping>>> = OnceLock::new();

fn mapping_cell() -> &'static RwLock<Option<VaultMapping>> {
    ACTIVE_MAPPING.get_or_init(|| RwLock::new(None))
}

fn set_active_mapping(m: Option<VaultMapping>) {
    if let Ok(mut g) = mapping_cell().write() {
        *g = m;
    }
}

/// The active vault's adapter mapping, if any.
pub fn active_mapping() -> Option<VaultMapping> {
    mapping_cell().read().ok().and_then(|g| g.clone())
}

/// The folder the active vault treats as its Knowledge root ("Knowledge" by
/// default). Read at call time by `knowledge_list_domains` + the folder reader.
pub fn knowledge_root() -> String {
    active_mapping()
        .and_then(|m| m.knowledge_root)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Knowledge".into())
}

/// The folder the active vault treats as its Infrastructure root.
pub fn infra_root() -> String {
    active_mapping()
        .and_then(|m| m.infra_root)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Infrastructure".into())
}

// ---------------------------------------------------------------------------
// Mounted role-vault paths (App + Pulse) — read by vault::app_vault_root /
// pulse_vault_root. `None` until SF4 registers them, so the per-surface
// re-root transparently falls back to the content vault until the migration.
// ---------------------------------------------------------------------------
static APP_VAULT: OnceLock<RwLock<Option<String>>> = OnceLock::new();
static PULSE_VAULT: OnceLock<RwLock<Option<String>>> = OnceLock::new();
static LIBRARY_VAULT: OnceLock<RwLock<Option<String>>> = OnceLock::new();
static GAMEWIKI_VAULT: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn app_cell() -> &'static RwLock<Option<String>> {
    APP_VAULT.get_or_init(|| RwLock::new(None))
}
fn pulse_cell() -> &'static RwLock<Option<String>> {
    PULSE_VAULT.get_or_init(|| RwLock::new(None))
}
fn library_cell() -> &'static RwLock<Option<String>> {
    LIBRARY_VAULT.get_or_init(|| RwLock::new(None))
}
fn gamewiki_cell() -> &'static RwLock<Option<String>> {
    GAMEWIKI_VAULT.get_or_init(|| RwLock::new(None))
}

/// Registered App Vault path, or `None` before it's registered.
pub fn app_vault_path() -> Option<String> {
    app_cell().read().ok().and_then(|g| g.clone())
}
/// Registered Pulse Vault path, or `None` before it's registered.
pub fn pulse_vault_path() -> Option<String> {
    pulse_cell().read().ok().and_then(|g| g.clone())
}
/// Registered Library Vault path, or `None` before `init_library_vault` runs.
pub fn library_vault_path() -> Option<String> {
    library_cell().read().ok().and_then(|g| g.clone())
}
/// Registered GameWiki Vault path, or `None` before `init_gamewiki_vault` runs.
pub fn gamewiki_vault_path() -> Option<String> {
    gamewiki_cell().read().ok().and_then(|g| g.clone())
}

fn set_role_global(role: &str, path: &str) {
    let cell = match role {
        "app" => app_cell(),
        "pulse" => pulse_cell(),
        "library" => library_cell(),
        "gamewiki" => gamewiki_cell(),
        _ => return,
    };
    if let Ok(mut g) = cell.write() {
        *g = Some(path.to_string());
    }
}

// ---------------------------------------------------------------------------
// App-config dir (cached at startup so render::manifest can resolve the active
// vault's manifest file without an AppHandle) + the active manifest path.
// ---------------------------------------------------------------------------
static APP_CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static ACTIVE_MANIFEST_PATH: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn manifest_path_cell() -> &'static RwLock<Option<String>> {
    ACTIVE_MANIFEST_PATH.get_or_init(|| RwLock::new(None))
}

/// Path to the active vault's app-data manifest. `None` before init →
/// `render::manifest` falls back to the legacy in-vault path (keeps tests,
/// which set AGENTIC_VAULT_ROOT but not the registry, working unchanged).
pub fn active_manifest_path() -> Option<String> {
    manifest_path_cell().read().ok().and_then(|g| g.clone())
}

fn manifest_dir() -> Option<PathBuf> {
    APP_CONFIG_DIR.get().map(|p| p.join("manifests"))
}

fn manifest_path_for(id: &str) -> Option<String> {
    manifest_dir().map(|d| d.join(format!("{id}.json")).to_string_lossy().into_owned())
}

fn set_active_manifest(id: &str) {
    if let Ok(mut g) = manifest_path_cell().write() {
        *g = manifest_path_for(id);
    }
}

/// Build (or rebuild) `entry`'s manifest if the vault has manifests enabled.
/// Best-effort: logs and continues on failure (wikilinks just render
/// unresolved). No-op when manifests are disabled for the vault.
fn regen_manifest(entry: &VaultEntry) {
    if !entry.manifest_enabled {
        return;
    }
    if let Some(dir) = manifest_dir() {
        let _ = fs::create_dir_all(&dir);
    }
    if let Some(out) = manifest_path_for(&entry.id) {
        if let Err(e) = crate::commands::manifest_gen::generate_for(&entry.path, Path::new(&out)) {
            log::warn!("manifest generation failed for vault '{}': {e:?}", entry.name);
        }
    }
}

// ---------------------------------------------------------------------------
// Registry types + persistence.
// ---------------------------------------------------------------------------
/// Opt-in per-vault adapter (Phase 3 / SF4). Re-roots the curated
/// Knowledge/Infrastructure views onto a foreign vault's own folders and hides
/// chosen top-level folders from the auto-discovery tree. Absent → the vault
/// uses the literal `Knowledge/` + `Infrastructure/` defaults (Citadel + every
/// unmapped vault are unchanged).
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultMapping {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub infra_root: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hide: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct VaultEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default = "default_true", rename = "manifestEnabled")]
    pub manifest_enabled: bool,
    /// Mount role: `content` (switchable user vault), `app` (Docs+Releases
    /// singleton), `pulse` (planner singleton), `library` (writable media
    /// catalog), or `gamewiki` (read-only multi-game reference). Defaults to
    /// `content` for back-compat with v1 registries (no `role` field).
    #[serde(default = "default_role")]
    pub role: String,
    /// Opt-in adapter (SF4). `None` for Citadel + back-compat with older
    /// registries (no `mapping` field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapping: Option<VaultMapping>,
}

fn default_true() -> bool {
    true
}

fn default_role() -> String {
    "content".to_string()
}

#[derive(Serialize, Deserialize)]
struct Registry {
    #[serde(default = "reg_version")]
    version: u32,
    #[serde(rename = "activeId", default)]
    active_id: Option<String>,
    #[serde(default)]
    vaults: Vec<VaultEntry>,
}

fn reg_version() -> u32 {
    2
}

impl Default for Registry {
    fn default() -> Self {
        Registry { version: 2, active_id: None, vaults: Vec::new() }
    }
}

fn registry_file(app: &AppHandle) -> Result<PathBuf, VaultError> {
    Ok(app_config_root(app)?.join("vaults.json"))
}

fn load_registry(path: &Path) -> Registry {
    let Ok(text) = fs::read_to_string(path) else {
        return Registry::default();
    };
    let mut reg: Registry = serde_json::from_str(&text).unwrap_or_else(|e| {
        log::warn!("vaults.json parse failed ({e}) — treating as empty");
        Registry::default()
    });
    // Normalize any persisted Windows `\\?\` verbatim paths (entries written by
    // an older build, before is_valid_vault stripped them). Cleans the live role
    // globals AND the frontend-serialized list in one place; idempotent; migrates
    // vaults.json lazily on the next persist. No-op off-Windows / on clean paths.
    for v in &mut reg.vaults {
        v.path = crate::tool_path::native_str(&v.path);
    }
    reg
}

fn persist_registry(path: &Path, reg: &Registry) -> Result<(), VaultError> {
    let mut text = serde_json::to_string_pretty(reg)
        .map_err(|e| VaultError::Io(format!("serialize vaults.json: {e}")))?;
    text.push('\n');
    atomic_write(path, text.as_bytes())
}

// ---------------------------------------------------------------------------
// Validation — a folder is a vault iff it canonicalizes to a dir containing
// `.obsidian/`.
// ---------------------------------------------------------------------------
pub fn is_valid_vault(path: &str) -> Result<PathBuf, VaultError> {
    let canon = fs::canonicalize(path)
        .map_err(|_| VaultError::Invalid(format!("Folder not found: {path}")))?;
    if !canon.is_dir() {
        return Err(VaultError::Invalid("Not a folder".into()));
    }
    if !canon.join(".obsidian").is_dir() {
        return Err(VaultError::Invalid(
            "Not an Obsidian vault: no .obsidian/ folder found".into(),
        ));
    }
    // Strip the Windows `\\?\` verbatim prefix `fs::canonicalize` adds, so the
    // path every consumer sees (registry, frontend, download scripts, opener)
    // is plain. The checks above ran on the canonical form; only the returned
    // value is normalized. No-op off-Windows / on already-plain paths.
    // `is_under_allowed_root` re-canonicalizes at compare time, so path
    // containment is unaffected.
    Ok(crate::tool_path::native_path(&canon))
}

// ---------------------------------------------------------------------------
// Startup — load/seed the registry, set the active vault + manifest, build it.
// MUST run before watcher::spawn (lib.rs) so the watcher attaches the new root.
// ---------------------------------------------------------------------------
pub fn init_active_vault(app: &AppHandle) {
    // Cache the app-config dir for render::manifest's per-vault path resolve.
    if let Ok(dir) = app_config_root(app) {
        let _ = APP_CONFIG_DIR.set(dir);
    }

    let path = match registry_file(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("vaults init: resolve registry path failed: {e:?}");
            return;
        }
    };

    let mut reg = load_registry(&path);
    if reg.vaults.is_empty() {
        // First run — seed Citadel as the default vault.
        let entry = VaultEntry {
            id: Uuid::new_v4().to_string(),
            name: "Citadel".into(),
            path: default_citadel(),
            manifest_enabled: true,
            role: "content".into(),
            mapping: None,
        };
        reg.active_id = Some(entry.id.clone());
        reg.vaults.push(entry);
        if let Err(e) = persist_registry(&path, &reg) {
            eprintln!("vaults init: seed persist failed: {e:?}");
        }
    }

    // Multi-mount — attach the App + Pulse role vaults (SF4 creates and
    // populates their app-data dirs; this picks them up on the next boot).
    init_role_vaults(app, &mut reg, &path);

    // Attach (creating on first boot) the writable Library vault.
    init_library_vault(app, &mut reg, &path);

    // Attach (creating on first boot) the read-only GameWiki reference vault.
    init_gamewiki_vault(app, &mut reg, &path);

    match resolve_active(&reg) {
        Some(entry) => {
            set_active_global(&entry.path);
            set_active_manifest(&entry.id);
            set_active_mapping(entry.mapping.clone());
            regen_manifest(&entry);
        }
        None => eprintln!("vaults init: no valid vault in registry — using built-in fallback"),
    }
}

/// Attach the App + Pulse role vaults. For each role: set its global path cell
/// from an existing registry entry, else — if its app-data vault dir exists and
/// is valid (created+populated by the SF4 migration) — register it now. Does
/// NOT create empty dirs, so before the migration the role cells stay `None`
/// and the per-surface re-root falls back to the content vault.
fn init_role_vaults(app: &AppHandle, reg: &mut Registry, reg_path: &Path) {
    let cfg = match app_config_root(app) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut changed = false;
    for (role, name) in [("app", "App"), ("pulse", "Pulse")] {
        if let Some(e) = reg.vaults.iter().find(|v| v.role == role) {
            set_role_global(role, &e.path);
            continue;
        }
        let dir = cfg.join(name);
        let dir_str = dir.to_string_lossy().into_owned();
        if is_valid_vault(&dir_str).is_ok() {
            let entry = VaultEntry {
                id: Uuid::new_v4().to_string(),
                name: name.to_string(),
                path: dir_str.clone(),
                manifest_enabled: true,
                role: role.to_string(),
                mapping: None,
            };
            regen_manifest(&entry);
            set_role_global(role, &dir_str);
            reg.vaults.push(entry);
            changed = true;
        }
    }
    if changed {
        if let Err(e) = persist_registry(reg_path, reg) {
            eprintln!("vaults init: role-vault persist failed: {e:?}");
        }
    }
}

/// Attach the writable Library vault, CREATING it on first boot. Unlike the
/// App/Pulse role vaults — which `init_role_vaults` only *detects* (the SF4
/// migration created them) — the Library vault is app-owned and scaffolded here
/// if absent: a hidden `.obsidian/` marker (so it passes `is_valid_vault`) under
/// the XDG *data* dir (media binaries are data, not config), registered as
/// `role:"library"` with manifests OFF (the vault is wikilink-free by contract).
/// Refuses to clobber a non-empty dir that isn't already a vault (no-git net).
fn init_library_vault(app: &AppHandle, reg: &mut Registry, reg_path: &Path) {
    // Already registered on a prior boot — just wire the live global.
    if let Some(e) = reg.vaults.iter().find(|v| v.role == "library") {
        set_role_global("library", &e.path);
        return;
    }
    // Resolve the dir: env override (tests) → <app_data_dir>/Library.
    let dir = match std::env::var("AGENTIC_LIBRARY_VAULT_ROOT") {
        Ok(v) => PathBuf::from(v),
        Err(_) => match app.path().app_data_dir() {
            Ok(d) => d.join("Library"),
            Err(e) => {
                eprintln!("library init: app_data_dir unavailable: {e}");
                return;
            }
        },
    };
    let dir_str = dir.to_string_lossy().into_owned();

    // Scaffold a hidden .obsidian/ if it isn't a valid vault yet — but never
    // clobber a non-empty dir that isn't already a vault.
    if is_valid_vault(&dir_str).is_err() {
        if let Ok(mut entries) = fs::read_dir(&dir) {
            if entries.next().is_some() {
                eprintln!("library init: {dir_str} is non-empty and not a vault — skipping");
                return;
            }
        }
        for f in ["app.json", "appearance.json"] {
            if let Err(e) = atomic_write(&dir.join(".obsidian").join(f), b"{}\n") {
                eprintln!("library init: scaffold {f} failed: {e:?}");
                return;
            }
        }
        let _ = atomic_write(&dir.join(".obsidian/core-plugins.json"), b"[]\n");
        let _ = atomic_write(&dir.join(".obsidian/community-plugins.json"), b"[]\n");
    }

    let canon = match is_valid_vault(&dir_str) {
        Ok(c) => c.to_string_lossy().into_owned(),
        Err(e) => {
            eprintln!("library init: still invalid after scaffold: {e:?}");
            return;
        }
    };
    let entry = VaultEntry {
        id: Uuid::new_v4().to_string(),
        name: "Library".into(),
        path: canon.clone(),
        manifest_enabled: false, // wikilink-free by contract → no manifest/graph
        role: "library".into(),
        mapping: None,
    };
    set_role_global("library", &canon);
    reg.vaults.push(entry);
    if let Err(e) = persist_registry(reg_path, reg) {
        eprintln!("library init: persist failed: {e:?}");
    }
}

/// Attach the read-only GameWiki reference vault, CREATING it on first boot.
/// Mirrors `init_library_vault` (app-owned, scaffolded under the XDG *data* dir,
/// refuses to clobber a non-empty non-vault dir) with two differences: manifests
/// are ENABLED (the game wikis are densely wikilinked, so the graph/wikilink
/// resolver needs an index), and the manifest is regenerated on EVERY boot — so
/// content moved into the vault out-of-band (the Deadlock migration, `/patch-notes`,
/// direct Obsidian edits) re-indexes on the next restart.
fn init_gamewiki_vault(app: &AppHandle, reg: &mut Registry, reg_path: &Path) {
    // Already registered on a prior boot — wire the live global + re-index.
    if let Some(e) = reg.vaults.iter().find(|v| v.role == "gamewiki") {
        set_role_global("gamewiki", &e.path);
        regen_manifest(e);
        return;
    }
    // Resolve the dir: env override (tests) → <app_data_dir>/GameWiki.
    let dir = match std::env::var("AGENTIC_GAMEWIKI_VAULT_ROOT") {
        Ok(v) => PathBuf::from(v),
        Err(_) => match app.path().app_data_dir() {
            Ok(d) => d.join("GameWiki"),
            Err(e) => {
                eprintln!("gamewiki init: app_data_dir unavailable: {e}");
                return;
            }
        },
    };
    let dir_str = dir.to_string_lossy().into_owned();

    // Scaffold a hidden .obsidian/ if it isn't a valid vault yet — but never
    // clobber a non-empty dir that isn't already a vault (no-git net).
    if is_valid_vault(&dir_str).is_err() {
        if let Ok(mut entries) = fs::read_dir(&dir) {
            if entries.next().is_some() {
                eprintln!("gamewiki init: {dir_str} is non-empty and not a vault — skipping");
                return;
            }
        }
        for f in ["app.json", "appearance.json"] {
            if let Err(e) = atomic_write(&dir.join(".obsidian").join(f), b"{}\n") {
                eprintln!("gamewiki init: scaffold {f} failed: {e:?}");
                return;
            }
        }
        let _ = atomic_write(&dir.join(".obsidian/core-plugins.json"), b"[]\n");
        let _ = atomic_write(&dir.join(".obsidian/community-plugins.json"), b"[]\n");
    }

    let canon = match is_valid_vault(&dir_str) {
        Ok(c) => c.to_string_lossy().into_owned(),
        Err(e) => {
            eprintln!("gamewiki init: still invalid after scaffold: {e:?}");
            return;
        }
    };
    let entry = VaultEntry {
        id: Uuid::new_v4().to_string(),
        name: "GameWiki".into(),
        path: canon.clone(),
        manifest_enabled: true, // densely wikilinked → manifest/graph ON
        role: "gamewiki".into(),
        mapping: None,
    };
    regen_manifest(&entry);
    set_role_global("gamewiki", &canon);
    reg.vaults.push(entry);
    if let Err(e) = persist_registry(reg_path, reg) {
        eprintln!("gamewiki init: persist failed: {e:?}");
    }
}

/// Resolve the active entry: the `activeId` if it points at a still-valid
/// vault, else the first valid entry, else `None` (caller degrades).
fn resolve_active(reg: &Registry) -> Option<VaultEntry> {
    if let Some(id) = &reg.active_id {
        if let Some(e) = reg.vaults.iter().find(|v| &v.id == id) {
            if is_valid_vault(&e.path).is_ok() {
                return Some(e.clone());
            }
        }
    }
    reg.vaults.iter().find(|v| is_valid_vault(&v.path).is_ok()).cloned()
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------
#[derive(Serialize)]
pub struct VaultsListOut {
    vaults: Vec<VaultEntry>,
    #[serde(rename = "activeId")]
    active_id: Option<String>,
}

#[tauri::command]
pub fn vaults_list(app: AppHandle) -> Result<VaultsListOut, VaultError> {
    let reg = load_registry(&registry_file(&app)?);
    Ok(VaultsListOut { vaults: reg.vaults, active_id: reg.active_id })
}

/// Resolve a registered vault's absolute path by id (any role). Used by the
/// Domain Builder's `scaffold_domain` to target a user-picked content vault,
/// which may not be the active one.
pub fn resolve_vault_path(app: &AppHandle, id: &str) -> Option<String> {
    let file = registry_file(app).ok()?;
    let reg = load_registry(&file);
    reg.vaults.into_iter().find(|v| v.id == id).map(|v| v.path)
}

/// Pre-flight check for the Add-Vault UI. Returns `Ok(true)` or a structured
/// `INVALID` error the frontend surfaces inline.
#[tauri::command]
pub fn validate_vault(path: String) -> Result<bool, VaultError> {
    is_valid_vault(&path)?;
    Ok(true)
}

#[tauri::command]
pub fn vaults_add(
    app: AppHandle,
    name: String,
    path: String,
    manifest_enabled: Option<bool>,
) -> Result<VaultsListOut, VaultError> {
    let canon = is_valid_vault(&path)?;
    let canon_str = canon.to_string_lossy().into_owned();
    let file = registry_file(&app)?;
    let mut reg = load_registry(&file);
    if reg.vaults.iter().any(|v| v.path == canon_str) {
        return Err(VaultError::Invalid("Vault already registered".into()));
    }
    let entry = VaultEntry {
        id: Uuid::new_v4().to_string(),
        name: if name.trim().is_empty() {
            canon.file_name().and_then(|s| s.to_str()).unwrap_or("Vault").to_string()
        } else {
            name.trim().to_string()
        },
        path: canon_str,
        manifest_enabled: manifest_enabled.unwrap_or(true),
        role: "content".into(),
        mapping: None,
    };
    regen_manifest(&entry); // build its manifest now so it's ready on first switch
    reg.vaults.push(entry);
    persist_registry(&file, &reg)?;
    Ok(VaultsListOut { vaults: reg.vaults, active_id: reg.active_id })
}

#[tauri::command]
pub fn vaults_remove(app: AppHandle, id: String) -> Result<VaultsListOut, VaultError> {
    let file = registry_file(&app)?;
    let mut reg = load_registry(&file);
    if reg.active_id.as_deref() == Some(id.as_str()) {
        return Err(VaultError::Invalid(
            "Switch to another vault before removing the active one".into(),
        ));
    }
    reg.vaults.retain(|v| v.id != id);
    persist_registry(&file, &reg)?;
    Ok(VaultsListOut { vaults: reg.vaults, active_id: reg.active_id })
}

#[tauri::command]
pub fn set_active_vault(app: AppHandle, id: String) -> Result<VaultEntry, VaultError> {
    let file = registry_file(&app)?;
    let mut reg = load_registry(&file);
    let entry = reg
        .vaults
        .iter()
        .find(|v| v.id == id)
        .cloned()
        .ok_or_else(|| VaultError::NotFound(format!("vault id {id}")))?;

    // Validate before mutating any global/state.
    is_valid_vault(&entry.path)?;

    // 1) flip the active root every IPC command resolves through
    set_active_global(&entry.path);
    // 1b) swap in the active vault's adapter mapping (SF4) so the re-rooted
    //     Knowledge/Infrastructure readers resolve against the right folders
    set_active_mapping(entry.mapping.clone());
    // 2) repoint + invalidate the manifest reader, then (re)build it
    set_active_manifest(&entry.id);
    crate::render::manifest::invalidate();
    regen_manifest(&entry);
    // 3) re-point the file watcher at the new root
    if let Err(e) = crate::watcher::respawn(app.clone()) {
        log::warn!("watcher respawn after vault switch failed: {e}");
    }
    // 4) persist the new active id
    reg.active_id = Some(entry.id.clone());
    persist_registry(&file, &reg)?;
    Ok(entry)
}

/// Manually (re)build a vault's manifest. Returns the indexed entry count.
#[tauri::command]
pub fn generate_manifest(app: AppHandle, id: String) -> Result<usize, VaultError> {
    let reg = load_registry(&registry_file(&app)?);
    let entry = reg
        .vaults
        .iter()
        .find(|v| v.id == id)
        .ok_or_else(|| VaultError::NotFound(format!("vault id {id}")))?;
    if let Some(dir) = manifest_dir() {
        let _ = fs::create_dir_all(&dir);
    }
    let out = manifest_path_for(&entry.id).ok_or(VaultError::ManifestUnavailable)?;
    let n = crate::commands::manifest_gen::generate_for(&entry.path, Path::new(&out))?;
    if reg.active_id.as_deref() == Some(id.as_str()) {
        crate::render::manifest::invalidate();
    }
    Ok(n)
}

/// Create a fresh Obsidian vault at `path`, register it as a content vault, and
/// return the updated registry list. The frontend switches to the new id to
/// drive the remount. REFUSES a non-empty target (the user is pointed at
/// "Add existing" to adopt instead). Writes only into an empty/nonexistent
/// folder via raw fs (`vault_write_file` can't touch an unregistered root), so
/// it can never clobber user data — the no-git safety net for create.
#[tauri::command]
pub fn scaffold_vault(
    app: AppHandle,
    name: String,
    path: String,
    manifest_enabled: Option<bool>,
) -> Result<VaultsListOut, VaultError> {
    let target = Path::new(&path);

    // 1) Refuse a non-empty target FIRST, before writing anything.
    match fs::read_dir(target) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.as_ref() == ".DS_Store" || name.as_ref() == "Thumbs.db" {
                    continue;
                }
                return Err(VaultError::Invalid(
                    "Folder isn't empty — use \u{201c}Add existing\u{201d} to adopt an existing vault, or pick an empty folder.".into(),
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(VaultError::Io(format!("read target folder: {e}"))),
    }

    // 2) Scaffold a clean Obsidian vault. atomic_write create_dir_all's the
    //    parent, so the .obsidian/ dir and the vault root are created here.
    atomic_write(&target.join(".obsidian/app.json"), b"{}\n")?;
    atomic_write(&target.join(".obsidian/appearance.json"), b"{}\n")?;
    atomic_write(&target.join(".obsidian/core-plugins.json"), b"[]\n")?;
    atomic_write(&target.join(".obsidian/community-plugins.json"), b"[]\n")?;
    let nm = if name.trim().is_empty() {
        target.file_name().and_then(|s| s.to_str()).unwrap_or("Vault").to_string()
    } else {
        name.trim().to_string()
    };
    let welcome = format!(
        "# Welcome to {nm}\n\nThis vault was created with Mortar & Pestle. Start writing \u{2014} make folders and notes however you like.\n"
    );
    atomic_write(&target.join("Welcome.md"), welcome.as_bytes())?;

    // 3) Validate (now that .obsidian/ exists) + register as a content vault.
    let canon = is_valid_vault(&path)?;
    let canon_str = canon.to_string_lossy().into_owned();
    let file = registry_file(&app)?;
    let mut reg = load_registry(&file);
    if reg.vaults.iter().any(|v| v.path == canon_str) {
        return Err(VaultError::Invalid("Vault already registered".into()));
    }
    let entry = VaultEntry {
        id: Uuid::new_v4().to_string(),
        name: nm,
        path: canon_str,
        manifest_enabled: manifest_enabled.unwrap_or(true),
        role: "content".into(),
        mapping: None,
    };
    regen_manifest(&entry); // build its manifest now so wikilinks resolve on first switch
    reg.vaults.push(entry);
    persist_registry(&file, &reg)?;
    Ok(VaultsListOut { vaults: reg.vaults, active_id: reg.active_id })
}

#[derive(Serialize)]
pub struct TopFolder {
    pub name: String,
    pub slug: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultShapeOut {
    /// True iff the vault has BOTH a `Knowledge/` and an `Infrastructure/`
    /// top-level folder — the signal that the curated two-section Vault View
    /// applies. A foreign vault is `false` → auto-discovery renders its real
    /// top-level folders instead.
    pub citadel_shaped: bool,
    /// True iff the vault has an SF4 mapping with a knowledge/infra root set —
    /// the curated view applies via re-rooting even when not literally
    /// Citadel-shaped, so the frontend keeps the two-section tree.
    pub mapped: bool,
    pub top_folders: Vec<TopFolder>,
    /// Manifest entry count (for the post-adopt summary). 0 if the vault has no
    /// manifest (manifests disabled, or not built yet).
    pub note_count: u32,
}

/// Shape probe for the active content vault (`id` = None) or a specific
/// registered vault (`id` = Some — used by the post-adopt summary, which runs
/// before the adopted vault is switched active). Lenient: a missing dir or
/// manifest degrades to empty folders / 0 notes rather than erroring.
#[tauri::command]
pub fn vault_list_top_folders(
    app: AppHandle,
    id: Option<String>,
) -> Result<VaultShapeOut, VaultError> {
    let reg = load_registry(&registry_file(&app)?);
    let entry = match id {
        Some(ref want) => reg.vaults.iter().find(|v| &v.id == want),
        None => reg
            .active_id
            .as_ref()
            .and_then(|aid| reg.vaults.iter().find(|v| &v.id == aid)),
    }
    .ok_or_else(|| VaultError::NotFound("vault not found".into()))?;

    // Folders hidden by the SF4 mapping are dropped from the discovery tree.
    let hide: std::collections::HashSet<String> = entry
        .mapping
        .as_ref()
        .map(|m| m.hide.iter().cloned().collect())
        .unwrap_or_default();

    // Real top-level folders (skip dot-dirs + hidden), sorted by name.
    let mut top_folders: Vec<TopFolder> = Vec::new();
    if let Ok(read) = fs::read_dir(&entry.path) {
        for ent in read.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || hide.contains(&name) {
                continue;
            }
            if ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                top_folders.push(TopFolder {
                    slug: crate::commands::knowledge::slugify(&name),
                    name,
                });
            }
        }
    }
    top_folders.sort_by(|a, b| a.name.cmp(&b.name));

    let names: std::collections::HashSet<&str> =
        top_folders.iter().map(|f| f.name.as_str()).collect();
    let citadel_shaped = names.contains("Knowledge") && names.contains("Infrastructure");
    let mapped = entry
        .mapping
        .as_ref()
        .map(|m| m.knowledge_root.is_some() || m.infra_root.is_some())
        .unwrap_or(false);

    // Note count from the vault's manifest file (best-effort).
    let note_count = manifest_path_for(&entry.id)
        .and_then(|p| fs::read_to_string(&p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("vault_file_count").and_then(|n| n.as_u64()))
        .unwrap_or(0) as u32;

    Ok(VaultShapeOut { citadel_shaped, mapped, top_folders, note_count })
}

/// Persist the opt-in adapter mapping for a vault (SF4). The UI restricts
/// editing to the active content vault; when `id` is active, the live
/// `ACTIVE_MAPPING` cell is updated so the re-rooted readers pick it up on the
/// next render (the frontend forces a remount). Returns the updated entry.
#[tauri::command]
pub fn set_vault_mapping(
    app: AppHandle,
    id: String,
    mapping: Option<VaultMapping>,
) -> Result<VaultEntry, VaultError> {
    let file = registry_file(&app)?;
    let mut reg = load_registry(&file);
    let updated = {
        let entry = reg
            .vaults
            .iter_mut()
            .find(|v| v.id == id)
            .ok_or_else(|| VaultError::NotFound(format!("vault id {id}")))?;
        entry.mapping = mapping;
        entry.clone()
    };
    if reg.active_id.as_deref() == Some(id.as_str()) {
        set_active_mapping(updated.mapping.clone());
    }
    persist_registry(&file, &reg)?;
    Ok(updated)
}

//! Release publishing — the "Ship Release" button's backend.
//!
//! The frontend composes the new `Releases.md` content (new block prepended,
//! all prior blocks preserved) and the emptied queue content, and computes the
//! next version; this command is the transactional writer. It writes the two
//! vault files (`Releases.md` + `Release Queue.md`) via the shared vault
//! helpers, then bumps the code version across the four version files —
//! reimplementing `scripts/sync-versions.mjs` in Rust so the one-click flow has
//! no node-on-PATH dependency (see `build.rs::resolve_npm` for why PATH is
//! unreliable in the installed RPM).

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::Serialize;

use crate::commands::vault::{atomic_write, check_mtime, mtime_ms, resolve_in, RootKind, VaultError};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePublishOut {
    pub ok: bool,
    pub version: String,
    pub releases_mtime: f64,
    pub queue_mtime: f64,
    /// Repo-relative paths of the version files that actually changed.
    pub version_files: Vec<String>,
}

/// Repo root (parent of `src-tauri/`). Overridable via `AGENTIC_CODE_ROOT` for
/// tests, mirroring `vault::vault_root`. `CARGO_MANIFEST_DIR` is baked at
/// compile time and resolves correctly in both `cargo tauri dev` and the
/// installed RPM (same precedent as `design::project_root`).
fn code_root() -> PathBuf {
    if let Ok(p) = std::env::var("AGENTIC_CODE_ROOT") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| {
            dirs::home_dir()
                .map(|h| h.join("Code").join("mortar-pestle"))
                .unwrap_or_else(|| PathBuf::from("mortar-pestle"))
        })
}

/// New bytes for a JSON file with `version` set, preserving key order
/// (serde_json `preserve_order`) and trailing-newline. `None` = already at
/// target (no write needed). Mirrors `sync-versions.mjs::updateJson`.
fn json_version_bytes(path: &Path, version: &str) -> Result<Option<Vec<u8>>, VaultError> {
    let raw = fs::read_to_string(path).map_err(|e| VaultError::Io(format!("{}: {e}", path.display())))?;
    let mut v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| VaultError::Io(format!("{}: {e}", path.display())))?;
    let before = v.get("version").and_then(|x| x.as_str()).map(String::from);
    if before.as_deref() == Some(version) {
        return Ok(None);
    }
    v["version"] = serde_json::Value::String(version.to_string());
    let pretty =
        serde_json::to_string_pretty(&v).map_err(|e| VaultError::Io(format!("{}: {e}", path.display())))?;
    let trailing = if raw.ends_with('\n') { "\n" } else { "" };
    Ok(Some(format!("{pretty}{trailing}").into_bytes()))
}

/// New bytes for `Cargo.toml` with the first `version = "..."` line set.
/// `None` = unchanged. Mirrors `sync-versions.mjs`'s Cargo regex.
fn cargo_version_bytes(path: &Path, version: &str) -> Result<Option<Vec<u8>>, VaultError> {
    let raw = fs::read_to_string(path).map_err(|e| VaultError::Io(format!("{}: {e}", path.display())))?;
    let re = Regex::new(r#"(?m)^(version\s*=\s*)"[^"]*""#).unwrap();
    let fixed = re.replace(&raw, format!(r#"$1"{version}""#).as_str()).into_owned();
    if fixed == raw {
        return Ok(None);
    }
    Ok(Some(fixed.into_bytes()))
}

#[tauri::command]
pub fn release_publish(
    releases_content: String,
    queue_content: String,
    version: String,
    releases_base_mtime: Option<f64>,
    queue_base_mtime: Option<f64>,
) -> Result<ReleasePublishOut, VaultError> {
    // 1. Validate version — 3-part semver only. Stacked 4-part hotfixes stay a
    //    manual Releases.md edit (Cargo.toml rejects non-semver).
    if !Regex::new(r"^\d+\.\d+\.\d+$").unwrap().is_match(&version) {
        return Err(VaultError::Invalid(format!(
            "version must be X.Y.Z (3-part semver), got: {version}"
        )));
    }

    // 2. Resolve both vault paths (sandboxed under the vault root).
    let (_, releases_abs) = resolve_in("Mortar & Pestle/Releases.md", RootKind::App)?;
    let (_, queue_abs) = resolve_in("Mortar & Pestle/Release Queue.md", RootKind::App)?;

    // 3. Mtime gate — CONFLICT if either file drifted since the modal read it.
    check_mtime(&releases_abs, releases_base_mtime)?;
    check_mtime(&queue_abs, queue_base_mtime)?;

    // 4. Pre-flight all four code-version files BEFORE any write, so a
    //    malformed/missing file aborts before Releases.md is touched.
    let root = code_root();
    let json_paths = [
        root.join("web/package.json"),
        root.join("package.json"),
        root.join("src-tauri/tauri.conf.json"),
    ];
    let cargo_path = root.join("src-tauri/Cargo.toml");

    let mut planned: Vec<(PathBuf, Vec<u8>, String)> = Vec::new();
    for p in &json_paths {
        if let Some(bytes) = json_version_bytes(p, &version)? {
            let label = p.strip_prefix(&root).unwrap_or(p).to_string_lossy().into_owned();
            planned.push((p.clone(), bytes, label));
        }
    }
    if let Some(bytes) = cargo_version_bytes(&cargo_path, &version)? {
        let label = cargo_path
            .strip_prefix(&root)
            .unwrap_or(&cargo_path)
            .to_string_lossy()
            .into_owned();
        planned.push((cargo_path.clone(), bytes, label));
    }

    // 5. Write — vault files first (reversible via git), then version files.
    atomic_write(&releases_abs, releases_content.as_bytes())?;
    atomic_write(&queue_abs, queue_content.as_bytes())?;
    let mut version_files = Vec::new();
    for (path, bytes, label) in planned {
        atomic_write(&path, &bytes)?;
        version_files.push(label);
    }

    // 6. Fresh mtimes for the writer contract.
    let releases_mtime = fs::metadata(&releases_abs).map(|m| mtime_ms(&m)).unwrap_or(0.0);
    let queue_mtime = fs::metadata(&queue_abs).map(|m| mtime_ms(&m)).unwrap_or(0.0);

    Ok(ReleasePublishOut {
        ok: true,
        version,
        releases_mtime,
        queue_mtime,
        version_files,
    })
}

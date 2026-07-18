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
use tokio::process::Command as TokioCommand;

use crate::commands::vault::{atomic_write, check_mtime, mtime_ms, resolve_in, RootKind, VaultError};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOut {
    /// Commit SHA of the version-bump commit (None unless inside a git repo with a bump).
    pub commit: Option<String>,
    /// The `vX.Y.Z` tag created (None unless inside a git repo).
    pub tag: Option<String>,
    /// True if the tag was pushed to `origin` (trips the release CI).
    pub pushed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePublishOut {
    pub ok: bool,
    pub version: String,
    pub releases_mtime: f64,
    pub queue_mtime: f64,
    /// Repo-relative paths of the version files that actually changed.
    pub version_files: Vec<String>,
    /// Git tie-in result — commit/tag/push of the version bump (see `git_release`).
    pub git_commit: Option<String>,
    pub git_tag: Option<String>,
    pub git_pushed: bool,
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

/// New bytes for `Cargo.lock` with the `mortar-pestle` app-crate package block's
/// version bumped. `None` = unchanged. Only that one block is touched — the name
/// pattern's closing quote excludes workspace siblings (`mortar-pestle-capture`
/// etc.). Without this, the lock's app-crate version drifts from `Cargo.toml`
/// and the pathspec-scoped release commit carries a stale lock (this is what
/// broke v0.0.23's publish: committed lock still at the old version). `\r?` keeps
/// it CRLF-tolerant.
fn cargo_lock_version_bytes(path: &Path, version: &str) -> Result<Option<Vec<u8>>, VaultError> {
    let raw = fs::read_to_string(path).map_err(|e| VaultError::Io(format!("{}: {e}", path.display())))?;
    let re = Regex::new(r#"(?m)^(name = "mortar-pestle"\r?\nversion = )"[^"]*""#).unwrap();
    let fixed = re.replace(&raw, format!(r#"$1"{version}""#).as_str()).into_owned();
    if fixed == raw {
        return Ok(None);
    }
    Ok(Some(fixed.into_bytes()))
}

/// True if `root` is inside a git work tree. Guard for end-user installs (no
/// repo, possibly no `git` on PATH) — returns false on any failure.
async fn in_git_repo(root: &Path) -> bool {
    TokioCommand::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .await
        .map(|o| {
            o.status.success()
                && std::str::from_utf8(&o.stdout).map(|s| s.trim() == "true").unwrap_or(false)
        })
        .unwrap_or(false)
}

fn git_err(step: &str, out: &std::process::Output) -> VaultError {
    VaultError::Io(format!(
        "git {step} failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// Commit the bumped version files, tag `vX.Y.Z`, and push the tag so the release
/// CI (`.github/workflows/release.yml`, `on: push: tags: ['v*']`) builds the NSIS
/// installer + `latest.json` and publishes them — installed apps then prompt to
/// update. The commit is scoped to `version_files` only (pathspec on `git
/// commit`), never `add -A`, so unrelated WIP isn't swept in. No-op when `root`
/// isn't a git repo or no version file changed.
async fn git_release(
    root: &Path,
    version: &str,
    version_files: &[String],
) -> Result<GitOut, VaultError> {
    if version_files.is_empty() || !in_git_repo(root).await {
        return Ok(GitOut { commit: None, tag: None, pushed: false });
    }
    let tag = format!("v{version}");

    // 1. Commit ONLY the version files — the pathspec scopes the commit and
    //    ignores any other staged WIP (matters under the worktree/concurrent
    //    session model; cf. closeout-commit-cant-target / concurrent-sweep).
    let commit = TokioCommand::new("git")
        .arg("-C")
        .arg(root)
        .args(["commit", "-m", &format!("chore(release): {tag}"), "--"])
        .args(version_files)
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("git commit spawn: {e}")))?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        if !stderr.contains("nothing to commit") && !stderr.contains("no changes added") {
            return Err(git_err("commit", &commit));
        }
    }
    let sha = TokioCommand::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "HEAD"])
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    // 2. Annotated tag (matches the existing `v0.8.2` convention).
    let tagged = TokioCommand::new("git")
        .arg("-C")
        .arg(root)
        .args(["tag", "-a", &tag, "-m", &format!("Mortar & Pestle {tag}")])
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("git tag spawn: {e}")))?;
    if !tagged.status.success() {
        let stderr = String::from_utf8_lossy(&tagged.stderr);
        if !stderr.contains("already exists") {
            return Err(git_err("tag", &tagged));
        }
    }

    // 3. Push the tag — carries the version-bump commit to the remote and trips
    //    the release CI. Hard error on failure: the vault + version bump + local
    //    commit + tag are already done, so the message tells the user to push
    //    manually rather than silently leaving the release unpublished.
    let push = TokioCommand::new("git")
        .arg("-C")
        .arg(root)
        .args(["push", "origin", &tag])
        .output()
        .await
        .map_err(|e| VaultError::Io(format!("git push spawn: {e}")))?;
    if !push.status.success() {
        return Err(VaultError::Io(format!(
            "Tagged {tag} locally, but `git push origin {tag}` failed: {}. \
             The vault, version bump, local commit, and tag are complete — push \
             manually to publish the update.",
            String::from_utf8_lossy(&push.stderr).trim()
        )));
    }

    // 4. If on `main`, also push `main` so the version-bump commit lands on the
    //    remote default branch (best-effort — the tag already carries the commit,
    //    so CI works regardless). Skipped in a worktree branch.
    let branch = TokioCommand::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if branch == "main" {
        let _ = TokioCommand::new("git")
            .arg("-C")
            .arg(root)
            .args(["push", "origin", "main"])
            .output()
            .await;
    }

    Ok(GitOut { commit: sha, tag: Some(tag), pushed: true })
}

#[tauri::command]
pub async fn release_publish(
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

    // 4. Pre-flight all five code-version files BEFORE any write, so a
    //    malformed/missing file aborts before Releases.md is touched.
    let root = code_root();
    let json_paths = [
        root.join("web/package.json"),
        root.join("package.json"),
        root.join("src-tauri/tauri.conf.json"),
    ];
    let cargo_path = root.join("src-tauri/Cargo.toml");
    let cargo_lock_path = root.join("src-tauri/Cargo.lock");

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
    // Cargo.lock's own app-crate block must move with Cargo.toml, or the
    // pathspec-scoped release commit ships a stale lock (broke v0.0.23).
    if let Some(bytes) = cargo_lock_version_bytes(&cargo_lock_path, &version)? {
        let label = cargo_lock_path
            .strip_prefix(&root)
            .unwrap_or(&cargo_lock_path)
            .to_string_lossy()
            .into_owned();
        planned.push((cargo_lock_path.clone(), bytes, label));
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

    // 7. Git tie-in — commit the version bump, tag vX.Y.Z, push the tag so the
    //    release CI builds + publishes the updater artifacts. No-op when `root`
    //    isn't a git repo (end-users) or no version file changed. The Release
    //    Queue panel is dev-gated in the frontend, so this only runs from the
    //    creator's dev window where the repo + git credentials live.
    let git = git_release(&root, &version, &version_files).await?;

    Ok(ReleasePublishOut {
        ok: true,
        version,
        releases_mtime,
        queue_mtime,
        version_files,
        git_commit: git.commit,
        git_tag: git.tag,
        git_pushed: git.pushed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    fn git(root: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("git spawns")
    }

    fn git_ok(root: &Path, args: &[&str]) {
        let o = git(root, args);
        assert!(
            o.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&o.stderr)
        );
    }

    #[tokio::test]
    async fn git_release_commits_tags_and_pushes() {
        let repo_dir = tempdir().expect("tempdir");
        let repo = repo_dir.path();
        let origin_dir = tempdir().expect("tempdir origin");
        let origin = origin_dir.path();

        // bare origin + working repo pointing at it
        assert!(
            Command::new("git")
                .arg("init")
                .arg("--bare")
                .arg(origin)
                .output()
                .expect("git init --bare")
                .status
                .success()
        );
        git_ok(repo, &["init"]);
        git_ok(repo, &["config", "user.email", "test@mortar-pestle"]);
        git_ok(repo, &["config", "user.name", "test"]);
        std::fs::create_dir_all(repo.join("web")).unwrap();
        std::fs::write(repo.join("web/package.json"), "{\n  \"version\": \"0.9.8\"\n}\n").unwrap();
        git_ok(repo, &["add", "-A"]);
        git_ok(repo, &["commit", "-m", "init"]);
        git_ok(repo, &["branch", "-M", "main"]);
        git_ok(repo, &["remote", "add", "origin", origin.to_str().unwrap()]);

        // bump to 0.9.9, then ship
        std::fs::write(repo.join("web/package.json"), "{\n  \"version\": \"0.9.9\"\n}\n").unwrap();
        let out = git_release(repo, "0.9.9", &["web/package.json".to_string()])
            .await
            .expect("git_release ok");
        assert_eq!(out.tag.as_deref(), Some("v0.9.9"));
        assert!(out.commit.is_some());
        assert!(out.pushed, "tag push should succeed against a bare origin");

        // tag + commit exist locally
        let tag = git(repo, &["rev-parse", "v0.9.9"]);
        assert!(tag.status.success(), "tag v0.9.9 missing: {}", String::from_utf8_lossy(&tag.stderr));
        let subj = git(repo, &["log", "-1", "--format=%s"]);
        assert_eq!(String::from_utf8_lossy(&subj.stdout).trim(), "chore(release): v0.9.9");

        // tag reached the bare origin
        let remote_tag = git(origin, &["rev-parse", "v0.9.9"]);
        assert!(remote_tag.status.success(), "tag not pushed to origin: {}", String::from_utf8_lossy(&remote_tag.stderr));
    }

    #[test]
    fn cargo_lock_bumps_only_app_crate() {
        let dir = tempdir().expect("tempdir");
        let p = dir.path().join("Cargo.lock");
        std::fs::write(
            &p,
            "[[package]]\nname = \"mortar-pestle-capture\"\nversion = \"0.0.22\"\n\n\
             [[package]]\nname = \"mortar-pestle\"\nversion = \"0.0.22\"\ndependencies = []\n",
        )
        .unwrap();
        let bytes = cargo_lock_version_bytes(&p, "0.0.23").unwrap().expect("changed");
        let out = String::from_utf8(bytes).unwrap();
        assert!(out.contains("name = \"mortar-pestle\"\nversion = \"0.0.23\""), "app crate bumped");
        assert!(
            out.contains("name = \"mortar-pestle-capture\"\nversion = \"0.0.22\""),
            "sibling crate untouched"
        );
        // idempotent: bumping already-target lock is a no-op
        std::fs::write(&p, &out).unwrap();
        assert!(cargo_lock_version_bytes(&p, "0.0.23").unwrap().is_none());
    }

    #[tokio::test]
    async fn git_release_noop_outside_repo() {
        let dir = tempdir().expect("tempdir");
        let out = git_release(dir.path(), "0.9.9", &["web/package.json".to_string()])
            .await
            .expect("ok");
        assert!(out.commit.is_none() && out.tag.is_none() && !out.pushed);
    }
}

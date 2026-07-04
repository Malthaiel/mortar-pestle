# Plan 005: Prune the stale 7878 capability grant and fix `vault_get_folder` containment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — otherwise skip. This plan has TWO
> independent findings (A and B); do both.
>
> **Drift check (run first)**:
> `git -C C:/Users/malth/Code/mortar-pestle diff --stat 57a6c80..HEAD -- src-tauri/capabilities/default.json src-tauri/src/commands/folder.rs`
> Expected: no output. If either file changed, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Two small, low-severity hardening fixes, unrelated except that both trim
unused/incorrect trust surface:

- **(A)** The main capability grants the **full** app IPC permission set to
  remote pages loaded from `http://127.0.0.1:7878` — the port of the **dead
  Fastify sidecar** (deleted in SF12; the current media server binds a
  kernel-random port, not 7878). Nothing loads from 7878 today, so this is a
  stale, over-broad grant: if anything ever bound that port or the app were
  induced to load that origin, it would inherit every IPC command. Remove it.

- **(B)** `resolve_root_path_in` (the read-lister path-safety helper) checks
  containment against a **moved base** (`canon_root.join(root)`) instead of the
  vault root, so a `..`/absolute component in the caller-supplied `root`/`rel`
  moves the base outside the vault and the target still passes. The module doc
  claims it "asserts containment under the canonical vault root" — which the
  code does not do (decision/code drift). **Severity is low and honestly
  bounded**: this helper is reachable only from the **trusted React chrome** —
  content webviews have a zero-grant IPC bridge (`capabilities/browser-content.json`),
  so no untrusted content can call it — and it is **read-only enumeration**, not
  a write. The mutating siblings (`vault_rename_path`/`create`/`delete`) already
  route through `resolve_in`, which rejects `..`. This is defense-in-depth plus
  fixing the doc drift, aligning the read path with the write path.

## Current state

### Finding A — stale 7878 remote grant

`src-tauri/capabilities/default.json:1-16` (the `remote` block is the target):
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "core:default plus each app command's allow-<command> permission. ...",
  "webviews": [
    "main",
    "overlay-host"
  ],
  "local": true,
  "remote": {
    "urls": [
      "http://127.0.0.1:7878/*",
      "http://localhost:7878/*"
    ]
  },
  "permissions": [
    "core:default",
    ...
```
The capability's `permissions` array lists `core:default` plus every app
`allow-*` command. `local: true` grants those to app-origin (`app://`) content —
the real app. `remote.urls` **additionally** grants the same set to pages served
from `127.0.0.1:7878` / `localhost:7878`.

A repo-wide grep for `7878` finds it in only two files:
- `src-tauri/capabilities/default.json:12-13` (this grant), and
- `src-tauri/src/proxy.rs:8,17,136,273` — **illustrative** doc comments and one
  unit-test literal (`split_host_port("127.0.0.1:7878")`), none of which load
  content from that origin.

No file under `web/` or `modules/` references `7878` — the frontend never
targets it. Removing the grant breaks nothing.

### Finding B — `resolve_root_path_in` anchors containment on the wrong path

`src-tauri/src/commands/folder.rs:11-13` (the module doc that over-claims):
```rust
//! Path safety: `resolve_root_path` canonicalizes the joined path and asserts
//! containment under the canonical vault root + root subdir — stricter than
//! Node's `startsWith` check.
```

`src-tauri/src/commands/folder.rs:103-127` (the helper — **the bug** is the
`canon_base` anchor):
```rust
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
```
`canon_base` is `fs::canonicalize(canon_root.join(root))` — if `root` (the IPC
slug) or `rel` contains `..`, `base` moves outside the vault and `canon_base`
follows it, so `canon_target` is (correctly) "under `canon_base`" and the check
passes even though it escaped the vault.

`vault_get_folder` forwards the raw IPC `slug` straight in,
`folder.rs:376-387`:
```rust
#[tauri::command]
pub fn vault_get_folder(
    slug: String,
    path: Option<String>,
    root: Option<String>,
) -> Result<FolderResult, VaultError> {
    let rel = path.unwrap_or_default();
    let root_path = RootKind::from_opt(root.as_deref()).root();
    let canon_root = fs::canonicalize(&root_path).unwrap_or_else(|_| PathBuf::from(&root_path));
    let abs = resolve_root_path_in(&rel, &slug, &canon_root)
        .ok_or_else(|| VaultError::NotFound(format!("Folder not found: {}/{}", slug, rel)))?;
    // ...
```
(`pulse_get_folder` at `folder.rs:303` uses the same helper.)

**The exemplar to mirror — the write path already does it right.**
`src-tauri/src/commands/vault.rs:356-398`, `resolve_in`, canonicalizes and then
anchors on the vault root:
```rust
pub fn resolve_in(rel_in: &str, kind: RootKind) -> Result<(String, PathBuf), VaultError> {
    let rel = normalize_rel(rel_in)?;          // rejects `..`, absolute, NUL
    let root = canonical_root_of(kind);
    let abs = root.join(&rel);
    let canon = match fs::canonicalize(&abs) { /* ... nearest-ancestor fallback ... */ };
    if !canon.starts_with(&root) {             // <-- anchored on the ROOT
        return Err(VaultError::Invalid("Path escapes vault root".into()));
    }
    Ok((rel, canon))
}
```
and `normalize_rel` (`vault.rs:319-346`) rejects `Component::ParentDir` (`..`),
`RootDir`/`Prefix` (absolute), NUL, and empty. The fix for B is to make the read
helper's containment match `resolve_in`'s `canon.starts_with(&root)` guarantee.

## How the fix works (read before writing)

- **(A)** Delete the entire `"remote": { ... },` block. `local: true` still
  grants all permissions to the real app; the frontend never uses 7878.
- **(B)** Replace the `canon_base`-anchored check with
  `canon_target.starts_with(canon_root)`. Because `starts_with` is true when
  paths are equal, this accepts every legitimate in-vault target and rejects any
  `..`/absolute/symlink escape above the vault root — exactly `resolve_in`'s
  guarantee. `fs::canonicalize` already resolved symlinks in `canon_target`, so
  a symlink pointing outside the vault is caught too. Then fix the module doc to
  stop claiming a "+ root subdir" guarantee the code doesn't (and now honestly)
  provide. A parallel `normalize_rel` call was **considered and rejected**: the
  anchor check already rejects every escape (including symlinks, which a
  string-level normalize would miss), so adding it would duplicate the guarantee
  and needlessly change the helper's behavior for its two callers.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Compile + Rust tests (also validates capability JSON via `tauri-build`) | `cargo test --manifest-path src-tauri/Cargo.toml --tests` (run in `C:/Users/malth/Code/mortar-pestle`) | compiles, all tests pass incl. 3 new folder tests, exit 0 |
| Confirm 7878 gone from the capability | `git -C C:/Users/malth/Code/mortar-pestle grep -n 7878 -- src-tauri/capabilities/default.json` | no output (exit 1) |
| JSON validity (quick) | `node -e "JSON.parse(require('fs').readFileSync('src-tauri/capabilities/default.json','utf8')); console.log('ok')"` | prints `ok` |

**Landmine — never run `cargo test --lib`**: it SIGTERMs the dev sandbox. Use
`--tests` only (it runs the in-module `#[cfg(test)]` unit tests, including the
new ones).

## Scope

**In scope**:
- `src-tauri/capabilities/default.json` — remove the `remote` block (Finding A).
- `src-tauri/src/commands/folder.rs` — fix `resolve_root_path_in` containment,
  fix the module doc, add a `#[cfg(test)] mod tests` (Finding B).

**Out of scope** (do NOT touch):
- `src-tauri/src/proxy.rs` — its `7878` mentions are illustrative doc comments
  and a unit-test literal; they are not a live grant and must stay.
- `resolve_in` / `normalize_rel` in `src-tauri/src/commands/vault.rs` — the write
  path is already correct; it is the exemplar, not a target.
- The mutation commands (`vault_rename_path`/`create_folder`/`delete_folder`) —
  already safe via `resolve_in`.
- `capabilities/browser-content.json` — the zero-grant content bridge; leave it.

## Git workflow

- Branch: `advisor/005-capability-and-folder-hardening`.
- One or two commits; repo style — e.g.
  `security(caps): drop stale 7878 remote grant` and
  `security(folder): anchor read-lister containment on vault root`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1 (Finding A): Remove the stale 7878 remote grant

In `src-tauri/capabilities/default.json`, delete the `remote` block (lines
10-15), so `"local": true,` is immediately followed by `"permissions": [`:
```json
  "local": true,
  "permissions": [
```
(Remove the six lines `"remote": {`, `"urls": [`, the two `7878` entries, `]`,
`},`.)

**Verify**:
- `node -e "JSON.parse(require('fs').readFileSync('src-tauri/capabilities/default.json','utf8')); console.log('ok')"` → prints `ok`.
- `git -C C:/Users/malth/Code/mortar-pestle grep -n 7878 -- src-tauri/capabilities/default.json` → no output.
- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → compiles (this
  runs `tauri-build`, which validates the capability JSON) and passes.

### Step 2 (Finding B): Anchor containment on the vault root

In `src-tauri/src/commands/folder.rs`, replace the `canon_base` check
(`folder.rs:117-126`) — i.e. from `let canon_base = fs::canonicalize(&base).ok()?;`
through the `if ... { return None; }` and `Some(canon_target)` — with:
```rust
    // Containment is anchored on the vault ROOT, not on `base`
    // (= canon_root.join(root)): a `..`/absolute component in the caller-supplied
    // `root` or `rel` moves `base` outside the vault, and canonicalizing that moved
    // base would wrongly accept the escape. `fs::canonicalize` already resolved any
    // symlinks in `canon_target`, so symlink escapes are caught too. Mirrors
    // `commands::vault::resolve_in`'s `canon.starts_with(&root)` gate.
    if !canon_target.starts_with(canon_root) {
        return None;
    }
    Some(canon_target)
```

Then fix the module doc (`folder.rs:11-13`) to match the real guarantee:
```rust
//! Path safety: `resolve_root_path_in` canonicalizes the joined path and asserts
//! containment under the canonical vault root (`canon_target.starts_with(canon_root)`),
//! rejecting `..`/absolute/symlink escapes — mirrors `commands::vault::resolve_in`.
```

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → compiles,
existing tests still pass (the new tests are added in Step 3).

### Step 3 (Finding B): Add a unit test proving traversal is rejected

Append a test module to the end of `src-tauri/src/commands/folder.rs`. This
mirrors the repo convention (`#[cfg(test)] mod tests` with `use super::*` — see
`src-tauri/src/commands/media.rs:385`; `tempfile::TempDir` is a dev-dependency,
used by `parsers/video_transcode.rs` tests):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // A `..` in the slug (`root`) must not escape the vault root.
    #[test]
    fn rejects_parent_traversal_in_slug() {
        let tmp = TempDir::new().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let outside = root.parent().unwrap().join("outside_vault_005a");
        fs::create_dir_all(&outside).unwrap();
        let escaped = resolve_root_path_in("", "../outside_vault_005a", &root);
        let _ = fs::remove_dir_all(&outside);
        assert!(escaped.is_none(), "slug `..` traversal must be rejected");
    }

    // A `..` in the `rel` (path) must not escape the vault root either.
    #[test]
    fn rejects_parent_traversal_in_rel() {
        let tmp = TempDir::new().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(root.join("Area")).unwrap();
        let outside = root.parent().unwrap().join("outside_vault_005b");
        fs::create_dir_all(&outside).unwrap();
        let escaped = resolve_root_path_in("../../outside_vault_005b", "Area", &root);
        let _ = fs::remove_dir_all(&outside);
        assert!(escaped.is_none(), "rel `..` traversal must be rejected");
    }

    // A legitimate in-vault folder still resolves (no false rejection).
    #[test]
    fn accepts_in_vault_path() {
        let tmp = TempDir::new().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(root.join("Area")).unwrap();
        let ok = resolve_root_path_in("", "Area", &root)
            .expect("legit in-vault folder must resolve");
        assert!(ok.starts_with(&root));
    }
}
```

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all pass,
including `rejects_parent_traversal_in_slug`, `rejects_parent_traversal_in_rel`,
and `accepts_in_vault_path`. To run just these:
`cargo test --manifest-path src-tauri/Cargo.toml --tests traversal` runs the two
traversal tests (expect `2 passed`).

## Test plan

- New tests in `src-tauri/src/commands/folder.rs` (`mod tests`):
  - `rejects_parent_traversal_in_slug` — the exact bug (slug `..` escape) is now rejected.
  - `rejects_parent_traversal_in_rel` — `..` in the `path` arg is rejected.
  - `accepts_in_vault_path` — a normal in-vault folder still resolves (guards against over-rejection).
- Structural pattern: model after `src-tauri/src/commands/media.rs`'s
  `#[cfg(test)] mod tests` and the `TempDir` usage in
  `src-tauri/src/parsers/video_transcode.rs` tests.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all
  pass, including the 3 new tests. Report the observed pass count.

## Done criteria

ALL must hold:

- [ ] `src-tauri/capabilities/default.json` has no `remote` block; `git grep 7878` on that file returns nothing.
- [ ] `node -e "JSON.parse(...)"` prints `ok` (valid JSON).
- [ ] `resolve_root_path_in` gate reads `if !canon_target.starts_with(canon_root) { return None; }`.
- [ ] The module doc no longer claims "+ root subdir".
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0, with the 3 new folder tests passing.
- [ ] `git status` shows only the two in-scope files modified.
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The drift check shows `default.json` or `folder.rs` changed since `57a6c80`
  and the live code no longer matches the excerpts.
- After removing the `remote` block, `cargo test ... --tests` fails to compile
  because `tauri-build` rejects the capability JSON (means the edit malformed
  the file) — re-check the JSON structure; if still failing after one fix, stop.
- `accepts_in_vault_path` fails — the anchor change is over-rejecting legitimate
  paths; do not loosen the check to pass it without understanding why.
- A grep reveals a live consumer of `127.0.0.1:7878` under `web/`/`modules/`
  (there should be none) — surface it rather than removing a grant something
  depends on.
- The fix appears to require touching `proxy.rs`, `vault.rs`, or the content
  bridge capability.

## Maintenance notes

For whoever owns these files next:

- **(A)** If a future feature reintroduces a loopback HTTP surface that the
  webview must load *pages* from (not just fetch bytes), grant it a **narrow,
  purpose-built capability** scoped to only the permissions it needs — do not
  re-add a blanket `remote` grant of the full command set. The media server
  serves bytes over `fetch`/`<video>` (not navigable pages) and needs no
  capability grant at all.
- **(B)** `resolve_root_path_in` now matches `resolve_in`'s vault-root
  containment. It enforces containment under the **vault root**, not under a
  specific top-level area — the same boundary the write path enforces and the
  actual security boundary (content webviews can't reach this command anyway).
  If a future requirement needs true per-area confinement, add an explicit
  area-prefix check on top; don't reintroduce the `canon_base` anchor.
- A reviewer should confirm both `vault_get_folder` and `pulse_get_folder` still
  list real folders after the change (the `accepts_in_vault_path` test covers the
  helper; a quick manual click through the Vault File Tree and Pulse browser
  confirms end to end).

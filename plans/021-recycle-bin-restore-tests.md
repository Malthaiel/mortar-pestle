# Plan 021: Characterization tests for recycle-bin restore + collision handling

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` if that file exists — unless a reviewer dispatched you and
> told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/recycle_bin.rs src-tauri/src/commands/sidebar.rs src-tauri/tests/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (`src-tauri/tests/recycle_bin.rs` is a
> new file — it will not exist at 57a6c80.)

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline-and-ci.md` (creates `scripts/verify.mjs`, the aggregate this plan wires its new test target into, and establishes the SIGTERM-safe cargo invocation).
- **Category**: tests
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

`src-tauri/src/commands/recycle_bin.rs` is 1264 lines and has **zero tests**
(`grep -c "#\[test\]" src-tauri/src/commands/recycle_bin.rs` → 0). It is the
app's *global soft-delete store* — the feature whose entire job is to PREVENT
data loss. Restore writes back into the user's **real** vault, and the code
itself flags the danger: the EXDEV-safe move helper carries the comment "the
one place silent data loss could occur" (line 213). A bug in that move, in the
path resolver's traversal guard, or in the rename-suggestion could clobber an
occupied file, escape the vault root, or drop bytes on the floor — silent,
irreversible loss on the anti-loss feature.

This plan pins the **app-free primitives** that carry that risk
(`move_path`, `copy_dir_recursive`, `resolve_target`, `suggested_rename`,
`dir_stats`, `leaf_name`, `parent_dir`) with characterization tests — asserting
*current* behavior so a future refactor can't silently change it. The
end-to-end conflict-gate characterization (occupied/skip/rename/parent_missing
round-trips through `recycle_bin_restore`) is **deliberately deferred**: it is
blocked by a hard typing wall documented under "STOP conditions" and Maintenance
notes, and it requires a production refactor that belongs in its own reviewable
plan.

## Current state

Facts inlined — the executor has not seen this repo.

### The file and the risk primitive

`src-tauri/src/commands/recycle_bin.rs` — the recycle-bin command module
(`pub mod recycle_bin` is confirmed in `src-tauri/src/commands/mod.rs:48`, so it
is reachable from an external integration test as
`app_lib::commands::recycle_bin::*`). Its module banner names the move helper as
the sole silent-data-loss site:

```rust
// ── EXDEV-safe move (the one place silent data loss could occur) ──          // line 213
```

`move_path` — same-device `rename`, falling back to copy+remove across
filesystems, with a strict "unlink source only after copy fully succeeds"
ordering (recycle_bin.rs:232–253):

```rust
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
```

`suggested_rename` — the "Name (restored).ext" collision name (recycle_bin.rs:309–314):

```rust
fn suggested_rename(label: &str) -> String {
    match label.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} (restored).{ext}"),
        _ => format!("{label} (restored)"),
    }
}
```

`resolve_target` — the restore-path resolver with the traversal + root-escape
guards, tolerant of a missing parent dir (recycle_bin.rs:320–331):

```rust
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
```

`dir_stats` — recursive `(file_count, total_bytes)` for a folder being trashed
(recycle_bin.rs:288–305). `leaf_name`/`parent_dir` — path-tail/parent string
helpers (recycle_bin.rs:278–285):

```rust
fn leaf_name(rel: &str) -> String { rel.rsplit('/').next().unwrap_or(rel).to_string() }
fn parent_dir(rel: &str) -> Option<String> {
    rel.rfind('/').map(|i| rel[..i].to_string()).filter(|s| !s.is_empty())
}
```

`RootKind::from_opt(None)` → `RootKind::Content` → `vault_root()`, and
`vault_root()`'s **first precedence is the `AGENTIC_VAULT_ROOT` env var**
(`src-tauri/src/commands/vault.rs:24–27`). So `resolve_target(&None, rel)`
resolves under whatever `AGENTIC_VAULT_ROOT` points at.

### Why the end-to-end restore path is NOT directly testable here

`recycle_bin_restore` is a Tauri command whose first parameter is a **concrete
`AppHandle`** (recycle_bin.rs:881–887):

```rust
#[tauri::command]
pub fn recycle_bin_restore(
    app: AppHandle,           // == AppHandle<Wry> (bare AppHandle uses the default runtime)
    id: String,
    conflict: Option<String>,
    rename_to: Option<String>,
) -> Result<RestoreOut, VaultError> {
```

The `app` is used **only** to locate the bin's storage root, through
`app_config_root`, whose first line short-circuits on an env var and never
touches `app.path()` when it is set (`src-tauri/src/commands/sidebar.rs:28–35`):

```rust
pub fn app_config_root(app: &AppHandle) -> Result<PathBuf, VaultError> {
    if let Ok(v) = std::env::var("AGENTIC_APP_CONFIG_ROOT") {
        return Ok(PathBuf::from(v));
    }
    app.path().app_config_dir().map_err(/* … */)
}
```

So the handle is functionally inert under an env override — but you still need a
*value of type `AppHandle<Wry>`* to call the command, and **there is no way to
construct one in a `--test` binary**:

- `tauri::test::mock_app()` yields `App<MockRuntime>` → `AppHandle<MockRuntime>`,
  which does **not** type-match the command's `AppHandle<Wry>`.
- The `test` feature that would even expose `tauri::test` is **not enabled**
  (`src-tauri/Cargo.toml:25` has `features = ["devtools", "unstable"]`, no
  `test`; no `[dev-dependencies] tauri` override).
- A real `Wry` handle needs an event loop / window — not available headless in a
  test binary.

Making the command callable requires an app-free `_inner` split (see Maintenance
notes) — a **production refactor**, out of scope for this tests-only plan. The
same wall blocks the `trash_*` capture helpers (all take `&AppHandle`), so the
"trash then restore" round-trip cannot be driven either. This is the
"STOP if restore can't be driven without a live AppHandle (note the needed
helper)" case: the needed helper is documented, and the achievable subset (the
app-free primitives) is what this plan delivers.

### The test idiom to mirror

`src-tauri/tests/integration.rs` is the repo's temp-vault integration-test
pattern. It imports **`pub`** functions from the lib and asserts on structural
results — note it already imports helper functions that were made `pub` for
exactly this purpose (integration.rs:41):

```rust
use app_lib::commands::sidebar::{get_order_inner, set_order_inner};
```

The shared env helper (`src-tauri/tests/common/mod.rs`):

```rust
static ENV_LOCK: Mutex<()> = Mutex::new(());
pub fn env_lock() -> MutexGuard<'static, ()> { ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner()) }
```

`tempfile = "3"` is present in `[dev-dependencies]` (`src-tauri/Cargo.toml:100`).

### The SIGTERM-safe cargo invocation (IMPORTANT — read `plans/002`)

Do **NOT** run `cargo test --tests` or `cargo test --lib`. Per
`plans/002-verification-baseline-and-ci.md` (lines 86–104), the `--tests`
(plural) flag re-includes the library unit tests, which **SIGTERM the dev
sandbox**. The safe form enumerates integration targets explicitly with
`--test <name>`. This plan's new tests therefore live in a **new integration
target** (`src-tauri/tests/recycle_bin.rs`), NOT a `#[cfg(test)]` module inside
`recycle_bin.rs` — a `#[cfg(test)]` mod is a lib unit test and would never be
run by the SIGTERM-safe baseline.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/recycle_bin.rs` | no output (unchanged) |
| Run ONLY the new target | `cargo test --manifest-path src-tauri/Cargo.toml --test recycle_bin` | `test result: ok. 8 passed; 0 failed` |
| Full aggregate (after wiring) | `node scripts/verify.mjs` | exit 0, prints `✓ verify passed` |
| Count existing tests in the file | `grep -c "#\[test\]" src-tauri/src/commands/recycle_bin.rs` | `0` before, `0` after (tests live in tests/, not the src file) |

## Scope

**In scope** (the only files you may modify/create):
- `src-tauri/src/commands/recycle_bin.rs` — **visibility only**: change the seven
  named helpers from `fn` to `pub fn`. No body/behavior change. (This mirrors the
  `get_order_inner`/`set_order_inner` `pub` precedent that `integration.rs` relies
  on.)
- `src-tauri/tests/recycle_bin.rs` — **create**: the characterization tests.
- `scripts/verify.mjs` — add `'--test', 'recycle_bin',` to the cargo step's args
  (the file is created by plan 002; if it does not yet exist, see STOP conditions).

**Out of scope** (do NOT touch, even though they look related):
- The **body** of any function in `recycle_bin.rs` — this plan pins current
  behavior; it must not change it. In particular do NOT extract `recycle_bin_restore`
  or the `trash_*` helpers into `_inner` variants here (that is the deferred
  follow-up plan — see Maintenance notes).
- `recycle_bin_restore` / `restore_record` / the conflict-gate logic — blocked by
  the AppHandle wall; deferred.
- Any other `src-tauri/src/**` file.

## Git workflow

- Branch: `advisor/021-recycle-bin-tests` (or the repo's branch convention if one
  is evident from `git branch -a`).
- Commit per step or logical unit; match the repo's commit style (`git log --oneline -10`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Widen the seven app-free helpers to `pub`

In `src-tauri/src/commands/recycle_bin.rs`, change exactly these declarations
from `fn` to `pub fn` (do not touch their bodies):

- `fn move_path(` (line 232) → `pub fn move_path(`
- `fn copy_dir_recursive(` (line 255) → `pub fn copy_dir_recursive(`
- `fn leaf_name(` (line 278) → `pub fn leaf_name(`
- `fn parent_dir(` (line 281) → `pub fn parent_dir(`
- `fn dir_stats(` (line 288) → `pub fn dir_stats(`
- `fn suggested_rename(` (line 309) → `pub fn suggested_rename(`
- `fn resolve_target(` (line 320) → `pub fn resolve_target(`

**Verify**: `cargo build --manifest-path src-tauri/Cargo.toml` → exit 0. Then
`grep -nE "pub fn (move_path|copy_dir_recursive|leaf_name|parent_dir|dir_stats|suggested_rename|resolve_target)\(" src-tauri/src/commands/recycle_bin.rs`
→ 7 matching lines.

### Step 2: Create `src-tauri/tests/recycle_bin.rs` with the characterization tests

Mirror `integration.rs`'s structure. The tests are app-free — most need no env;
the two that call `resolve_target` with a real root hold `common::env_lock()` and
set `AGENTIC_VAULT_ROOT`. Write these **8** tests (assert on *current* behavior):

```rust
//! Characterization tests for the recycle-bin's app-free primitives — the
//! functions that carry the silent-data-loss risk (move_path is "the one place
//! silent data loss could occur", recycle_bin.rs:213). These PIN current
//! behavior; they are not driving recycle_bin_restore (blocked by the
//! AppHandle<Wry> wall — see plan 021 Maintenance notes).

mod common;

use std::fs;
use app_lib::commands::recycle_bin::{
    copy_dir_recursive, dir_stats, leaf_name, move_path, parent_dir, resolve_target, suggested_rename,
};
use app_lib::commands::vault::VaultError;

// 1. move_path: same-device file move is byte-identical + unlinks the source.
#[test]
fn move_path_moves_file_bytes_identically() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("a.bin");
    let dst = dir.path().join("nested/b.bin"); // parent does not exist yet
    let bytes = b"\x00\x01payload\xff\xfe";
    fs::write(&src, bytes).unwrap();

    move_path(&src, &dst).unwrap();

    assert!(!src.exists(), "source must be unlinked after a move");
    assert_eq!(fs::read(&dst).unwrap(), bytes, "bytes must survive the move");
}

// 2. move_path: a whole directory subtree moves intact.
#[test]
fn move_path_moves_directory_tree() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("tree");
    fs::create_dir_all(src.join("sub")).unwrap();
    fs::write(src.join("root.txt"), b"r").unwrap();
    fs::write(src.join("sub/leaf.txt"), b"l").unwrap();
    let dst = dir.path().join("moved");

    move_path(&src, &dst).unwrap();

    assert!(!src.exists(), "source dir must be gone");
    assert_eq!(fs::read_to_string(dst.join("root.txt")).unwrap(), "r");
    assert_eq!(fs::read_to_string(dst.join("sub/leaf.txt")).unwrap(), "l");
}

// 3. copy_dir_recursive clones a nested tree (leaves the source in place).
#[test]
fn copy_dir_recursive_clones_nested_tree() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src");
    fs::create_dir_all(src.join("a/b")).unwrap();
    fs::write(src.join("a/b/x.txt"), b"deep").unwrap();
    let dst = dir.path().join("dst");

    copy_dir_recursive(&src, &dst).unwrap();

    assert!(src.join("a/b/x.txt").exists(), "copy must not remove the source");
    assert_eq!(fs::read_to_string(dst.join("a/b/x.txt")).unwrap(), "deep");
}

// 4. suggested_rename: ext / no-ext / dotfile (empty stem) / multi-dot.
#[test]
fn suggested_rename_covers_all_label_shapes() {
    assert_eq!(suggested_rename("Notes.md"), "Notes (restored).md");
    assert_eq!(suggested_rename("folder"), "folder (restored)");
    // rsplit_once('.') on ".gitignore" => ("", "gitignore"); empty stem falls to
    // the catch-all arm, so no ".gitignore.(restored)" corruption.
    assert_eq!(suggested_rename(".gitignore"), ".gitignore (restored)");
    assert_eq!(suggested_rename("archive.tar.gz"), "archive.tar (restored).gz");
}

// 5. resolve_target rejects a `..` traversal component BEFORE any root lookup
//    (no env needed — the guard is the first statement).
#[test]
fn resolve_target_rejects_dotdot_traversal() {
    let res = resolve_target(&None, "a/../b");
    assert!(
        matches!(res, Err(VaultError::Invalid(ref m)) if m.contains("traversal")),
        "expected an Invalid(\"…traversal…\") error, got {res:?}"
    );
}

// 6. resolve_target joins a clean relative path under AGENTIC_VAULT_ROOT.
#[test]
fn resolve_target_joins_relative_under_vault_root() {
    let _g = common::env_lock();
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("AGENTIC_VAULT_ROOT", dir.path().display().to_string());

    let abs = resolve_target(&None, "sub/file.md").unwrap();

    // Normalize separators so the assertion is Windows-safe (canonicalize may add
    // a \\?\ prefix and backslashes).
    let s = abs.to_string_lossy().replace('\\', "/");
    assert!(s.ends_with("sub/file.md"), "resolved path was {s}");
}

// 7. dir_stats returns (recursive file count, total bytes).
#[test]
fn dir_stats_counts_files_and_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("album");
    fs::create_dir_all(root.join("art")).unwrap();
    fs::write(root.join("track1.txt"), b"12345").unwrap();      // 5 bytes
    fs::write(root.join("art/cover.txt"), b"abc").unwrap();     // 3 bytes

    let (count, size) = dir_stats(&root);

    assert_eq!(count, 2, "two files across the subtree");
    assert_eq!(size, 8, "5 + 3 bytes");
}

// 8. leaf_name / parent_dir edge cases.
#[test]
fn leaf_name_and_parent_dir_edges() {
    assert_eq!(leaf_name("a/b/c.md"), "c.md");
    assert_eq!(leaf_name("top.md"), "top.md");
    assert_eq!(parent_dir("a/b/c.md"), Some("a/b".to_string()));
    assert_eq!(parent_dir("top.md"), None); // no slash → no parent
}
```

Notes for the executor:
- If a helper's real signature differs from the excerpts (drift), STOP — do not
  guess. The signatures used above are: `move_path(&Path, &Path) -> Result<(), VaultError>`,
  `copy_dir_recursive(&Path, &Path) -> Result<(), VaultError>`,
  `resolve_target(&Option<String>, &str) -> Result<PathBuf, VaultError>`,
  `suggested_rename(&str) -> String`, `dir_stats(&Path) -> (u32, u64)`,
  `leaf_name(&str) -> String`, `parent_dir(&str) -> Option<String>`.
- `mod common;` reuses `src-tauri/tests/common/mod.rs`; `common::env_lock()` must
  be held whenever a test sets `AGENTIC_VAULT_ROOT` (only test 6 here).

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --test recycle_bin`
→ `test result: ok. 8 passed; 0 failed; 0 ignored`.

### Step 3: Wire the new target into `scripts/verify.mjs`

In `scripts/verify.mjs` (created by plan 002), find the `rust integration tests`
step's `args` array (the list of `'--test', '<name>'` pairs) and add the new
target so the aggregate runs it:

```js
      '--test', 'vault_io_sanity',
      '--test', 'recycle_bin',            // ← add this line
      '--test', 'transcode_integration',
```

**Verify**: `node scripts/verify.mjs` → exit 0, prints `✓ verify passed`, and its
output includes a `recycle_bin` test-run line reporting `8 passed`.

## Test plan

- New file `src-tauri/tests/recycle_bin.rs`, 8 tests, covering: byte-identical
  file move + source unlink (the silent-loss primitive), directory-tree move,
  recursive copy fidelity, all four `suggested_rename` label shapes (incl. the
  dotfile empty-stem edge), the `..` traversal rejection, a clean relative-path
  resolve under the vault root, recursive `dir_stats` accounting, and
  `leaf_name`/`parent_dir` edges.
- Structural pattern mirrored: `src-tauri/tests/integration.rs` (temp dirs +
  `common::env_lock`).
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --test recycle_bin`
  → 8 passed; then `node scripts/verify.mjs` → `✓ verify passed`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cargo build --manifest-path src-tauri/Cargo.toml` exits 0.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --test recycle_bin` → `8 passed; 0 failed`.
- [ ] The seven helpers are `pub fn` (`grep -cE "pub fn (move_path|copy_dir_recursive|leaf_name|parent_dir|dir_stats|suggested_rename|resolve_target)\(" src-tauri/src/commands/recycle_bin.rs` → 7).
- [ ] No `recycle_bin.rs` function **body** changed (`git diff src-tauri/src/commands/recycle_bin.rs` shows only `fn` → `pub fn` on the 7 lines).
- [ ] `scripts/verify.mjs` contains `'--test', 'recycle_bin'` and `node scripts/verify.mjs` exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated (only if that index exists).

## STOP conditions

Stop and report back (do not improvise) if:

- **`scripts/verify.mjs` does not exist yet** — plan 002 (its creator) has not
  run. Complete Steps 1–2, run the standalone verify command
  (`cargo test … --test recycle_bin`), and report that Step 3 (verify.mjs wiring)
  is blocked on plan 002. Do NOT create `verify.mjs` here.
- **`cargo test … --test recycle_bin` SIGTERMs or is killed.** These tests do only
  temp-dir filesystem I/O (no subprocess, no AppHandle, no daemon) and must not
  trigger the lib-unit SIGTERM hazard. If they do, first confirm you did NOT use
  `--lib` or `--tests`; if you used the exact `--test recycle_bin` form and it
  still dies, report it.
- Any helper's on-disk signature or body does not match the "Current state"
  excerpts (drift since 57a6c80).
- You find yourself needing to change a function **body** in `recycle_bin.rs` to
  make a test pass — that means either drift or a scope error; stop and report.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this after it lands:

- **Deferred follow-up — end-to-end conflict-gate characterization.** The
  documented conflict gates in `recycle_bin_restore` (recycle_bin.rs:933–968:
  `parent_missing` / `occupied` + `skip` no-op / `rename` sibling / `overwrite`
  removes-then-moves) and the `RecordBlock` splice (`restore_record`, 1069–1149)
  are **not** covered here because the command takes an `AppHandle<Wry>` that
  cannot be constructed in a `--test` binary. A separate plan
  (`023-recycle-bin-restore-inner-extraction`) should: (1) extract an app-free
  `restore_inner(trash_root: &Path, …) -> RestoreOut` from `recycle_bin_restore`
  and matching `trash_*_inner(trash_root: &Path, …)` helpers — mirroring the
  `get_order_inner`/`set_order_inner` split — leaving each `#[tauri::command]` a
  thin `app_config_root → trash_root → *_inner` wrapper; then (2) add
  trash→restore round-trip tests per payload variant to
  `tests/recycle_bin.rs`. That is a **production refactor** and must be its own
  reviewed change — you should not restructure untested restore code and call the
  result "characterized" in the same breath; land these primitive tests first.
- **What a reviewer should scrutinize**: that Step 1 is visibility-only (diff is
  seven `fn`→`pub fn` lines and nothing else), and that no assertion encodes a
  *desired* behavior rather than the *current* one (these are characterization
  tests — they document what IS).

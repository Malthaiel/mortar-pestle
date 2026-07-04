# Plan 023: Test the self-update binary-rotation and atomic revert swap

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that index file exists — otherwise skip it (the
> advisor maintains the index separately; do not create it).
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/self_update.rs scripts/rotate-binary.mjs`
> This plan's excerpts were verified byte-identical between `57a6c80` and the
> working tree. If that diff is now non-empty, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline-and-ci.md` (must land first — it establishes the one-command Rust test invocation this plan relies on)
- **Category**: tests
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

The in-app updater's most dangerous operation has no test. `app_self_revert`
(`src-tauri/src/commands/self_update.rs:177-207`) does a 3-rename swap to put the
previous binary back after a bad update; a bug in that dance can leave the user
with a broken binary and no working rollback. Its own doc comment
(self_update.rs:6-7) says it "atomically swaps `mortar-pestle.prev` back into
place." The companion `mortar-pestle → .prev → .prev2` rotation in
`scripts/rotate-binary.mjs` — which produces the `.prev` that revert depends on —
is likewise untested. Today the module's tests cover only `hash_file` and
`prefix` string-slicing (self_update.rs:262-291), giving false confidence. This
plan extracts the revert swap into a pure, path-taking helper and tests both the
swap (happy path + the mid-swap failure that must not lose the previous binary)
and the rotation.

## Current state

### The revert swap (Rust)

`app_self_revert` is a `#[tauri::command]` that takes an `AppHandle` and ends with
`app.restart()`, so it is not directly unit-testable. The swap logic in the middle,
however, is pure filesystem work. Current code (self_update.rs:176-207):

```rust
#[tauri::command]
pub fn app_self_revert(app: AppHandle) -> Result<(), String> {
    let current = BINARY_PATH
        .get()
        .ok_or_else(|| "binary path not initialized".to_string())?
        .clone();
    let dir = current
        .parent()
        .ok_or_else(|| "no parent dir".to_string())?
        .to_path_buf();
    let prev = dir.join("mortar-pestle.prev");
    if !prev.exists() {
        return Err("no previous binary to revert to".into());
    }
    let tmp = dir.join("mortar-pestle.tmp_revert");

    // 3-rename atomic swap. Each rename is atomic on the same filesystem;
    // partial failure rolls back best-effort and surfaces the original error.
    if let Err(e) = fs::rename(&current, &tmp) {
        return Err(format!("revert step 1 (current -> tmp): {e}"));
    }
    if let Err(e) = fs::rename(&prev, &current) {
        let _ = fs::rename(&tmp, &current);
        return Err(format!("revert step 2 (prev -> current): {e}"));
    }
    if let Err(e) = fs::rename(&tmp, &prev) {
        let _ = fs::rename(&current, &prev);
        let _ = fs::rename(&tmp, &current);
        return Err(format!("revert step 3 (tmp -> prev): {e}"));
    }
    app.restart();
}
```

The swap semantics: `current`(new/broken) → `tmp`, then `prev`(old/good) →
`current`, then `tmp` → `prev`. Net result on success: `current` holds the old
good binary (byte-identical to what `prev` held) and `prev` holds the new one.

Imports at the top of the file (self_update.rs:13-15):
```rust
use std::fs;
use std::io::Read;
use std::path::PathBuf;
```
`AppHandle::restart()` returns `!` (never), which is why the function body can end
with `app.restart();` under a `Result<(), String>` return type.

Existing test module (self_update.rs:256-292) — the pattern to extend, already runs
under the repo test command and already uses the `tempfile` dev-dep:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn hash_file_stable_for_same_content() { /* ... */ }
    // ...
}
```

### The rotation script (Node)

`scripts/rotate-binary.mjs` (31 lines) is a pre-build hook, wired into
`src-tauri/tauri.conf.json:10`:
`"beforeBuildCommand": "npm --prefix web run build && node scripts/rotate-binary.mjs && node scripts/fetch-usda-db.mjs"`.
It currently runs its logic as top-level side effects against a hardcoded real
directory, so it cannot be exercised against a temp dir as written:

```js
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const releaseDir = join(__dirname, '..', 'src-tauri', 'target', 'release');

if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
  console.log('[rotate-binary] no target/release/ yet — first build, nothing to rotate');
  process.exit(0);
}

const current = join(releaseDir, 'mortar-pestle');
const prev    = join(releaseDir, 'mortar-pestle.prev');
const prev2   = join(releaseDir, 'mortar-pestle.prev2');

function safeUnlink(p) { try { if (existsSync(p)) unlinkSync(p); } catch (e) { /* warn */ } }
function safeRename(from, to) { try { if (existsSync(from)) renameSync(from, to); } catch (e) { /* warn */ } }

safeUnlink(prev2);
safeRename(prev, prev2);
safeRename(current, prev);

console.log('[rotate-binary] rotation complete (current -> .prev -> .prev2)');
```
Rotation semantics: delete `.prev2`, move `.prev`→`.prev2`, move `current`→`.prev`
(so after a run `current` no longer exists — the build then produces a fresh one).
All renames are best-effort (errors swallowed).

### Test tooling available

- Rust dev-deps already present (`src-tauri/Cargo.toml:99-101`): `tempfile = "3"`,
  `similar = "2"`. The Rust tests use `tempfile::tempdir()` (a temp **directory**).
- Node ships a built-in test runner (`node:test`) and `node:assert` — **no
  dependency to add**. The repo already uses Node ESM `.mjs` scripts and a
  dependency-free check-script style (`web/scripts/check-theme-contrast.mjs`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build + run all Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --tests` | exit 0, all pass |
| Fast iteration (this module) | `cargo test --manifest-path src-tauri/Cargo.toml --tests self_update::tests` | exit 0, new tests pass |
| Run the Node rotation test | `node --test scripts/rotate-binary.test.mjs` | exit 0, `pass 3 / fail 0` |
| Verify the .mjs main-guard (import must NOT rotate) | `node --input-type=module -e "import { rotate } from './scripts/rotate-binary.mjs'; console.log(typeof rotate)"` | prints only `function` — **no** `[rotate-binary]` line |

**LANDMINE — do NOT run `cargo test --lib`.** It SIGTERMs the sandbox (documented
repo gotcha). Always use `--tests`. The `--tests` target still compiles and runs the
library's unit tests (that is how this module's existing test mod runs).

**Do NOT run `node scripts/rotate-binary.mjs` directly as a verification** — it
mutates the real `src-tauri/target/release/` build output (rotates your actual
binary). Exercise the logic only through the temp-dir Node test.

## Scope

**In scope** (the only files you should modify/create):
- `src-tauri/src/commands/self_update.rs` — (a) extract the swap into a pure helper
  `revert_swap`, (b) call it from `app_self_revert`, (c) add tests to the existing
  `mod tests`.
- `scripts/rotate-binary.mjs` — refactor to export `rotate(releaseDir)` and only run
  against the real dir when invoked directly.
- `scripts/rotate-binary.test.mjs` — **create**; the Node test.

**Out of scope** (do NOT touch):
- The rotation/swap *behavior* — the refactors below must be pure extractions that
  preserve current behavior exactly. If a test reveals a real bug, STOP and report
  it; do not change the logic to make a test pass.
- `src-tauri/tauri.conf.json` — the `beforeBuildCommand` keeps calling
  `node scripts/rotate-binary.mjs`; the main-guard you add makes that path still
  rotate. Do not rewire it.
- The network updater path (`app_relaunch`, `plugin-updater`), the poll loop, and
  `hash_file`/`prefix` (already tested).

## Git workflow

- Branch: `advisor/023-self-update-swap-tests`.
- Commit(s): one is fine, or split Rust vs. Node. Conventional Commits with a scope
  (matches repo history): `test(self-update): cover revert swap + binary rotation`
  and, if split, `refactor(self-update): extract revert_swap into a pure helper`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the pure `revert_swap` helper (Rust)

In `src-tauri/src/commands/self_update.rs`:

1a. Widen the path import (self_update.rs:15) so the helper can take `&Path`:
```rust
use std::path::{Path, PathBuf};
```

1b. Add this free function (place it just above `app_self_revert`). It is the exact
body currently inside `app_self_revert`, minus the `BINARY_PATH`/`AppHandle`
plumbing and the `app.restart()`:
```rust
/// The pure 3-rename revert swap, factored out for testing. `current` is the
/// live binary, `prev` the previous one, `tmp` a scratch path in the same dir.
/// On success `current` ends up byte-identical to the old `prev`. On any rename
/// failure it rolls back best-effort and returns the surfaced error.
fn revert_swap(current: &Path, prev: &Path, tmp: &Path) -> Result<(), String> {
    if !prev.exists() {
        return Err("no previous binary to revert to".into());
    }
    if let Err(e) = fs::rename(current, tmp) {
        return Err(format!("revert step 1 (current -> tmp): {e}"));
    }
    if let Err(e) = fs::rename(prev, current) {
        let _ = fs::rename(tmp, current);
        return Err(format!("revert step 2 (prev -> current): {e}"));
    }
    if let Err(e) = fs::rename(tmp, prev) {
        let _ = fs::rename(current, prev);
        let _ = fs::rename(tmp, current);
        return Err(format!("revert step 3 (tmp -> prev): {e}"));
    }
    Ok(())
}
```

1c. Replace the body of `app_self_revert` (from the `if !prev.exists()` guard through
the three `if let Err` blocks) with a call to the helper, keeping path resolution and
the restart:
```rust
#[tauri::command]
pub fn app_self_revert(app: AppHandle) -> Result<(), String> {
    let current = BINARY_PATH
        .get()
        .ok_or_else(|| "binary path not initialized".to_string())?
        .clone();
    let dir = current
        .parent()
        .ok_or_else(|| "no parent dir".to_string())?
        .to_path_buf();
    let prev = dir.join("mortar-pestle.prev");
    let tmp = dir.join("mortar-pestle.tmp_revert");
    revert_swap(&current, &prev, &tmp)?;
    app.restart();
}
```

**Verify**: `cargo build --manifest-path src-tauri/Cargo.toml` → exit 0, no warnings
about an unused `revert_swap` (it is used by both `app_self_revert` and, after Step
2, the tests). If it warns "function is never used" at this point, that is expected
until Step 2 adds tests — re-check after Step 2.

### Step 2: Add revert-swap tests to the existing `mod tests` (Rust)

Inside the existing `#[cfg(test)] mod tests` (self_update.rs:256), add
`use tempfile::tempdir;` alongside the existing `use` lines, and add these three
tests. `fs`, `Path` come from `use super::*;`.

```rust
    #[test]
    fn revert_swap_restores_prev_byte_identically() {
        let dir = tempdir().unwrap();
        let current = dir.path().join("mortar-pestle");
        let prev = dir.path().join("mortar-pestle.prev");
        let tmp = dir.path().join("mortar-pestle.tmp_revert");
        fs::write(&current, b"NEW-broken-build").unwrap();
        fs::write(&prev, b"OLD-good-build").unwrap();

        revert_swap(&current, &prev, &tmp).unwrap();

        // current now holds the old good binary, byte-for-byte.
        assert_eq!(fs::read(&current).unwrap(), b"OLD-good-build");
        // prev holds the swapped-out new binary.
        assert_eq!(fs::read(&prev).unwrap(), b"NEW-broken-build");
        // scratch file is cleaned up.
        assert!(!tmp.exists());
    }

    #[test]
    fn revert_swap_missing_current_preserves_prev() {
        // Partial failure: step 1 (current -> tmp) fails because current is absent.
        // The previous binary MUST be left untouched — no data loss.
        let dir = tempdir().unwrap();
        let current = dir.path().join("mortar-pestle"); // intentionally not created
        let prev = dir.path().join("mortar-pestle.prev");
        let tmp = dir.path().join("mortar-pestle.tmp_revert");
        fs::write(&prev, b"OLD-good-build").unwrap();

        let err = revert_swap(&current, &prev, &tmp).unwrap_err();
        assert!(err.contains("step 1"), "expected a step-1 error, got: {err}");
        assert_eq!(fs::read(&prev).unwrap(), b"OLD-good-build"); // untouched
        assert!(!tmp.exists());
        assert!(!current.exists());
    }

    #[test]
    fn revert_swap_no_prev_is_rejected() {
        let dir = tempdir().unwrap();
        let current = dir.path().join("mortar-pestle");
        let prev = dir.path().join("mortar-pestle.prev"); // absent
        let tmp = dir.path().join("mortar-pestle.tmp_revert");
        fs::write(&current, b"NEW").unwrap();

        let err = revert_swap(&current, &prev, &tmp).unwrap_err();
        assert!(err.contains("no previous binary"), "got: {err}");
        assert_eq!(fs::read(&current).unwrap(), b"NEW"); // untouched
    }
```

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests self_update::tests`
→ `test result: ok. 6 passed` (the 3 pre-existing `hash_file`/`prefix` tests + your 3).

### Step 3: Make `rotate-binary.mjs` testable (Node)

Refactor `scripts/rotate-binary.mjs` to export the rotation as a function and only
run it against the real release dir when the script is executed directly. Replace the
file with:

```js
#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function safeUnlink(p) {
  try { if (existsSync(p)) unlinkSync(p); } catch (e) { console.warn('[rotate-binary] unlink failed (ignored):', p, e.message); }
}
function safeRename(from, to) {
  try { if (existsSync(from)) renameSync(from, to); } catch (e) { console.warn('[rotate-binary] rename failed (ignored):', from, '->', to, e.message); }
}

/** Rotate mortar-pestle -> .prev -> .prev2 inside `releaseDir`. Best-effort. */
export function rotate(releaseDir) {
  if (!existsSync(releaseDir)) {
    mkdirSync(releaseDir, { recursive: true });
    console.log('[rotate-binary] no target/release/ yet — first build, nothing to rotate');
    return;                       // NOTE: return, not process.exit — safe to call in-process
  }
  const current = join(releaseDir, 'mortar-pestle');
  const prev    = join(releaseDir, 'mortar-pestle.prev');
  const prev2   = join(releaseDir, 'mortar-pestle.prev2');
  safeUnlink(prev2);
  safeRename(prev, prev2);
  safeRename(current, prev);
  console.log('[rotate-binary] rotation complete (current -> .prev -> .prev2)');
}

// Run against the real release dir only when invoked directly (the build hook does
// `node scripts/rotate-binary.mjs`). Importing this module must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rotate(join(__dirname, '..', 'src-tauri', 'target', 'release'));
}
```

Key changes vs. the original: `process.exit(0)` → `return` (so calling `rotate` in a
test can't kill the runner), logic wrapped in `export function rotate(dir)`, and a
Windows-safe "run if main" guard so the build still rotates but `import` does not.

**Verify (guard)**: `node --input-type=module -e "import { rotate } from './scripts/rotate-binary.mjs'; console.log(typeof rotate)"`
→ prints exactly `function` and **no** `[rotate-binary]` line (proves importing does
not trigger a rotation).

### Step 4: Add the Node rotation test

Create `scripts/rotate-binary.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotate } from './rotate-binary.mjs';

function tempReleaseDir() {
  return mkdtempSync(join(tmpdir(), 'rotate-'));
}

test('rotate moves current -> .prev and .prev -> .prev2', () => {
  const dir = tempReleaseDir();
  try {
    writeFileSync(join(dir, 'mortar-pestle'), 'GEN0-current');
    writeFileSync(join(dir, 'mortar-pestle.prev'), 'GEN1-prev');
    writeFileSync(join(dir, 'mortar-pestle.prev2'), 'GEN2-prev2-should-be-dropped');

    rotate(dir);

    // current was moved into .prev, so it no longer exists (build recreates it).
    assert.equal(existsSync(join(dir, 'mortar-pestle')), false);
    // .prev now holds the former current; .prev2 holds the former .prev.
    assert.equal(readFileSync(join(dir, 'mortar-pestle.prev'), 'utf8'), 'GEN0-current');
    assert.equal(readFileSync(join(dir, 'mortar-pestle.prev2'), 'utf8'), 'GEN1-prev');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotate tolerates a missing .prev2 (first rotations)', () => {
  const dir = tempReleaseDir();
  try {
    writeFileSync(join(dir, 'mortar-pestle'), 'GEN0-current');
    writeFileSync(join(dir, 'mortar-pestle.prev'), 'GEN1-prev');
    // no .prev2 present

    rotate(dir);

    assert.equal(readFileSync(join(dir, 'mortar-pestle.prev'), 'utf8'), 'GEN0-current');
    assert.equal(readFileSync(join(dir, 'mortar-pestle.prev2'), 'utf8'), 'GEN1-prev');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotate on a non-existent dir creates it and does not throw', () => {
  const base = mkdtempSync(join(tmpdir(), 'rotate-'));
  const missing = join(base, 'does-not-exist-yet');
  try {
    rotate(missing);                       // must return, not exit/throw
    assert.equal(existsSync(missing), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

**Verify**: `node --test scripts/rotate-binary.test.mjs` → `# pass 3`, `# fail 0`,
exit 0.

*(Optional, skip unless you want it discoverable): add
`"test:scripts": "node --test scripts/"` to the root `package.json` `scripts` block.
Not required — the raw `node --test` command above is the source of truth.)*

### Step 5: Full Rust suite still green

**Verify**: `cargo test --manifest-path src-tauri/Cargo.toml --tests` → exit 0, all
pass (existing suite + your 3 new self_update tests).

## Test plan

- **Rust** (`self_update.rs` `mod tests`, model after existing tests at
  self_update.rs:256-291):
  - `revert_swap_restores_prev_byte_identically` — happy path; `current` ends
    byte-identical to the old `prev`, `tmp` cleaned up.
  - `revert_swap_missing_current_preserves_prev` — the deterministic mid-swap
    failure (step 1 fails on a missing source); asserts the previous binary is
    left intact (no data loss).
  - `revert_swap_no_prev_is_rejected` — guard path; `current` untouched.
- **Node** (`scripts/rotate-binary.test.mjs`, dependency-free `node:test`):
  - rotation lands each generation (`current`→`.prev`→`.prev2`, oldest dropped),
  - tolerates a missing `.prev2`,
  - creates a missing dir and returns without throwing.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --tests` all pass;
  `node --test scripts/rotate-binary.test.mjs` → 3 pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0; the 3 new
      `revert_swap_*` tests pass (`... --tests self_update::tests` shows `6 passed`).
- [ ] `node --test scripts/rotate-binary.test.mjs` exits 0 (`pass 3 / fail 0`).
- [ ] The guard check prints only `function` (importing `rotate-binary.mjs` produces
      no `[rotate-binary]` output).
- [ ] `app_self_revert` still ends in `app.restart();` and delegates the swap to
      `revert_swap` (no behavior change).
- [ ] `git status --porcelain` shows only `src-tauri/src/commands/self_update.rs`,
      `scripts/rotate-binary.mjs` modified and `scripts/rotate-binary.test.mjs` added
      (plus `package.json` iff you took the optional npm-script).
- [ ] `plans/README.md` status row updated **if** that file exists (skip otherwise).

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check diff is non-empty and the "Current state" excerpts no longer match
  the live `self_update.rs` / `rotate-binary.mjs`.
- `app_self_revert` no longer has the 3-rename shape shown above (e.g. it was
  rewritten to use a different swap or an external crate) — the extraction assumes
  that exact body. Report the new shape instead of forcing the refactor.
- **A test fails because the behavior is wrong** (e.g. the happy-path swap does not
  leave `current` byte-identical to the old `prev`, or the step-1 failure clobbers
  `prev`). That is a real bug in the swap/rotation — report it; do NOT edit the logic
  to make the test pass.
- The revert swap turns out to be inseparable from `AppHandle`/`BINARY_PATH` without
  a bigger change than the Step-1 extraction (it is not, per the excerpt — but if the
  live code has drifted so the rename logic is entangled with the restart, report it
  rather than expanding scope).
- `node --test` is unavailable (Node < 18). Report the Node version; do not add a
  third-party test runner.

## Maintenance notes

- **Coverage limitation (intentional):** the tests cover the happy path and the
  deterministic **step-1** partial failure (missing `current`). Forcing a **step-2/3**
  rename failure mid-swap requires an OS-specific locked-file-handle harness
  (a portable, deterministic failure at those points is not achievable in a plain
  unit test on Windows), so the step-2/3 rollback branches are verified by
  inspection, not execution. If those branches are ever changed, add a targeted
  harness or review them by hand — do not assume the tests exercise them.
- If the binary base name (`mortar-pestle`) or the `.prev`/`.prev2`/`.tmp_revert`
  suffixes change, update both the Rust tests and the Node test (and keep
  `app_self_revert`'s `dir.join(...)` names in sync with `rotate-binary.mjs`).
- The `rotate-binary.mjs` main-guard uses `import.meta.url === pathToFileURL(process.argv[1]).href`.
  If the build ever invokes it via a symlink or a differently-normalized path, the
  guard could miss; the guard verify command in this plan is the canary.
- Reviewer should scrutinize: that `app_self_revert`'s externally observable behavior
  is unchanged (still restarts, same error strings), and that `rotate-binary.mjs`
  still performs a real rotation when the build runs `node scripts/rotate-binary.mjs`
  (the `beforeBuildCommand` at `tauri.conf.json:10`).

# Plan 019: Replace the unmaintained YAML stack and bump the aged bundled SQLite

> **Executor instructions**: Follow this plan step by step. The two steps are
> INDEPENDENT — either can ship alone; do them in separate commits. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update this plan's row in `plans/README.md` if that index exists — unless a
> reviewer told you they maintain it.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/manifest_gen.rs src-tauri/src/commands/food.rs src-tauri/src/commands/browser.rs`
> If any changed since `57a6c80`, re-read and compare against the "Current state"
> excerpts before editing; on a mismatch treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Two dependencies carry avoidable risk. `serde_yml` (the `serde_yaml` fork family)
has documented maintenance and soundness concerns — `serde_yaml` itself is
RUSTSEC-2024-0421 (unmaintained) — and its only in-repo Rust consumer is one
small file, so the swap to the actively maintained `serde_yaml_ng` is a
near-drop-in with a tiny blast radius. Separately, the bundled SQLite is ~18
months old (3.45.0, Jan 2024) and misses subsequent patch releases; bumping
`rusqlite` pulls a current SQLite for free. Neither is urgent — both reachable
inputs are read-only and app-controlled — but both are cheap, low-risk hygiene
that removes an unmaintained crate and stale native code from the tree.

## Current state

### YAML stack (Step 1)

- `src-tauri/Cargo.toml:34` — `serde_yml = "0.0.12"`.
- `src-tauri/Cargo.lock:2535-2537` — resolves `libyml` version `0.0.5` (the
  `serde_yml`/`libyml` fork of `serde_yaml`/`unsafe-libyaml`).
- **Sole Rust consumer**: `src-tauri/src/commands/manifest_gen.rs`. The APIs it
  uses (all standard `serde_yaml`-family, present in `serde_yaml_ng`):
  - `manifest_gen.rs:119` — `serde_yml::from_str::<HashMap<String, serde_yml::Value>>(fm)`
  - `manifest_gen.rs:152` — `fn yaml_strings(v: &serde_yml::Value) -> Vec<String>`
  - `manifest_gen.rs:154-155` — `serde_yml::Value::String(s)`, `serde_yml::Value::Sequence(seq)`
  - `manifest_gen.rs:156` — `.as_str()` on sequence items
- **The `serde_yml` hit in `web/src/api.js:203` is a COMMENT, not a consumer**
  ("the Rust side has `serde_yml` if we ever need robust round-trip"). JS cannot
  link a Rust crate — ignore it. (It is fine to update that comment's text too,
  but it is not required and not counted in the grep gate.)
- Frontmatter parsing is exercised by the existing tests in this crate, so
  `cargo test --tests` covers the swap.

### Bundled SQLite (Step 2)

- `src-tauri/Cargo.toml:39` — `rusqlite = { version = "0.31", features = ["bundled"] }`.
- `src-tauri/Cargo.lock:2524-2526` — resolves `libsqlite3-sys` `0.28.0`, which
  statically links SQLite 3.45.0 (Jan 2024).
- **Consumers — there are TWO, not one** (grep `use rusqlite` over `src-tauri/src`):
  - `src-tauri/src/commands/food.rs` — read-only queries against the bundled
    `resources/usda_foods.db`. `food.rs:14` `use rusqlite::{Connection, OpenFlags};`,
    `food.rs:64` `Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)`,
    `food.rs:107,128,136` `query_map(...)`. **This is the ONLY rusqlite consumer
    compiled on Windows.**
  - `src-tauri/src/commands/browser.rs` — read-only reader for the WebKit/libsoup
    cookie SQLite jar. `browser.rs` is `#[cfg(target_os = "linux")]` (see
    `commands/mod.rs:9-10`), so it is NOT compiled on Windows; the Windows browser
    (`browser_windows.rs`) does not use rusqlite.
- Both consumers are read-only opens of app-controlled databases — low urgency,
  low risk. The `bundled` feature must stay so there is no system SQLite dep.

### Deliberately deferred (record, do not attempt)

These major bumps were considered and intentionally left alone — do NOT open
them as part of this plan (documented here so no one re-flags them as oversights):

- **React 18 → 19** and **Vite 6 → 7** (`web/package.json`: `react ^18.3.1`,
  `vite ^6.0.5`) — no payoff for a client-only Tauri webview (no RSC / server
  components); churn without benefit.
- **axum 0.7 → 0.8** (`src-tauri/Cargo.toml:51`) — the only axum use is the
  loopback media-server shim (`media_server.rs`); it does not need 0.8's routing
  changes.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Confirm serde_yml dep | `grep -n "serde_yml" src-tauri/Cargo.toml` | line 34 |
| Confirm rusqlite dep | `grep -n "rusqlite" src-tauri/Cargo.toml` | line 39 |
| serde_yml Rust consumers | `grep -rn "serde_yml" src-tauri/src` | manifest_gen.rs only |
| rusqlite consumers | `grep -rln "use rusqlite" src-tauri/src` | food.rs + browser.rs |
| Build+test | `cargo test --manifest-path src-tauri/Cargo.toml --tests` | all pass (NEVER `--lib`) |
| Audit (if installed) | `cargo audit --file src-tauri/Cargo.lock` | note advisories before/after |
| Latest crate version | `cargo search serde_yaml_ng` / `cargo search rusqlite` | pick current version |

Note: `cargo audit` was NOT runnable during the audit that produced this plan.
If the binary is available, run it before and after each step and record the
advisory delta in your report. If it is not installed, say so — do not treat its
absence as a blocker.

## Scope

**In scope**:
- `src-tauri/Cargo.toml` — the two dependency lines (34, 39).
- `src-tauri/Cargo.lock` — regenerated by cargo (commit the result).
- `src-tauri/src/commands/manifest_gen.rs` — `serde_yml::` → `serde_yaml_ng::`.
- (Optional, not required) `web/src/api.js:203` comment text.

**Out of scope** (do NOT touch):
- `food.rs` / `browser.rs` code — the rusqlite bump should need no source change
  (read-only `Connection::open*` + `query_map` are stable 0.31 → 0.32). If it
  DOES need a code change, that is a STOP condition.
- The deferred React / Vite / axum bumps above.
- The `bundled` feature on rusqlite — keep it.

## Git workflow

- Branch: `advisor/019-dependency-hygiene` (or the repo convention).
- **Two commits, one per step** (they are independent and either can be reverted
  alone). Message style — match `git log --oneline -5` (terse conventional-ish,
  e.g. `chore(deps): swap serde_yml -> serde_yaml_ng`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Swap `serde_yml` → `serde_yaml_ng`

1. In `src-tauri/Cargo.toml:34`, replace `serde_yml = "0.0.12"` with
   `serde_yaml_ng = "0.10"` — but first run `cargo search serde_yaml_ng` and pin
   the current `0.10.x` (if the crate has moved to a different major, use that and
   note it).
2. In `src-tauri/src/commands/manifest_gen.rs`, replace every `serde_yml::` with
   `serde_yaml_ng::` (5 occurrences: lines ~119, 152, 154, 155, and the
   `from_str` turbofish). Do a final `grep -n "serde_yml" src-tauri/src/commands/manifest_gen.rs`
   → 0 hits.
3. Rebuild the lockfile: `cargo build --manifest-path src-tauri/Cargo.toml`
   (regenerates `Cargo.lock`; `libyml` should disappear).

**Verify**:
- `grep -rn "serde_yml" src-tauri/src` → no output.
- `grep -n "libyml" src-tauri/Cargo.lock` → no output.
- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all pass
  (the frontmatter/manifest tests exercise the swapped parser).

### Step 2: Bump `rusqlite` 0.31 → 0.32+ (newer bundled SQLite)

1. Run `cargo search rusqlite` and pick the current version (`0.32` at minimum;
   a newer minor pulls a newer bundled SQLite — take the latest that still builds
   with `features = ["bundled"]`).
2. In `src-tauri/Cargo.toml:39`, bump the version, keeping
   `features = ["bundled"]`.
3. `cargo build --manifest-path src-tauri/Cargo.toml` — regenerates `Cargo.lock`;
   `libsqlite3-sys` should move to `0.30+` (SQLite 3.46+). Expect NO source
   changes to `food.rs` / `browser.rs`.

**Verify**:
- `grep -n "libsqlite3-sys" src-tauri/Cargo.lock` → version ≥ `0.30`.
- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all pass.
- **Exercise the real reader** (the primary Windows consumer is `food.rs`, since
  `browser.rs` is Linux-only). If the crate has a food test, it covers it; if not,
  confirm the app can still open the USDA DB — e.g. run the dev app
  (`npm run tauri dev`) and hit the food/nutrition feature so `food.rs`'s
  `Connection::open_with_flags` on `resources/usda_foods.db` runs, OR add a tiny
  read-only smoke test opening the bundled DB and running one `SELECT`. Confirm no
  panic / open error.

### Step 3 (optional): update the stale JS comment

If you touched Step 1, optionally update `web/src/api.js:203` so its "the Rust
side has `serde_yml`" comment reads `serde_yaml_ng`. Cosmetic; skip if it risks
scope creep.

## Test plan

- Existing crate tests: `cargo test --manifest-path src-tauri/Cargo.toml --tests`
  must pass after each step. The frontmatter/manifest tests cover Step 1.
- For Step 2, if no test opens `resources/usda_foods.db`, add one small
  read-only smoke test (open with `SQLITE_OPEN_READ_ONLY`, run `SELECT 1`, assert
  Ok) OR drive the food feature in the dev app once and confirm it reads. Model
  any new test after the existing tests in `src-tauri/src/commands/` (match their
  `#[test]` / `#[tokio::test]` style and how they locate fixtures).
- If `cargo audit` is available, capture the advisory list before and after;
  `serde_yml`/`libyml` and the old `libsqlite3-sys` advisories (if any) should
  drop out.

## Done criteria

ALL must hold:

- [ ] `grep -rn "serde_yml" src-tauri/src` → no output; `serde_yaml_ng` in
      `Cargo.toml`; `libyml` gone from `Cargo.lock`.
- [ ] `rusqlite` bumped to ≥ 0.32 with `bundled` retained; `libsqlite3-sys` ≥
      0.30 in `Cargo.lock`.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` passes.
- [ ] The USDA DB read path (`food.rs`) is confirmed working (test or dev-app run).
- [ ] No source file outside `manifest_gen.rs` (and optional `web/src/api.js`
      comment) changed — `git status` shows only Cargo.toml, Cargo.lock,
      manifest_gen.rs (+ any new smoke test you added).
- [ ] `plans/README.md` row updated (if that index exists).

## STOP conditions

Stop and report (do not improvise) if:

- `manifest_gen.rs` uses a `serde_yml` API with no `serde_yaml_ng` equivalent
  (build error after the swap that isn't a plain `serde_yml::` → `serde_yaml_ng::`
  rename). Report the exact API.
- The `rusqlite` bump requires ANY source change in `food.rs` or `browser.rs`
  (an API break) — report the break; do not rewrite the readers under this plan.
- `cargo build` after either bump fails for a reason other than the rename (e.g.
  a transitive-dep conflict, or `bundled` no longer compiling on the toolchain).
- The USDA DB smoke check fails to open the database after the SQLite bump —
  report; do not ship a broken reader.

## Maintenance notes

- Keep `rusqlite`'s `bundled` feature forever — dropping it introduces a system
  SQLite dependency the installer doesn't ship.
- `serde_yaml_ng` is itself a fork; if it too goes unmaintained, the escape hatch
  is that `manifest_gen.rs` only needs `from_str` + a `Value` enum with `String`/
  `Sequence` + `as_str` — trivially portable to another YAML crate or a hand
  parser (the frontmatter is simple `title`/`aliases`).
- The deferred React 18→19, Vite 6→7, and axum 0.7→0.8 bumps are intentional (see
  "Current state → Deliberately deferred"); a future reviewer should not re-open
  them without a concrete payoff.
- A reviewer should scrutinize: (1) `libyml` truly gone from `Cargo.lock`, (2)
  `bundled` still present on rusqlite, (3) the food DB actually opened post-bump
  (the easiest thing to skip and the only reachable Windows consumer).

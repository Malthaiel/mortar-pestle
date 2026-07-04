# Plan 026: Split the two largest source files along their existing seams

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` if that file exists — unless a reviewer dispatched you and
> told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- web/src/api.js src-tauri/src/commands/video_editor.rs src-tauri/src/lib.rs src-tauri/build.rs src-tauri/capabilities/default.json`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L (two independent halves A and B; each ships incrementally)
- **Risk**: MED (A: an import-resolution break blanks the whole app; B: a moved Rust command that loses its ACL registration silently fails at runtime with "not allowed")
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Two files carry disproportionate weight:

- **`web/src/api.js` (1890 lines)** is the host SDK surface that **26 modules
  import via `@host/api.js`**. It mixes three unrelated concerns: Tauri IPC
  primitives, media/asset-URL helpers, and ~400 lines of **planner-domain
  frontmatter parsers**. The planner is a *module* — its frontmatter parsers
  living inside the SDK every module imports is a layering inversion, and it
  makes the one file everyone depends on the hardest to read.
- **`src-tauri/src/commands/video_editor.rs` (3558 lines)** holds 17
  `#[tauri::command]`s across 6 families, **including a parity/smoke test harness
  (4 commands) that ships in the production command surface** even though it only
  backs dev/QA panels.

Splitting each along seams it already has — with **re-export shims so the 26
importers and the command registration don't churn** — makes both navigable and
lets the dev-only harness be told apart from production commands. Both halves are
independent; ship them separately.

**Read this honestly**: neither file is a clean stack of independent pieces.
`api.js`'s media helpers depend on its `invoke` primitive (a module cycle to
manage), and `video_editor.rs`'s export machinery (~1900 lines, ~20 shared
structs) is the core that the LUT and parity commands *reuse* — so a full 4-way
Rust split is genuinely L and the export seam is the hard one. This plan scopes
the **safe seams first** (media + planner for A; project/lut/probe/parity for B)
and documents the hard export seam as the last, deferrable slice.

## Current state

### Half A — `web/src/api.js`

- `@host` is a Vite alias to `web/src` (`web/vite.config.js:32`:
  `'@host': path.resolve(__dirname, 'src')`), so `@host/api.js` **is**
  `web/src/api.js`. 26 files import from it (verified:
  `grep -rl "@host/api.js" modules web/src` → 26 files).

- **IPC primitive** (`api.js:12-21`) — everything downstream needs this:
  ```js
  const __tauriInvoke = () => (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) ? window.__TAURI_INTERNALS__.invoke : null;
  export async function invoke(cmd, args) {
    const fn = __tauriInvoke();
    if (!fn) throw new Error(`Tauri IPC not available (cmd: ${cmd}) — running outside Tauri shell?`);
    return fn(cmd, args);
  }
  ```

- **Media / asset-URL helpers** (`api.js:23-128`) — a self-contained unit whose
  only external dependency is `invoke` (used inside `mediaBaseUrl`, `api.js:56`)
  and `convertFileSrc` (imported `api.js:7`). Owns its own module-level state:
  `VAULT_ROOT_FOR_MEDIA`/`LIBRARY_ROOT_FOR_MEDIA`/`_mediaBaseUrl`/`_mediaBaseUrlPromise`.
  Exports: `setMediaVaultRoot`, `setMediaLibraryRoot`, `libraryAbs`, `mediaUrl`,
  `hydrateVaultImages`, `mediaHttpUrl`, `rewriteAssetToHttp`, `awaitMediaBaseUrl`.

- **Planner-domain frontmatter parsers** (`api.js:218-680` region). Exported:
  `parseBlockLibrary` (`:237`), `serializeBlockLibrary` (`:283`),
  `parseEventTypes` (`:306`), `serializeEventTypes` (`:338`), `parseDailyFrame`
  (`:487`), `buildScheduleFrontmatter` (`:537`), `parseFrameOverride` (`:634`).
  Private helpers they use: `parseYamlScalar` (`:218`), `serializeYamlScalar`
  (`:269`), `buildDailyLogSkeleton` (`:357`).
  **Key fact — these have ZERO external importers**: `grep -rl
  "parseBlockLibrary\|parseEventTypes\|parseDailyFrame\|buildScheduleFrontmatter\|serializeBlockLibrary\|parseFrameOverride"
  modules web/src` returns **only `web/src/api.js`**. They are called internally
  by the `api` object's planner methods. So relocating them is a **purely
  internal** move — nothing outside api.js can break.

- The big **`api` object** (`api.js:1363`, 16 domain slices) and a **Health-page
  parser block** (`api.js:1196-1361`: `parseHealthPage`, `serializeHealthMeal`,
  etc.) also live here. Both are **out of scope** for this plan (the Health block
  is a valid future seam — noted in Maintenance).

### Half B — `src-tauri/src/commands/video_editor.rs`

Declared flat: `src-tauri/src/commands/mod.rs:58` → `pub mod video_editor;`.

**17 commands, 6 families** (verified line numbers):

| Family | Commands (line) |
|--------|-----------------|
| project | `vedit_project_list`(68), `vedit_project_read`(95), `vedit_project_save`(112), `vedit_project_delete`(159) |
| probe | `vedit_probe`(217), `vedit_encoder_probe`(1818) |
| remux | `vedit_remux_start`(240), `vedit_remux_release`(328) |
| export | `vedit_export_start`(1956), `vedit_export_cancel`(2198), `vedit_export_status`(2225) |
| lut | `vedit_lut_import`(2724), `vedit_lut_read`(2774) |
| **parity/smoke (dev harness)** | `vedit_encode_smoke`(1840), `vedit_parity_render`(2238), `vedit_composite_parity`(2334), `vedit_audio_parity`(2628) |

The parity/smoke commands back dev/QA panels only:
`modules/studio/video-editor/{CompositeParityPanel,EncodeSmokePanel,color/ParityPanel,audio/AudioParityPanel}.jsx`.

**The 3-site ACL registration — every command name appears in all three, and
`lib.rs` is the one that references Rust *paths*:**

1. `src-tauri/build.rs:8-24` — string names in `AppManifest::commands(&[…])`
   (e.g. `"vedit_project_list"`). Generated from the **function name**, not the
   module path — unaffected by moving a fn between submodules.
2. `src-tauri/capabilities/default.json:23-39` — `allow-vedit-*` permission
   strings (dash form, e.g. `"allow-vedit-project-list"`). Also name-derived —
   unaffected by module moves. (`default.json:4` documents the contract:
   build.rs DEFINES each permission; this array must REFERENCE it.)
3. `src-tauri/src/lib.rs:613-629` — the `generate_handler!` invoke list uses
   **Rust paths**: `commands::video_editor::vedit_project_list, …`. **This is the
   one that breaks if a command moves to a submodule** — unless
   `video_editor/mod.rs` re-exports it (see Step B1).

**Shared internals** (why a clean split is hard) — the export family owns ~20
structs (`ExportSpec`(633) + `ExportSegment`(347), `Crop`(387), `Transform`(404),
`ExportLayer`(430), `Mixer`(591), `EqSpec`(528), `CompSpec`(552),
`LoudnormMeasured`(601), etc.) and ~15 graph/encode helpers
(`materialize_one`(693), `layer_geom`(1068), `input_args`(1374),
`video_encode_args`(1510), `master_audio_tail`(914), …) plus statics
`LUT_SEQ`(688), `TITLE_SEQ`(754), `EXPORT`(1939). **The parity/smoke harness
reuses these** (`audio_parity_export_spec`(2481) returns an `ExportSpec`; the LUT
commands share `materialize_one`/`LUT_SEQ`). So export is the core everything
references — moving it is the hard seam.

### Conventions to honor

- Rust: a directory module is `video_editor/mod.rs` + submodule files;
  `mod.rs:58 pub mod video_editor;` stays unchanged (Rust finds `mod.rs`). Items
  not moved stay in `mod.rs` and submodules reach them via `use super::*;`.
  Re-export moved commands with `pub use <sub>::*;` in `mod.rs` so
  `commands::video_editor::vedit_*` paths keep resolving.
- JS: ESM re-export barrel is `export * from './api/media.js';`. A module import
  cycle where the cycle edge is a **function call at runtime** (not a
  module-eval-time value read) is safe.

## Commands you will need

| Purpose          | Command                                                       | Expected on success        |
|------------------|--------------------------------------------------------------|----------------------------|
| Web build (A)    | `npm --prefix web run build`                                 | exit 0, `web/dist` written |
| Rust build (B)   | `cargo build --manifest-path src-tauri/Cargo.toml`           | exit 0, no errors          |
| Rust tests (B)   | `cargo test --manifest-path src-tauri/Cargo.toml --tests`    | exit 0                     |
| Dev run (manual) | `npm run tauri dev`                                          | Vite + window, app boots   |

> NEVER `cargo test --lib` (SIGTERMs). Always `--tests`.

## Scope

**Half A — in scope:**
- `web/src/api.js` (becomes a barrel)
- `web/src/api/media.js` (create)
- `web/src/api/planner-parsers.js` (create)

**Half B — in scope:**
- `src-tauri/src/commands/video_editor.rs` → `src-tauri/src/commands/video_editor/mod.rs` (+ submodule files)
- `src-tauri/src/commands/video_editor/{project,probe,lut,parity_harness,export}.rs` (create, as reached)

**Out of scope (do NOT touch):**
- `src-tauri/src/lib.rs`, `build.rs`, `capabilities/default.json` — the re-export
  shims exist precisely so these stay byte-for-byte unchanged. If you must edit
  them, STOP (you broke the shim).
- The 26 files that import `@host/api.js` — the barrel keeps every export name, so
  none of them change.
- The `api` object (`api.js:1363`) and the Health parser block (`api.js:1196-1361`)
  — do not relocate them in this plan.
- Any change to a function's *behavior* — this is pure code motion. No logic edits.
- **Dev-gating the parity/smoke commands is OUT OF SCOPE**: no command-level
  dev-tools gating tier exists in this repo (searched — `debug_assertions` appears
  only for devtools-window opening, not command gating). Moving them to
  `parity_harness.rs` achieves the organizational goal; *gating* them off in
  production is a separate runtime-behavior decision (see Maintenance).

## Git workflow

- Branch: `advisor/026-god-file-decomposition`.
- Commit per seam (each leaves the build green). Half A and Half B may be
  separate PRs.
- Message style — match repo, e.g. `refactor(api): extract media helpers into api/media.js barrel`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Half A — `api.js` barrel split

#### Step A1: extract the media helpers → `web/src/api/media.js`

Create `web/src/api/media.js`. Move `api.js:23-128` (the media state + all media
helper functions) into it verbatim. Add at the top of `media.js`:
```js
import { convertFileSrc } from '@tauri-apps/api/core';
import { invoke } from '../api.js';
```
(the `invoke`-from-`../api.js` edge is a runtime-only cycle — `mediaBaseUrl`
calls `invoke` lazily, so it is safe.)

In `api.js`: delete the moved block and add a re-export near the top (after the
`invoke` definition so `invoke` is defined before `media.js` is evaluated):
```js
export * from './api/media.js';
```
Keep `import { convertFileSrc } from '@tauri-apps/api/core';` in `api.js` only if
something else there still uses it; otherwise remove it (build will warn if
unused via an eslint pass — Vite won't, so grep `convertFileSrc` in api.js after).

**Verify**:
- `npm --prefix web run build` → exit 0 (import resolution + no missing exports).
- `grep -n "export function mediaUrl" web/src/api/media.js` → 1 match;
  `grep -n "export function mediaUrl" web/src/api.js` → 0 matches.
- Manual smoke: `npm run tauri dev`, open a page with an album cover or video —
  the image/audio must still load (proves `mediaUrl`/`mediaHttpUrl` resolve and
  the `invoke` cycle didn't TDZ-crash).

> If the dev run shows a "Cannot access 'invoke' before initialization" / TDZ
> error, STOP and apply the fallback: create `web/src/api/core.js` holding
> `__tauriInvoke` + `invoke`, have both `api.js` and `media.js` import `invoke`
> from `./core.js` (api.js also `export * from './api/core.js'`). Then re-verify.

#### Step A2: extract the planner parsers → `web/src/api/planner-parsers.js`

Create `web/src/api/planner-parsers.js`. Move the planner parser block
(`api.js:218-680` region: `parseYamlScalar`, `serializeYamlScalar`,
`parseBlockLibrary`, `serializeBlockLibrary`, `parseEventTypes`,
`serializeEventTypes`, `buildDailyLogSkeleton`, `parseDailyFrame`,
`buildScheduleFrontmatter`, `parseFrameOverride`) into it verbatim, keeping the
`export` keyword on the currently-exported ones. Check each moved function for
references to symbols still in `api.js` (e.g. a shared frontmatter/util helper or
`resolveWikilinksJs` at `:975`); if one is referenced, either move it too (if
planner-only) or `import` it into `planner-parsers.js` from its home. The build
will name any unresolved symbol — resolve one at a time.

In `api.js`: delete the moved block. Because the `api` object still **calls**
these internally, add both a re-export and an internal import:
```js
export * from './api/planner-parsers.js';
import { parseBlockLibrary, serializeBlockLibrary, parseEventTypes, serializeEventTypes, parseDailyFrame, buildScheduleFrontmatter, parseFrameOverride } from './api/planner-parsers.js';
```
(Only import the names the `api` object actually references — grep the `api`
object body to confirm which.)

**Verify**:
- `npm --prefix web run build` → exit 0.
- `grep -rl "parseBlockLibrary" web/src/api.js web/src/api/planner-parsers.js` →
  both files (definition in planner-parsers, re-export+internal-use in api.js);
  `grep -rl "parseBlockLibrary" modules` → still nothing (no module churn).
- Manual smoke: `npm run tauri dev`, open the Planner and a daily page — the
  schedule/blocks must render (proves the internal parser wiring survived).

### Half B — `video_editor.rs` directory split

#### Step B1: convert to a directory module with a re-export shim (no logic move yet)

- `mkdir src-tauri/src/commands/video_editor`
- Move the whole file: `git mv src-tauri/src/commands/video_editor.rs src-tauri/src/commands/video_editor/mod.rs`
- `src-tauri/src/commands/mod.rs:58` stays `pub mod video_editor;` — unchanged.

**Verify**: `cargo build --manifest-path src-tauri/Cargo.toml` → exit 0 (nothing
moved yet, so this must be a no-op build). Confirm the ACL is intact:
`grep -c "commands::video_editor::vedit_" src-tauri/src/lib.rs` → 17.

#### Step B2: move the project family → `video_editor/project.rs` (safest seam)

Create `video_editor/project.rs`. Move into it: `projects_root`(23),
`project_paths`(30), structs `ProjectListEntry`(43), `ProjectReadOut`(50),
`ProjectWriteOut`(58), `DeleteOut`(148), `vedit_project_list_inner`(74), and the
4 project commands (`vedit_project_list`, `_read`, `_save`, `_delete`). At the top
of `project.rs`:
```rust
use super::*;   // shared: VaultError, atomic_write, library_vault_root, mtime_ms, sanitize_name
```
In `video_editor/mod.rs`: add `mod project;` and `pub use project::*;` (the
`pub use` is what keeps `commands::video_editor::vedit_project_list` resolving for
`lib.rs`). Remove the moved items from `mod.rs`.

**Verify (this is the ACL-integrity gate — run it after every B move)**:
- `cargo build --manifest-path src-tauri/Cargo.toml` → exit 0.
- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → exit 0.
- All 3 ACL sites still list every project command:
  `grep -c "vedit_project" src-tauri/build.rs` → 4;
  `grep -c "allow-vedit-project" src-tauri/capabilities/default.json` → 4;
  `grep -c "commands::video_editor::vedit_project" src-tauri/src/lib.rs` → 4.
- Manual: `npm run tauri dev`, open the Video Editor, list/open/save a project —
  no "not allowed" IPC error (that error is the signature of a broken ACL path).

#### Step B3: move the lut commands → `video_editor/lut.rs`

Move `vedit_lut_import`(2724), `vedit_lut_read`(2774), and structs
`LutImportOut`(2711), `LutReadOut`(2719). **Leave `materialize_one`(693) and
`LUT_SEQ`(688) in `mod.rs`** — the export machinery uses them. `lut.rs` top:
`use super::*;`. In `mod.rs`: `mod lut; pub use lut::*;`.

**Verify**: build + tests exit 0; `grep -c "allow-vedit-lut" default.json` → 2;
`grep -c "commands::video_editor::vedit_lut" lib.rs` → 2. Manual: import/read a
LUT in the editor — no IPC error.

#### Step B4: move the probe family → `video_editor/probe.rs`

Move `canonical_file`(203), `vedit_probe`(217), `vedit_encoder_probe`(1818),
`EncoderCaps`(1697), `caps_cache_path`(1781), and `caps_cached` (grep its
definition line). **Note `caps_cached` is also called by the smoke command**
(`mod.rs:1841`) — since `pub use probe::*;` re-exports it and parity_harness will
`use super::*;`, that stays resolvable. `probe.rs` top: `use super::*;`. In
`mod.rs`: `mod probe; pub use probe::*;`.

**Verify**: build + tests exit 0; `grep -c "allow-vedit-\(probe\|encoder-probe\)" default.json` → 2;
`grep -c "commands::video_editor::vedit_probe\|vedit_encoder_probe" lib.rs` → 2.

#### Step B5: move the parity/smoke harness → `video_editor/parity_harness.rs`

Move the 4 dev commands (`vedit_parity_render`(2238),
`vedit_composite_parity`(2334), `vedit_audio_parity`(2628),
`vedit_encode_smoke`(1840)) plus their private types/helpers:
`CompositeParitySpec`(2326), `AudioParitySeg`(2454), `AudioParitySpec`(2467),
`SmokeResult`(1827), `audio_parity_export_spec`(2481),
`audio_parity_source_graph`(2512), `audio_parity_export_graph`(2532),
`parity_temp`(2556). These reuse the export machinery (`ExportSpec`, graph
builders, `caps_cached`) — all still in `mod.rs`/`probe.rs` and reachable via
`use super::*;`. In `mod.rs`: `mod parity_harness; pub use parity_harness::*;`.

**Verify**: build + tests exit 0; all 4 parity/smoke names present in all 3 ACL
sites (`grep -c "allow-vedit-\(parity-render\|composite-parity\|audio-parity\|encode-smoke\)" default.json` → 4;
same count in build.rs and lib.rs). This step gets the dev harness out of the
production-logic file — the plan's headline win.

#### Step B6 (HARD SEAM — may defer): move the export family → `video_editor/export.rs`

This is the ~1900-line core. Move the 3 export commands
(`vedit_export_start`(1956), `_cancel`(2198), `_status`(2225)) plus the export
machinery: the `ExportSpec` struct family (~347-680), the graph/encode helpers
(`materialize_one`, `layer_geom`, `input_args`, `video_encode_args`,
`master_audio_tail`, `parse_loudnorm_json`, `encoder_chain`, etc.), the statics
`EXPORT`(1939)/`LUT_SEQ`(688)/`TITLE_SEQ`(754), `export_signal`(1942),
`emit_export`(1948), `shutdown_export`(2674). Because `lut.rs` and
`parity_harness.rs` reference `materialize_one`/`LUT_SEQ`/`ExportSpec`, either
(a) keep those shared items in `mod.rs` and move only the export *commands* +
export-only helpers, or (b) move them to `export.rs` and add `pub use export::*;`
so submodules still reach them via `super::`. Prefer (b) for a real reduction.
`export.rs` top: `use super::*;`. In `mod.rs`: `mod export; pub use export::*;`.

**Verify**: build + tests exit 0; export commands present in all 3 ACL sites;
manual: run an actual export in the editor — the produced file must play (this
seam touches the encode path, so a runtime export smoke is mandatory, not
optional). **If the shared-item hoist balloons or the borrow/lifetime errors
cascade, STOP and ship B1–B5 only** — the dev-harness extraction (B5) is the
primary win and stands alone; export can be a follow-up plan.

## Test plan

- No new unit tests required — this is pure code motion. The existing
  `#[cfg(test)] mod tests` in `video_editor.rs` moves with whichever submodule
  owns the code it tests (grep `#[test]` in `mod.rs` after B1 and relocate the
  block alongside its subject in the relevant B-step).
- Regression coverage is the **verify gates**: each step's `cargo build` +
  `cargo test --tests` + the 3-site ACL grep counts + one manual IPC smoke prove
  no command lost its registration and no behavior changed.
- Half A regression is `npm --prefix web run build` (import/export resolution) +
  the manual media + planner render smokes.

## Done criteria

Machine-checkable, for whichever seams shipped:

- [ ] Half A: `npm --prefix web run build` exits 0; `web/src/api/media.js` and
      `web/src/api/planner-parsers.js` exist; `grep -rl "parseBlockLibrary" modules`
      still returns nothing (no importer churn).
- [ ] Half B: `cargo build --manifest-path src-tauri/Cargo.toml` exits 0;
      `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0.
- [ ] Half B ACL intact: for every moved command, its name is still present in
      `build.rs`, `capabilities/default.json` (dash form), and `lib.rs`
      (`commands::video_editor::…` path) — total counts unchanged: 17 in each.
- [ ] `src-tauri/src/lib.rs`, `build.rs`, `capabilities/default.json` are **byte-for-byte
      unchanged** (`git diff --stat` shows them untouched).
- [ ] Manual: the app boots and the Video Editor's moved features (project I/O,
      LUT, probe, export if B6 shipped) work with no "not allowed" IPC error.
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts don't match the live code at the cited lines (drift).
- After a B-step, any ACL grep count drops — a moved command lost its `pub use`
  re-export. Report which command and which site.
- The `api.js` media split throws a TDZ/cycle error at runtime that the `core.js`
  fallback (in A1) doesn't fix.
- A `cargo build` borrow/lifetime cascade in B6 (export) can't be resolved by
  hoisting shared items to `mod.rs` within a reasonable attempt — ship B1–B5 and
  report export as deferred.
- You find yourself needing to edit `lib.rs`/`build.rs`/`default.json` to make it
  compile — the re-export shim is wrong; fix the shim, don't edit the ACL sites.

## Maintenance notes

- **The re-export shims are load-bearing.** `mod.rs`'s `pub use <sub>::*;` lines
  are the only reason `lib.rs`'s Rust paths and the name-derived ACL entries keep
  working after the move. A reviewer must confirm every moved command is covered
  by a `pub use`.
- **Dev-gating the parity/smoke commands is the natural follow-up** to B5: now
  that they live in `parity_harness.rs`, a future change could `#[cfg(debug_assertions)]`
  the `mod parity_harness;` (and conditionally drop their 3-site ACL entries) so
  they don't ship in release builds. That's a runtime-behavior change needing its
  own decision — deliberately not done here.
- **`api.js`'s Health parser block (`:1196-1361`) is the next A seam** — same
  pattern (extract to `api/health-parsers.js`, re-export). And the ideal end state
  for the planner parsers is to live IN the planner module
  (`modules/core/planner/`), not the host SDK — but that requires the `api`
  object's planner methods to move too, so it's a larger follow-up, not this plan.
- A reviewer should scrutinize: (A) that no `@host/api.js` export name disappeared
  (diff the barrel's export surface before/after); (B) that the export encode path
  (B6) produces byte-identical ffmpeg args after the move (compare a rendered
  file, or the logged command, against pre-refactor).

# Plan 006: Add a repo-root CLAUDE.md and a .env.example

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` if that index exists — unless a reviewer dispatched you and
> told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- README.md src-tauri/Cargo.toml src-tauri/src web modules`
> If any file below that this plan quotes has changed since `57a6c80`, re-read it
> and compare against the "Current state" excerpts before proceeding; on a
> mismatch treat it as a STOP condition. (This plan writes two NEW files, so the
> main drift risk is the facts it tells you to encode having moved.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

Every improvement plan in this batch is executed BY a coding agent in this
repo, and each one currently re-derives the same facts from scratch: the
build/dev/verify commands, the plain-JS-no-TypeScript rule, the 3-site IPC ACL
gotcha (miss one site and the command is silently denied at runtime), the
host/module boundary, and the environment-variable surface. There is **no**
`CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md` anywhere in the repo (verified:
the glob below returns nothing) and **no** `.env.example`. Two small files —
a `CLAUDE.md` agent-orientation doc and a `.env.example` enumerating the env
surface — turn that repeated re-derivation into one lookup and stop agents from
inventing env-var names or forgetting an ACL site.

## Current state

Verified facts, inlined:

- **No agent doc exists**: `git ls-files | grep -iE '(^|/)(CLAUDE|AGENTS|CONTRIBUTING)\.md$'`
  returns nothing. **No env template exists**: no `.env.example` / `.env.sample`
  tracked. `web/.env` IS gitignored and sets `VITE_BUILD_TIER=studio` for local
  studio artifacts (see `modules/studio/video-editor/index.jsx:11-14`) — do NOT
  read, copy, or commit it.
- **Build system** (`package.json`, `web/package.json`, `src-tauri/tauri.conf.json`):
  - Root `package.json` scripts: `"dev": "tauri dev"`, `"build": "tauri build"`,
    `"tauri": "tauri"`. Only devDependency is `@tauri-apps/cli`.
  - `web/package.json` scripts include `"check-themes": "node scripts/check-theme-contrast.mjs"`
    and `"check-drag": "node scripts/check-drag-math.mjs"` — the two web check
    scripts. React `^18.3.1`, Vite `^6.0.5` (so: React 18 + Vite 6, plain JS —
    there is no `typescript` dependency and no `tsconfig` in `web/`).
  - `tauri.conf.json`: `"frontendDist": "../web/dist"`, `"targets": ["nsis"]`,
    `beforeBuildCommand` runs `npm --prefix web run build` first.
- **Backend shape** (`src-tauri/`): every backend entry point is a
  `#[tauri::command]` reached over IPC. The ONLY network-listening surface is the
  loopback media server at `src-tauri/src/media_server.rs` (an axum server bound
  to 127.0.0.1, surfaced by the `media_server_port` command). Confirm with:
  `grep -rn "TcpListener\|axum::serve\|\.serve(" src-tauri/src` — the hits should
  be media_server.rs only.
- **3-site IPC ACL** (all three verified present):
  1. `src-tauri/build.rs` — `tauri_build::AppManifest::new().commands(&[ ... ])`
     lists every command name (starts `"ping", "media_server_port",
     "hide_overlay_host", "vedit_project_list", ...`).
  2. `src-tauri/capabilities/default.json` — grants each as an `allow-<kebab-case>`
     permission (plus `browser-content.json` for the isolated browser webview).
  3. `src-tauri/src/lib.rs:609` — `.invoke_handler(tauri::generate_handler![
     commands::ping, ... ])`.
  A new command missing from ANY of the three fails at runtime with a "not
  allowed by ACL" error and no compile error — this is the single most common
  silent failure in this repo and the top reason the CLAUDE.md exists.
- **Frontend module system** (`web/src/module-loader.js`): features live in
  `modules/{core,studio}/<name>/` and are discovered via `import.meta.glob`
  (`module-loader.js:85-92`). Studio-tier modules load only when
  `import.meta.env.VITE_BUILD_TIER === 'studio'` (`module-loader.js:82`); core
  builds see only `modules/core/*`. The host app is `web/` (aliased `@host`).
- **Sidecar crates**: `mortar-pestle-capture/`, `mortar-pestle-stt/`,
  `mortar-pestle-broadcast/` at the repo root, plus `nvenc-sys/`. There is **no
  root `Cargo.toml`** (verified: `ls Cargo.toml` → not found), so these are NOT a
  Cargo workspace — each crate builds independently. They speak NDJSON to the
  Tauri host over a named pipe (Windows) / Unix domain socket (Linux); the wire
  protocol is copied into each crate, not shared.
- **Dependency intent comments already in `src-tauri/Cargo.toml`** (encode these
  as gotchas):
  - `windows = { version = "0.61", ... }` pinned to 0.61 so `WebviewWindow::hwnd()`'s
    HWND unifies with Tauri's (comment at lines 74-80).
  - `keyring` needs a per-platform backend feature (`sync-secret-service` on Unix,
    `windows-native` on Windows) or v3 silently becomes an in-process mock that
    "succeeds" but persists nothing (comment at lines 68-70).
  - `sha1` (line 40) = content-addressing; `sha2` (line 41) = security — both are
    intentional, not a duplicate to dedupe.
- **Test gotcha** (see other plans / memory): `cargo test --lib` SIGTERMs in this
  repo; always use `--tests`.

The env-var surface (verified via the two greps in Step 2 — this is the seed
list; the executor RE-RUNS the greps and reconciles, because drift may add
vars). NO VALUES anywhere — names, required/optional, and source `file:line`
only:

**Frontend / build-time** (read as `process.env.*` in `web/vite.config.js` or as
`import.meta.env.*` in code):

| Var | Req? | Source | Meaning (one line) |
|-----|------|--------|--------------------|
| `VITE_BUILD_TIER` | optional (default `core`) | `web/src/module-loader.js:82` | `core` \| `studio`; gates studio modules |
| `VITE_TARGET_OS` | optional (defaults to host) | `web/vite.config.js:19,27` | target-OS define for OS-gated code |
| `VITE_DEV_TOOLS` | optional | `web/src/components/SettingsDrawer.jsx:71` | `1` keeps the Dev tab in a prod build |
| `AOS_DESIGN` | optional (default on) | `web/vite.config.js:13` | `0` opts out of component-id JSX injection |

**Backend** (`std::env::var` / `option_env!` in `src-tauri/`):

| Var | Req? | Source | Meaning |
|-----|------|--------|---------|
| `MORTAR_PESTLE_SUPABASE_URL` | optional | `commands/feedback.rs:28,37` | feedback backend URL (`option_env!` baked + runtime fallback; public) |
| `MORTAR_PESTLE_SUPABASE_ANON_KEY` | optional | `commands/feedback.rs:29,53` | public anon key, RLS-gated (public by design) |
| `ANTHROPIC_API_KEY` | optional | `commands/design.rs:143,166`, `commands/coaching.rs:324` | agent key; keyring-first, so also settable in-app |
| `AGENTIC_VAULT_ROOT` | optional | `commands/vault.rs:25` | content-vault path override |
| `AGENTIC_APP_VAULT_ROOT` | optional | `commands/vault.rs:41` | app-vault path override |
| `AGENTIC_PULSE_VAULT_ROOT` | optional | `commands/vault.rs:50` | pulse-vault path override |
| `AGENTIC_LIBRARY_VAULT_ROOT` | optional | `commands/vault.rs:61`, `commands/vaults.rs:423` | library-vault path override |
| `AGENTIC_GAMEWIKI_VAULT_ROOT` | optional | `commands/vault.rs:72`, `commands/vaults.rs:491` | gamewiki-vault path override |
| `AGENTIC_CAPTURES_ROOT` | optional | `commands/vault.rs:109` | captures dir override |
| `AGENTIC_MEDIA_ROOTS` | optional | `commands/media.rs:32` | media-library roots override |
| `MORTAR_PESTLE_CAPTURE_BIN` | optional | `capture/carriage.rs:62` | capture sidecar binary path override |
| `MORTAR_PESTLE_STT_BIN` | optional | `stt/carriage.rs:63` | STT sidecar binary path override |
| `MORTAR_PESTLE_BROADCAST_BIN` | optional | `broadcast/carriage.rs:58` | broadcast sidecar binary path override |

**Also present, NOT in the original seed list — include them (this is exactly why
Step 2 enumerates rather than trusting a fixed list):**

| Var | Req? | Source | Meaning |
|-----|------|--------|---------|
| `AGENTIC_TODAY` | optional (dev/test) | `parsers/daily.rs:20` | override "today" for the daily page |
| `AGENTIC_CODE_ROOT` | optional | `commands/release.rs:52` | code-repo path override |
| `AGENTIC_APP_CONFIG_ROOT` | optional | `commands/sidebar.rs:29` | app-config dir override |
| `QBIT_PASS` | optional | `commands/qbit.rs:81` | qBittorrent Web UI password fallback (keyring-first) |
| `MORTAR_PESTLE_WT_TITLE` | optional (dev) | `lib.rs:599` | dev worktree window-title override |

**Do NOT list OS-provided vars** the app merely reads (they are not app config):
`RUST_LOG`, `PATH`, `HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`,
`ProgramFiles`, `COMSPEC`, `SHELL`, `XDG_RUNTIME_DIR`, `XDG_DATA_HOME`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install (root) | `npm install` | exit 0 |
| Install (web) | `npm --prefix web install` | exit 0 |
| Dev | `npm run tauri dev` | Vite HMR at `127.0.0.1:5173` + desktop window opens |
| Build | `npm run tauri build` | NSIS installer under `src-tauri/target/release/bundle/nsis/` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --tests` | all pass (NEVER `--lib` — SIGTERMs) |
| Web check (themes) | `npm --prefix web run check-themes` | exit 0 |
| Web check (drag) | `npm --prefix web run check-drag` | exit 0 |
| Confirm no agent doc | `git ls-files \| grep -iE '(CLAUDE\|AGENTS\|CONTRIBUTING)\.md'` | no output (before Step 1) |

## Scope

**In scope** (create these two files, nothing else):
- `CLAUDE.md` (repo root — new)
- `.env.example` (repo root — new)

**Out of scope** (do NOT touch):
- `web/.env` — gitignored; contains local build-tier config. Never read into,
  copy from, or commit it.
- Any source file. This plan is documentation only; if writing CLAUDE.md tempts
  you to "fix" an ACL site or a script, that is a different plan — STOP and report.
- `plans/README.md` beyond your own status row.

## Git workflow

- Branch: `advisor/006-claude-md-and-env-example` (or the repo convention if one
  is evident from `git branch`).
- One commit is fine (two docs). Message style — match `git log --oneline -5`
  (this repo uses terse conventional-ish subjects, e.g. `docs: add CLAUDE.md ...`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write repo-root `CLAUDE.md`, verifying every fact against the tree

Create `CLAUDE.md` at the repo root using the skeleton below. For each claim,
confirm it against the live repo before writing it — if a claim is false or the
file moved, fix the text to match reality (or drop the line and note it).

Skeleton to fill:

```markdown
# CLAUDE.md — Mortar & Pestle

Agent orientation for this repo. Read before editing.

## Commands
- Install: `npm install && npm --prefix web install`
- Dev: `npm run tauri dev`  (Vite HMR + Tauri window)
- Build: `npm run tauri build`  (NSIS installer → src-tauri/target/release/bundle/nsis/)
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml --tests`  (NEVER --lib — SIGTERMs)
- Web checks: `npm --prefix web run check-themes` and `npm --prefix web run check-drag`

## Architecture
- Tauri 2 Rust shell in `src-tauri/`. All backend is `#[tauri::command]` over IPC.
  The only network surface is the loopback axum media server (`src-tauri/src/media_server.rs`).
- Frontend host: `web/` — React 18 + Vite 6, **plain JS, no TypeScript**.
- Features are modules in `modules/{core,studio}/<name>/`, loaded via
  `import.meta.glob` (`web/src/module-loader.js`), gated by `VITE_BUILD_TIER`
  (`studio` unlocks the studio tier; default `core`).
- Three sidecar crates at repo root: `mortar-pestle-{capture,stt,broadcast}`
  (+ `nvenc-sys`). NO Cargo workspace — each builds standalone. They speak NDJSON
  over a named pipe (Windows) / UDS (Linux); the protocol is copied per crate,
  not shared.

## Conventions
- **New IPC command = 3 ACL sites or it is silently denied at runtime:**
  (1) `src-tauri/build.rs` commands list, (2) `src-tauri/capabilities/default.json`
  as `allow-<kebab>`, (3) `src-tauri/src/lib.rs` `generate_handler!`. Miss one →
  runtime "not allowed by ACL", no compile error.
- `sha1` = content-addressing, `sha2` = security. Both are intentional; not a dup.
- Design passes follow the token → primitive → pattern order in the design doc.
  (VERIFY where DESIGN.md lives — see note in Step 1; if it is not in this repo,
  say where it is or omit this line.)

## Gotchas
- NEVER `cargo test --lib` — it SIGTERMs. Use `--tests`.
- `windows` crate pinned to 0.61 for HWND unification with Tauri (`Cargo.toml`).
- `keyring` needs a per-platform backend feature or it silently no-ops (writes
  "succeed" but nothing persists).
- Studio sidecars are inert in `core` builds (tier gating is build-time).

## Env
See `.env.example` for the full variable surface. All are optional; none are
secrets that must be set to run the core app.
```

Verification notes while writing:
- Confirm the media-server-is-only-network-surface line:
  `grep -rn "TcpListener\|axum::serve\|\.serve(" src-tauri/src` → media_server.rs only.
- Confirm no TypeScript: `ls web/tsconfig*.json 2>/dev/null` → nothing; and
  `grep '"typescript"' web/package.json` → nothing.
- **DESIGN.md location**: `ls docs/DESIGN.md src-tauri/../docs/DESIGN.md 2>/dev/null`.
  If it does not exist in this repo, the design doc lives outside the code repo —
  reword the convention line to say "see the project design doc" (do not invent a
  repo path). Do NOT assert a `docs/DESIGN.md` that isn't there.

**Verify**: `test -f CLAUDE.md && echo OK` → `OK`; and every command in the
CLAUDE.md "Commands" section actually runs (spot-check at least
`cargo test --manifest-path src-tauri/Cargo.toml --tests`,
`npm --prefix web run check-themes`, `npm --prefix web run check-drag` → all exit 0).

### Step 2: Enumerate the env surface and write `.env.example`

Re-run both greps and reconcile against the seed tables in "Current state" (add
any new hits, drop any that disappeared):

- Frontend: `grep -rnoE "VITE_[A-Z_]+|AOS_DESIGN|process\.env\.[A-Z_]+" web modules --include=*.js --include=*.jsx`
- Backend: `grep -rnE "std::env::var(_os)?\(\"|option_env!\(\"" src-tauri/src`

Write `.env.example` at the repo root: one `NAME=` line per variable (VALUE LEFT
EMPTY — never a real or placeholder secret), each preceded by a one-line comment
giving required/optional + source + meaning, grouped "Frontend / build-time" and
"Backend". Exclude the OS-provided vars listed in "Current state". If a grep
surfaces a variable whose purpose you cannot determine from its `file:line`
context, add it with the comment `# purpose: TBD (see <file:line>)` rather than
guessing.

Example shape (NO real values, ever):

```dotenv
# Frontend / build-time (read by web/vite.config.js or import.meta.env)
# optional (default "core"); web/src/module-loader.js:82 — "core"|"studio", gates studio modules
VITE_BUILD_TIER=
...
# Backend (src-tauri/)
# optional; commands/feedback.rs:28 — public feedback backend URL (RLS-gated)
MORTAR_PESTLE_SUPABASE_URL=
...
```

**Verify**: `test -f .env.example && echo OK` → `OK`; `grep -c '=' .env.example`
≥ 22 (14 seed backend + 4 frontend + the 5 extra found in recon, minus any that
drifted away); and no line contains a value after `=`
(`grep -nE '=[^ ]' .env.example` → no output).

### Step 3: Final confirmation

**Verify**:
- `git status --porcelain` shows exactly two new files: `CLAUDE.md` and
  `.env.example` (plus your `plans/README.md` row edit if that file exists).
- `git ls-files --others --exclude-standard | grep -E '^(CLAUDE\.md|\.env\.example)$'`
  → both listed.

## Test plan

No unit tests — this is documentation. The "test" is that every command the
CLAUDE.md advertises runs green:
- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → pass
- `npm --prefix web run check-themes` → exit 0
- `npm --prefix web run check-drag` → exit 0
- `npm install` and `npm --prefix web install` → exit 0

## Done criteria

ALL must hold:

- [ ] `CLAUDE.md` exists at repo root and every command in it runs green.
- [ ] `.env.example` exists at repo root; every variable is present with an empty
      value and a source-cited comment; no values are filled in.
- [ ] The env list matches a fresh run of the two greps (no invented names, none
      missed).
- [ ] `git status` shows only `CLAUDE.md` + `.env.example` added (no source files
      touched).
- [ ] `plans/README.md` status row updated (if that index exists).

## STOP conditions

Stop and report (do not improvise) if:

- Any command in the CLAUDE.md skeleton fails to run (e.g., `check-themes` is
  gone, or `tauri` scripts errored) — report which, do not silently drop it.
- An architecture claim can't be verified against the tree (e.g., no
  `media_server.rs`, or the 3 ACL sites don't all exist) — report the real shape.
- A grep surfaces an env var you cannot explain from its `file:line` — mark it
  `TBD` and note it; do not assign it a meaning or a value.
- Writing the doc reveals a real bug or missing ACL site — that is out of scope
  for this docs plan; report it, don't fix it here.

## Maintenance notes

- The env tables and ACL-site list are the parts most likely to rot. When a new
  `#[tauri::command]` or env var lands, both `.env.example` and the CLAUDE.md
  gotchas should be updated in the same change.
- `docs/DESIGN.md` may not live in this repo (the design doc is maintained in an
  external vault). Whoever reviews should confirm the CLAUDE.md points at the
  right place rather than a dead path.
- A reviewer should scrutinize: (1) no secret VALUES leaked into `.env.example`,
  (2) the 3-ACL-sites description is exact, (3) `check-*` script names match
  `web/package.json`.

# Plan 016: Retire the Linux-era RPM/systemd framing around the Dev Server panel (button bug already mitigated)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md` **if that file exists** (it may not yet — do not create it).
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- src-tauri/src/commands/dev_service.rs src-tauri/src/lib.rs web/src/components/settings/DevTab.jsx web/src/components/settings/DevServerPanel.jsx src-tauri/src/commands/build.rs src-tauri/src/commands/coaching.rs`
> If any of those changed since this plan was written, compare against the
> "Current state" excerpts before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: **P3** (downgraded from the P1 lead — see Reality check; the
  user-facing bug is already mitigated, so what remains is comment/doc cleanup)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (coordinates with Plan 003 on the shared file
  `coaching.rs` — see Maintenance notes)
- **Category**: tech-debt / docs
- **Planned at**: commit `57a6c80`, 2026-07-03

## Reality check — read before doing anything

The lead for this plan was "the DevServerPanel button throws *command not
found* on Windows because `dev_service_action` is registered
`#[cfg(target_os = "linux")]` only." **That is already handled** as of the
Windows port (SF5). The frontend never renders the panel on Windows:

```jsx
// web/src/components/settings/DevTab.jsx:39-51
      {import.meta.env.VITE_TARGET_OS === 'linux' ? (
        <PanelBoundary>
          <DevServerPanel accent={accent} />
        </PanelBoundary>
      ) : (
        <div style={{ ... }}>
          Dev-server restart is Linux-only — Windows dev runs via{' '}
          <code>npm run tauri dev</code> in a terminal.
        </div>
      )}
```

```js
// web/vite.config.js:19-21 — targetOs resolves to 'windows' on a Windows build host
const targetOs = process.env.VITE_TARGET_OS
  || (process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos' : 'linux');
```

```js
// web/vite.config.js:27 — baked into the bundle as a Vite define
    'import.meta.env.VITE_TARGET_OS': JSON.stringify(targetOs),
```

So on a Windows build, `VITE_TARGET_OS === 'linux'` is `false`, the panel is
replaced by an informational message, and `invoke('dev_service_action')` never
fires — no broken button. The recommended "gate the panel off on non-Linux"
fix is **already implemented**; do not re-do it. The command staying
`#[cfg(target_os = "linux")]` (lib.rs:632-633) is correct: it is Linux-only by
design, and the only surface that could call it is Linux-gated too.

**Therefore this plan is NOT a bug fix.** It is a small cleanup of stale
Linux-only prose ("compiled into the production RPM", "systemd dev service")
left behind in comments — accurate on Linux, misleading on Windows/NSIS. If the
operator only cares about the (already-fixed) button, this whole plan can be
**rejected** — record that in `plans/README.md` and stop.

## Current state

### 1. Stale "production RPM" framing — `src-tauri/src/commands/dev_service.rs:1-6`

```rust
//! Dev-server supervisor — Start/Stop/Restart/Status for the `mortar-pestle-dev`
//! systemd *user* service (the `cargo tauri dev` surface) plus a Vite health
//! probe. Drives the Dev Server panel in Settings → Dev. Unlike the rest of
//! that tab this command is compiled into the production RPM (the panel is kept
//! via the VITE_DEV_TOOLS gate) so the stable build can revive a dead dev
//! window — you can't click a restart button inside a crashed dev window.
```

The module *is* still systemd-only and Linux-only (that's correct), but "the
production RPM" is Linux-packaging language; the Windows installer is NSIS. The
factual gap: this command is not in the Windows build at all (it's
`#[cfg(target_os = "linux")]`), so "compiled into the production RPM" should
read as Linux-specific, not as a universal statement.

### 2. Same stale framing — `web/src/components/settings/DevServerPanel.jsx:1-5`

```jsx
// Dev Server control panel — Start/Stop/Restart/Status for the `mortar-pestle-dev`
// systemd *user* service (the `cargo tauri dev` surface), with a Vite health
// probe. Unlike the rest of the Dev tab this panel is built into the production
// RPM (VITE_DEV_TOOLS gate in SettingsDrawer) so the stable build can revive a
// dead dev window — you can't click a restart button inside a crashed window.
```

Now inaccurate twice: the panel is Linux-only (gated in DevTab.jsx, not just
"VITE_DEV_TOOLS"), and "the production RPM" ignores Windows/NSIS.

### 3. Stale systemd comment — `src-tauri/src/commands/coaching.rs:418-419`

```rust
    // Reuse design.rs's resolver: configured path → PATH lookup → ~/.local/bin fallback
    // (the systemd dev service's PATH omits ~/.local/bin where `claude` lives).
```

The `~/.local/bin` fallback and "systemd dev service's PATH" are Linux-isms in
a cross-platform code path. The *code* (`resolve_cli_path`) is fine; the
parenthetical rationale is Linux-only trivia that misleads on Windows.

### 4. Dead `.rpm` phase-detection literal — `src-tauri/src/commands/build.rs:161-174`

```rust
fn detect_phase(line: &str, mode: BuildMode) -> Option<BuildPhase> {
    let l = line.to_ascii_lowercase();
    if l.contains("vite v") || (l.contains("vite") && l.contains("build")) {
        return Some(BuildPhase::Web);
    }
    let t = l.trim_start();
    if t.starts_with("compiling ") || t.starts_with("finished ") {
        return Some(BuildPhase::Rust);
    }
    if matches!(mode, BuildMode::Release) && (l.contains("bundling") || l.contains(".rpm")) {
        return Some(BuildPhase::Bundle);   // ← line 170: ".rpm" never appears in NSIS output
    }
    None
}
```

On Windows the release bundler is NSIS; its log lines never contain `.rpm`. The
generic `"bundling"` token already catches the Bundle phase cross-platform, so
`.rpm` is dead weight (harmless — it only affects the phase *label* shown in the
in-app Rebuild UI, never correctness).

### 5. `resolve_npm` is NOT rot — do not touch it

The audit lead flagged the `/usr/bin/npm` hardcodes as Linux rot. **They are
correct, `#[cfg]`-gated code — leave them:**

```rust
// build.rs:92-115  → #[cfg(windows)] fn resolve_npm() — PATH → ProgramFiles\nodejs → %APPDATA%\npm\npm.cmd
// build.rs:117-143 → #[cfg(not(windows))] fn resolve_npm() — /usr/bin/npm, /usr/local/bin/npm, ~/.local, nvm, fnm
```

Windows already has its own correct `resolve_npm`. The `/usr/bin/npm` list is
inside `#[cfg(not(windows))]` and is the intended Unix behavior (it exists
precisely because an installed app's launcher PATH may omit npm). Stripping it
would break Unix npm resolution. **Out of scope.**

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat 57a6c80..HEAD -- <in-scope paths>` | empty |
| Rust compile | `cargo check --manifest-path src-tauri/Cargo.toml` | exit 0 |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --tests` | all pass |
| Web build (comment-only, sanity) | `npm --prefix web run build` | exit 0 |

Run from repo root (`C:\Users\malth\Code\mortar-pestle`). **Never**
`cargo test --lib` (it SIGTERMs) — always `--tests`.

## Scope

**In scope** (comment/string edits only — no logic changes):
- `src-tauri/src/commands/dev_service.rs` — header comment (item 1).
- `web/src/components/settings/DevServerPanel.jsx` — header comment (item 2).
- `src-tauri/src/commands/coaching.rs` — the comment at lines ~418-419 (item 3).
- `src-tauri/src/commands/build.rs` — `detect_phase`, drop/replace the `.rpm`
  literal (item 4).

**Out of scope** (do NOT touch):
- The `#[cfg(target_os = "linux")]` gate on `dev_service_action`
  (`lib.rs:632-633`) and its entry in the Tauri ACL manifest
  (`src-tauri/build.rs:27`, the file that lists command names) — the command is
  Linux-only **by design**; the frontend already hides its surface on Windows.
  Removing the gate or writing a Windows twin is explicitly rejected (the
  Windows dev surface is `npm run tauri dev` in a terminal).
- `DevTab.jsx` — the platform gate there is the working mitigation; leave it.
- `resolve_npm` in `build.rs` (item 5) — correct cfg-gated code.
- The tracked capture / broadcast / stt `#[cfg(unix)]` port code, and the entire
  dirty `mortar-pestle-broadcast/` subtree.

## Git workflow

- Branch: `advisor/016-devserver-linux-prose` off current HEAD.
- One commit; conventional-commit style, e.g.
  `docs(dev): retire Linux/RPM-only framing from dev-server + build comments`.
- The working tree is already dirty under `mortar-pestle-broadcast/`. Stage only your
  in-scope files with explicit `git add <path>` — never `git add -A`.
- Do NOT push or open a PR unless instructed.

## Steps

> If the operator wants only the (already-fixed) button and not the prose
> cleanup, mark this plan **REJECTED** in `plans/README.md` and stop here.

### Step 1: De-Linux-ify the two panel header comments (items 1 & 2)

Reword so the Linux/systemd/RPM specifics are framed as Linux-only, not
universal. Keep them accurate and short. Suggested target for
`dev_service.rs:1-6`:

```rust
//! Dev-server supervisor (Linux only) — Start/Stop/Restart/Status for the
//! `mortar-pestle-dev` systemd *user* service (the `cargo tauri dev` surface) plus a
//! Vite health probe. Registered `#[cfg(target_os = "linux")]`; on Linux it is
//! kept in the shipped build (via the VITE_DEV_TOOLS gate) so the stable window
//! can revive a dead dev window. Windows/macOS dev runs from a terminal
//! (`npm run tauri dev`) — DevTab.jsx renders a note there instead of this panel.
```

And `DevServerPanel.jsx:1-5` similarly: state it is the Linux-only panel, gated
in `DevTab.jsx` behind `VITE_TARGET_OS === 'linux'`, and drop "the production
RPM" phrasing. Do not change any code, only the comment text.

**Verify**: `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0;
`npm --prefix web run build` → exit 0.

### Step 2: Fix the stale systemd rationale in coaching.rs (item 3)

Reword `coaching.rs:418-419` so it no longer implies a systemd runtime.
Suggested:

```rust
    // Reuse design.rs's resolver: configured path → PATH lookup → platform
    // fallback dirs (covers launchers whose PATH omits where `claude` is installed).
```

**Verify**: `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0.

> Coordination: Plan 003 also edits `coaching.rs` (line ~168, a different
> region). Re-read the file immediately before this edit. If Plan 003 has not
> yet landed, your comment edit and its `-i` edit are on disjoint lines and
> won't conflict — but confirm with a fresh Read.

### Step 3: Drop the dead `.rpm` token in build.rs detect_phase (item 4)

In `detect_phase` (`build.rs:170`), remove the `|| l.contains(".rpm")` clause
so the Bundle phase keys off the cross-platform `"bundling"` token alone (add
NSIS-specific tokens only if you observe a real Windows release log that needs
them — do not speculate):

```rust
    if matches!(mode, BuildMode::Release) && l.contains("bundling") {
        return Some(BuildPhase::Bundle);
    }
```

**Verify**:
- `cargo check --manifest-path src-tauri/Cargo.toml` → exit 0.
- `cargo test --manifest-path src-tauri/Cargo.toml --tests` → all pass.
- `grep -rn '\.rpm' src-tauri/src/commands/build.rs` → no matches.

## Test plan

- No new tests: every change is a comment or a dead-token removal with no
  behavioral surface (`detect_phase` on Windows already returned via
  `"bundling"`; the `.rpm` branch was unreachable there). Adding a test for a
  string-matching phase heuristic would be busywork — YAGNI.
- Guard against regressions with the existing suite:
  `cargo test --manifest-path src-tauri/Cargo.toml --tests`.

## Done criteria

ALL must hold:

- [ ] `cargo check --manifest-path src-tauri/Cargo.toml` exits 0.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --tests` exits 0.
- [ ] `npm --prefix web run build` exits 0.
- [ ] `grep -rn '\.rpm' src-tauri/src/commands/build.rs` returns nothing.
- [ ] No occurrence of "production RPM" remains in `dev_service.rs` or
      `DevServerPanel.jsx` (`grep -rn "production RPM" src-tauri/src web/src`).
- [ ] `lib.rs`, `src-tauri/build.rs`, `DevTab.jsx`, and `resolve_npm` are
      unmodified (`git status`).
- [ ] Only in-scope files changed; the `mortar-pestle-broadcast/` dirt you did not
      create is not staged.

## STOP conditions

Stop and report (do not improvise) if:

- The `#[cfg(target_os = "linux")]` gate on `dev_service_action`
  (`lib.rs:632-633`) has already changed since `57a6c80` — the whole premise
  shifted; reassess before touching anything.
- `DevTab.jsx:39`'s `VITE_TARGET_OS === 'linux'` gate is gone or changed — the
  "already mitigated" claim no longer holds; report it.
- Any step's verification fails twice after a reasonable fix attempt.
- You find yourself wanting to change logic (not just comments/the `.rpm`
  token) — that's out of scope; stop and surface it.

## Maintenance notes

- This plan deliberately does **not** add a Windows dev-server control. If a
  Windows dev-server-control surface is ever wanted, that's a new feature
  (a Windows twin for `dev_service_action` driving `npm run tauri dev` /
  the Tauri dev process), not this cleanup — track it separately.
- `coaching.rs` is shared with **Plan 003** (P0). Let 003 land first; re-Read
  before editing.
- Reviewer: confirm this PR changed only comments plus the one dead `.rpm`
  token, and touched neither the cfg gate, the ACL manifest, nor `resolve_npm`.

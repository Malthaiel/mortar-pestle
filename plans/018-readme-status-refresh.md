# Plan 018: Correct the stale README Status section

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update this plan's row in `plans/README.md` if that index exists — unless a
> reviewer told you they maintain it.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- README.md src-tauri/src/commands/browser_windows.rs src-tauri/src/commands/stt.rs src-tauri/src/commands/mod.rs src-tauri/tauri.conf.json modules/studio/overlay`
> If any of those changed since `57a6c80`, re-read them and compare against the
> "Current state" excerpts before editing. On a mismatch, treat it as a STOP
> condition — the whole point of this plan is that the README no longer matches
> the code, so you must confirm the code's current claims first-hand.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

`README.md` tells prospective users and contributors what works. Its Status
section currently claims four subsystems are "stubbed" on Windows — but three of
the four are ported and live as of `57a6c80`. That understates the project and
misleads anyone deciding whether to build or contribute. Only one subsystem
(Game Capture's engine) is genuinely absent on Windows. This plan narrows the
Status to that one true gap and, along the way, mentions the Broadcast subsystem
the README omits entirely.

## Current state

The stale line — `README.md:38` (verbatim):

> `Windows is the primary platform. Four subsystems are stubbed in the current Windows build and are being ported: **Game Capture**, **in-app browser**, **STT / voice dictation**, and **in-game overlay**.`

Verified against the code (read these headers before you rewrite — they are the
evidence, and the STOP condition is that they contradict "works"):

- **in-app browser → WORKS on Windows.** `src-tauri/src/commands/browser_windows.rs:1-31`
  header: "Windows (WebView2) in-app browser controller ... implements the SAME
  15 `browser_*` commands ... Phase 2 (2026-06-23) closed the Phase-1 gaps via a
  `with_webview` → `ICoreWebView2` reach-through ... permission deny-all ...
  faithful canBack/canForward ... favicons ... cookie enumeration + profile
  clear ... renderer-crash auto-reload." `commands/mod.rs:11-13` selects this
  module on Windows (`#[cfg(target_os = "windows")] #[path = "browser_windows.rs"]
  pub mod browser;`). This is a complete port, not a stub.
- **STT / voice dictation → WORKS on Windows.** `src-tauri/src/commands/stt.rs:28-32`:
  "So these commands are LIVE in file mode now — the relay below carries real
  engine events. Mic-driven dictation is LIVE too: `start_dictation` loads the
  speech model + streams `vu` + transcribed `segment`s; `stop_dictation` emits a
  terminal `final`." `commands/mod.rs:54-55` gates the module on
  `#[cfg(any(target_os = "linux", target_os = "windows"))]` — so it compiles and
  runs on Windows.
- **in-game overlay → MIXED (do NOT flatly call it "stubbed" OR "done").**
  Evidence it is real: `src-tauri/tauri.conf.json:26-38` defines a genuine
  `overlay-host` window (`"transparent": true, "alwaysOnTop": true,
  "skipTaskbar": true, "url": "index.html#/overlay/host"`), not a placeholder;
  `modules/studio/overlay/index.jsx` is a full studio-tier overlay hub with a
  4-page nav (Browser · Capture · STT · Scrim); `git log` shows landed overlay
  work (`88b2354` merge game-capture+stt into one Overlay module, `6708bc5`
  settings fix, `3d0827c` STT transcription overlay panel + hybrid-GPU capture
  device fix). Evidence it is NOT fully done: `modules/studio/overlay/index.jsx:22-30,70-71`
  — the **Browser and Scrim overlay panels are "coming soon" placeholders**; and
  the game-capture-fed overlay ultimately depends on the Linux-only capture
  engine (see next bullet). So the honest statement is: overlay host window +
  Capture/STT panels are live on Windows; Browser/Scrim panels are not yet built.
- **Game Capture → the ONE genuine Windows gap.** Its engine is the Linux stack
  (PipeWire / NVENC-GL / KWin) and is not ported to Windows. This is the only
  subsystem that belongs in a "not yet on Windows" note.
- **Broadcast (libobs) subsystem — omitted by the README, but real.** `git log`
  shows `d89dce2` (SP2 module shell & preview — live child-HWND `obs_display`
  preview) and `a34071e` (SP3 scenes & sources — combined tree, inspector,
  on-preview transforms, undo). Worth a one-line mention so the README reflects
  the current feature set.

**Do not conflate two different "browser"s.** The README's "in-app browser" is
the main WebView2 browser feature (works, per `browser_windows.rs`). The
overlay hub's "Browser" nav item is a separate, still-placeholder panel inside
the overlay. Rewriting the browser claim = the main feature (works); the overlay
Browser placeholder is only relevant to the overlay bullet.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Read the stale line | `grep -n "stubbed" README.md` | one hit at ~line 38 (before edit) |
| Confirm browser port | `sed -n '1,31p' src-tauri/src/commands/browser_windows.rs` | header text quoted above |
| Confirm STT live | `sed -n '25,33p' src-tauri/src/commands/stt.rs` | "LIVE in file mode now" |
| Confirm overlay window | `grep -n "overlay-host" src-tauri/tauri.conf.json` | one hit |
| Confirm overlay placeholders | `grep -n "coming soon\|OverlayComingSoon" modules/studio/overlay/index.jsx` | Browser/Scrim placeholders |
| After edit | `grep -n "stubbed\|Game Capture" README.md` | "stubbed"/"not yet" scoped to Game Capture only |

## Scope

**In scope**:
- `README.md` — the Status section only (around line 36-38).

**Out of scope** (do NOT touch):
- Any source file — this is a docs correction; do not "fix" code to match the
  README or vice-versa.
- Other README sections (Install, Build, Prerequisites, License) — leave them.

## Git workflow

- Branch: `advisor/018-readme-status-refresh` (or the repo convention).
- Single commit. Message style — match `git log --oneline -5` (terse
  conventional-ish, e.g. `docs: correct README Status ...`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Verify each claim against the cited code

Run the four "Confirm" commands in the table. Each header must still say what
"Current state" quotes. If any DOESN'T (e.g., `stt.rs` no longer says "LIVE",
or `browser_windows.rs` describes a stub), STOP — the code has regressed or
drifted and the plan's premise is wrong; report the real state instead of
editing.

**Verify**: all four confirm-commands print the expected text.

### Step 2: Rewrite the Status section

Replace the `README.md` Status section so it reflects reality. Target content
(adapt wording to the README's voice; the facts are load-bearing, the phrasing
is not):

- Windows is the primary platform.
- The one subsystem not yet on Windows: **Game Capture** — its capture engine
  (PipeWire / NVENC-GL / KWin) is Linux-only and is being ported.
- Do NOT list in-app browser or STT/voice as stubbed — both are live on Windows.
- The **in-game overlay**: state the mixed reality — the overlay host window plus
  its Capture and Speech-to-Text panels are live; the Browser and Scrim overlay
  panels are still in progress. (Do not call the overlay "stubbed" or "done".)
- Optionally add one line noting the new **Broadcast** (libobs) subsystem — a
  scene/source compositor with a live preview — as a recently landed feature.

Keep it short; the Status section is 1-3 sentences, not a changelog.

**Verify**: `grep -n "stubbed\|being ported\|not yet" README.md` — any remaining
"gap" language names **Game Capture only**; there is no "browser" or "STT" in a
stubbed/ported list.

### Step 3: Confirm no over-claim on the overlay

Re-read your new overlay sentence against `modules/studio/overlay/index.jsx:22-30,70-71`.
If your text implies the Browser or Scrim overlay panels work, soften it — they
are placeholders.

**Verify**: your overlay sentence distinguishes the live parts (host + Capture +
STT) from the in-progress parts (Browser, Scrim).

## Test plan

No automated tests (prose). The verification is the `grep` gates in Steps 2-3
plus a human re-read: someone reading only the new Status section should come
away believing exactly what the code supports — browser/STT/overlay-core live,
Game Capture engine pending, overlay Browser/Scrim pending.

## Done criteria

ALL must hold:

- [ ] `grep -n "stubbed" README.md` returns 0 hits, OR its only remaining
      stubbed/pending reference is Game Capture.
- [ ] README no longer lists in-app browser or STT/voice as stubbed/being-ported.
- [ ] The overlay sentence reflects the mixed state (host+Capture+STT live;
      Browser+Scrim pending), not a blanket claim.
- [ ] Only `README.md` changed (`git status --porcelain` shows README.md only).
- [ ] `plans/README.md` row updated (if that index exists).

## STOP conditions

Stop and report (do not improvise) if:

- Any cited code header contradicts the "works" claim (e.g., `stt.rs` no longer
  says the commands are LIVE, `browser_windows.rs` reads as a stub, or
  `commands/mod.rs` no longer gates STT/browser on Windows). Report the real
  state — do NOT write "works" over code that says otherwise.
- `tauri.conf.json` no longer has an `overlay-host` window (overlay may have been
  reworked) — report and re-derive the overlay status.
- The README Status section has already been rewritten (someone beat you to it) —
  report and stop.

## Maintenance notes

- The Status section is inherently drift-prone. When Game Capture lands on
  Windows, or the overlay Browser/Scrim panels ship, this section needs another
  pass.
- A reviewer should confirm the overlay sentence isn't an over-claim — the
  Browser/Scrim placeholders are the easy thing to accidentally imply as done.
- Consider (future, out of scope here) a short "Subsystems" table in the README
  with per-platform status columns, which would make this drift visible instead
  of buried in a sentence.

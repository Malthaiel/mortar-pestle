# Plan 014: Fix the Tauri listen() unlisten leak across event subscriptions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- web/src/overlays/OverlayStudioPanel.jsx modules/studio/broadcast/BroadcastPage.jsx modules/core/game-wiki/ScrimViewer.jsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `57a6c80`, 2026-07-03
- **Note**: `modules/core/game-wiki/ScrimViewer.jsx` is ALSO touched by plan
  `017-frontend-lifecycle-guards.md` (a different region — the `mountedRef`
  effect at line 325). If 017 landed first, re-run the drift check and confirm
  the ScrimViewer excerpts below still match before editing.

## Why this matters

Four `useEffect` hooks subscribe to Tauri events with a broken cleanup idiom:
`let un = null; listen('x', …).then(u => { un = u; }); return () => { if (un) un(); }`.
The unlisten function only exists after the `listen()` promise resolves. If the
effect cleans up *before* that (which StrictMode's dev double-mount forces on
**every** mount, and a sub-frame route flick can do in prod), `un` is still
`null`, the `if (un)` guard skips, and the subscription is **never torn down**.
The orphaned listener lives for the life of the webview and keeps firing against
whatever the leaked closure captured. Concrete costs: the Broadcast page's
leaked `broadcast://host-drop` + `onDragDropEvent` handlers mean one OS file-drop
spawns duplicate sources after any remount; the overlay-studio and scrim-viewer
panels accumulate duplicate `capture-state` / `stt-engine-status` /
`overlay-dictation-committed` handlers that double-fire their side effects.

The repo already uses the correct idiom in several places (store the *promise*,
await it in cleanup) — this plan makes the four leaky sites match it. No new
behavior, just correct teardown.

## Current state

### The correct idiom (already in the repo — match these)

`web/src/downloads/DownloadsProvider.jsx:177-190` — the array form. The
subscription **promises** go in an array; cleanup awaits each and calls the
resolved unlisten:

```js
  useEffect(() => {
    const subs = [
      listen('music-download-progress', (e) => { … }),
      // …six listeners…
    ];
    return () => subs.forEach(p => p.then(f => f()).catch(() => {}));
  }, [upsertLive, reloadHistory]);
```

`modules/studio/video-editor/ExportDialog.jsx:82-88` — the paired form:

```js
    const p1 = listen('vedit-export-progress', e => { if (!dead) setStatus(e.payload); });
    const p2 = listen('vedit-export-done', e => { if (!dead) setStatus(e.payload); });
    return () => {
      dead = true;
      p1.then(un => un());
      p2.then(un => un());
    };
```

`web/src/overlays/OverlayHostView.jsx:57-63` — the single-listener form:

```js
  useEffect(() => {
    getCurrentWindow().isVisible().then((v) => setVisible(!!v)).catch(() => {});
    const un = listen('overlay-host-visible', (e) => {
      if (typeof e?.payload === 'boolean') setVisible(e.payload);
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);
```

The common invariant: the `listen()` (or `onDragDropEvent()`) **promise** is
captured synchronously, so cleanup always has a handle to await — even when the
promise hasn't resolved yet.

### Leaky site 1 — `web/src/overlays/OverlayStudioPanel.jsx:151-160`

```js
  useEffect(() => {
    let un = null;
    invoke('get_capture_state').then((s) => { if (s && typeof s.recording === 'boolean') setRecordingVid(s.recording); }).catch(() => {});
    listen('capture-state', (e) => {
      const d = e.payload; if (!d) return;
      if (typeof d.state === 'string') { if (typeof d.recording === 'boolean') setRecordingVid(d.recording); }
      else if (d.code || d.message) { showToast('Save failed'); }
    }).then((u) => { un = u; }).catch(() => {});
    return () => { if (un) un(); };
  }, [showToast]);
```

The **very next effect in the same file** (`:162-170`) already uses the correct
array form — copy that shape:

```js
  useEffect(() => {
    refreshClips();
    refreshShots();
    const subs = [
      listen('capture-saved', () => { showToast('Clip saved ✓'); refreshClips(); }),
      listen('capture-screenshot-saved', () => { showToast('Screenshot saved'); refreshShots(); }),
    ];
    return () => subs.forEach((p) => p.then((un) => un()).catch(() => {}));
  }, [refreshClips, refreshShots, showToast]);
```

### Leaky site 2 — `modules/studio/broadcast/BroadcastPage.jsx:131-143`

Inside the `useEffect(() => { … }, [api])` that starts at `:95`. `handleDrop`
is defined at `:96` and reads `snapRef.current` (a ref — always fresh):

```js
    let un = null;
    let unHost = null;
    getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      handleDrop(event.payload.paths || [], event.payload.position);
    }).then((u) => { un = u; });
    // OLE drops dead-zone over the native region … relays drops as this event …
    listen('broadcast://host-drop', (e) => handleDrop(e.payload.paths || [], e.payload.position))
      .then((u) => { unHost = u; });
    return () => { if (un) un(); if (unHost) unHost(); };
```

`getCurrentWebviewWindow().onDragDropEvent(…)` returns a `Promise<UnlistenFn>`,
the **same shape** as `listen(…)`, so it slots into the same array form.

### Leaky site 3 — `modules/core/game-wiki/ScrimViewer.jsx:331-339` (STT probe)

```js
  useEffect(() => {
    let unlisten = null;
    const probe = () => invoke('stt_status')
      .then((s) => { if (mountedRef.current) setSttUp(s != null); })
      .catch(() => { if (mountedRef.current) setSttUp(false); });
    probe();
    listen('stt-engine-status', probe).then((un) => { unlisten = un; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);
```

Leave the `probe` body's `mountedRef.current` reads exactly as-is (that ref is
plan 017's concern, not this one). Only the subscribe/cleanup wiring changes.

### Leaky site 4 — `modules/core/game-wiki/ScrimViewer.jsx:793-799` (overlay events)

The array-of-resolved-unsubs variant — same root cause: `unsubs` is only
populated when the promises resolve, so a cleanup before resolution finds it
empty and the later-resolved unsubs are pushed into an orphaned array:

```js
  useEffect(() => {
    if (!overlay) return undefined;
    const unsubs = [];
    listen('overlay-dictation-committed', (e) => appendNoteToFocused(e.payload?.text)).then((u) => unsubs.push(u)).catch(() => {});
    listen('capture-screenshot-saved', (e) => setFocusedScoreboardIfEmpty(e.payload?.path)).then((u) => unsubs.push(u)).catch(() => {});
    return () => unsubs.forEach((u) => u && u());
  }, [overlay, appendNoteToFocused, setFocusedScoreboardIfEmpty]);
```

### Repo facts the executor needs

- React 18 + Vite 6, plain JS (no TypeScript, no `.ts`). Source split across
  `web/` and `modules/`; `vite build` (run from `web/`) bundles both via the
  `@host/` and `@modules/` path aliases.
- `StrictMode` is ON (`web/src/main.jsx` ~line 13) — effects mount, clean up,
  and re-mount on every dev mount. This is precisely what exposes the leak.
- `listen` is imported from `@tauri-apps/api/event`; it returns
  `Promise<UnlistenFn>`. `getCurrentWebviewWindow().onDragDropEvent` (from
  `@tauri-apps/api/webviewWindow`) has the same return contract.
- There is **no JS test framework**. Verification is: `vite build` (catches
  syntax/import breakage across `web/` + `modules/`), `grep` for the removed
  idiom, and manual observation in `npm run tauri dev`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build (syntax/import gate) | `npm --prefix web run build` | exit 0, `dist/` written, no error |
| Confirm idiom removed | `grep -rn "let un = null\|let unHost = null\|let unlisten = null\|unsubs.push" web/src/overlays/OverlayStudioPanel.jsx modules/studio/broadcast/BroadcastPage.jsx modules/core/game-wiki/ScrimViewer.jsx` | no matches |
| Dev run (manual checks) | `npm run tauri dev` (repo root) | Vite at `127.0.0.1:5173` + desktop window; no red console errors |

## Scope

**In scope** (the only files you modify):
- `web/src/overlays/OverlayStudioPanel.jsx` — leaky site 1
- `modules/studio/broadcast/BroadcastPage.jsx` — leaky site 2
- `modules/core/game-wiki/ScrimViewer.jsx` — leaky sites 3 & 4

**Out of scope** (do NOT touch):
- The three correct exemplars (`DownloadsProvider.jsx`, `ExportDialog.jsx`,
  `OverlayHostView.jsx`) — they are already correct; they are read-only references.
- The `probe` body's `mountedRef.current` reads in ScrimViewer (plan 017 owns
  the `mountedRef` correctness fix).
- The `handleDrop` body, drop-type mapping, or undo logic in `BroadcastPage.jsx`
  — only the subscribe/cleanup wiring changes.
- Any `listen()` site NOT in the four excerpts above. If you find another
  `let un = null` + `if (un) un()` elsewhere, note it in your report but do not
  fix it here (it is not in this plan's Current-state audit).

## Git workflow

- Branch: `advisor/014-listen-unlisten-leak`
- One commit for the whole plan is fine (one coherent fix); or one per file.
- Commit message style (match `git log`, plain imperative): e.g.
  `fix: await listen() promise in cleanup so unlisten never leaks`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix `OverlayStudioPanel.jsx:151-160`

Replace the `let un = null` effect with the array form used by the sibling
effect directly below it. Target shape:

```js
  useEffect(() => {
    const subs = [
      listen('capture-state', (e) => {
        const d = e.payload; if (!d) return;
        if (typeof d.state === 'string') { if (typeof d.recording === 'boolean') setRecordingVid(d.recording); }
        else if (d.code || d.message) { showToast('Save failed'); }
      }),
    ];
    invoke('get_capture_state').then((s) => { if (s && typeof s.recording === 'boolean') setRecordingVid(s.recording); }).catch(() => {});
    return () => subs.forEach((p) => p.then((un) => un()).catch(() => {}));
  }, [showToast]);
```

The `invoke('get_capture_state')` call is fire-and-forget — keep it, order
relative to the subscribe does not matter. Keep the `[showToast]` deps.

**Verify**: `grep -n "let un = null" web/src/overlays/OverlayStudioPanel.jsx` → no matches.

### Step 2: Fix `BroadcastPage.jsx:131-143`

Replace the two `let un`/`let unHost` handles with an array of the two
subscription promises. Target shape:

```js
    const subs = [
      getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        handleDrop(event.payload.paths || [], event.payload.position);
      }),
      // OLE drops dead-zone over the native region … relays drops as this event …
      listen('broadcast://host-drop', (e) => handleDrop(e.payload.paths || [], e.payload.position)),
    ];
    return () => subs.forEach((p) => p.then((f) => f()).catch(() => {}));
```

Preserve the explanatory comment (lines 137-140) somewhere sensible in the block.
Keep the `[api]` deps unchanged.

**Verify**: `grep -n "let un = null\|let unHost = null" modules/studio/broadcast/BroadcastPage.jsx` → no matches.

### Step 3: Fix `ScrimViewer.jsx:331-339` (STT probe)

Store the single subscription promise and await it in cleanup (single-listener
form, like `OverlayHostView.jsx:57-63`). Target shape:

```js
  useEffect(() => {
    const probe = () => invoke('stt_status')
      .then((s) => { if (mountedRef.current) setSttUp(s != null); })
      .catch(() => { if (mountedRef.current) setSttUp(false); });
    probe();
    const sub = listen('stt-engine-status', probe);
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, []);
```

`mountedRef.current` reads stay byte-for-byte identical. Keep the `[]` deps.

**Verify**: `grep -n "let unlisten = null" modules/core/game-wiki/ScrimViewer.jsx` → no matches.

### Step 4: Fix `ScrimViewer.jsx:793-799` (overlay events)

Store the two subscription promises in an array (do not push resolved
unsubscribers into a list). Target shape:

```js
  useEffect(() => {
    if (!overlay) return undefined;
    const subs = [
      listen('overlay-dictation-committed', (e) => appendNoteToFocused(e.payload?.text)),
      listen('capture-screenshot-saved', (e) => setFocusedScoreboardIfEmpty(e.payload?.path)),
    ];
    return () => subs.forEach((p) => p.then((u) => u()).catch(() => {}));
  }, [overlay, appendNoteToFocused, setFocusedScoreboardIfEmpty]);
```

Keep the deps array unchanged.

**Verify**: `grep -n "unsubs.push" modules/core/game-wiki/ScrimViewer.jsx` → no matches.

### Step 5: Build + boot

**Verify (build)**: `npm --prefix web run build` → exit 0, no errors.

**Verify (boot + surfaces, manual)**: `npm run tauri dev`, then exercise each
touched surface and confirm no duplicate-fire and no console errors:
- **Overlay Studio panel** (Voice/Video/Screenshots overlay) — opens; the Video
  section reflects capture state (no crash). Toggling record does not stack
  duplicate "Save failed"/state toasts.
- **Broadcast page** — drag one file onto the preview region; exactly **one**
  source is created (before this fix, a dev remount could make it two).
- **Scrim viewer** — open a Deadlock scrim `.md`; the "Extract Comms" button's
  enabled/disabled state tracks the STT engine (no console error from a dead
  listener). In overlay mode, a committed dictation appends **one** note.

Because there is no automated harness for these, record each observation in
your report as "observed: <result>". If a surface cannot be reached in your
environment, state which and why (do not guess).

## Test plan

No JS test framework exists in this repo (bespoke node checks only), and none of
the four sites has an existing check script. Verification is therefore:

1. `npm --prefix web run build` exits 0 (syntax/import integrity across
   `web/` + `modules/`).
2. The grep gate in "Commands you will need" returns zero matches.
3. The manual surface observations in Step 5.

Do **not** scaffold a new test framework for this — that is out of scope and
against repo convention.

## Done criteria

ALL must hold:

- [ ] `npm --prefix web run build` exits 0.
- [ ] `grep -rn "let un = null\|let unHost = null\|let unlisten = null\|unsubs.push" web/src/overlays/OverlayStudioPanel.jsx modules/studio/broadcast/BroadcastPage.jsx modules/core/game-wiki/ScrimViewer.jsx` returns no matches.
- [ ] Each of the four effects now captures the subscription **promise(s)** and
      awaits them in cleanup (`p.then(f => f())` / `subs.forEach(p => p.then(f => f()))`).
- [ ] No file outside the in-scope list is modified (`git status`).
- [ ] The Step 5 manual observations are recorded in the report.
- [ ] `plans/README.md` status row updated (unless a reviewer maintains it).

## STOP conditions

Stop and report (do not improvise) if:

- Any "Current state" excerpt does not match the live code (drift since `57a6c80`
  — likely plan 017 already edited ScrimViewer; re-verify the two ScrimViewer
  excerpts specifically).
- A site's cleanup turns out to depend on the unlisten handle being
  **synchronously** available for a reason unrelated to `listen()` (e.g. it is
  read elsewhere in the same effect before cleanup). None of the four audited
  sites do this today; if one now does, stop.
- `npm --prefix web run build` fails after a fix and a reasonable second attempt.
- A fix appears to require touching an out-of-scope file.

## Maintenance notes

- The correct idiom to reuse for any **new** Tauri subscription: capture the
  `listen()`/`onDragDropEvent()` promise (or an array of them) and, in the
  effect's cleanup, `promise.then(f => f())` — never `let un = null; …then(u => un = u)`.
  `DownloadsProvider.jsx:177-190` is the canonical exemplar.
- Reviewer should scrutinize that each rewritten cleanup still returns the same
  function shape React expects (a plain function, or `undefined` in the
  `if (!overlay) return undefined` early-return branch of site 4).
- `ScrimViewer.jsx` is also edited by plan `017` (the `mountedRef` effect). If
  both land, confirm no merge/textual overlap — they touch different lines
  (325 vs 331-339/793-799).
- Follow-up explicitly deferred: a repo-wide sweep for the same idiom outside
  these four sites. If the operator wants it, do it as a separate audit — this
  plan is scoped to the four verified sites only.

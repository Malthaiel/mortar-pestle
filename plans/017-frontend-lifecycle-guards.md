# Plan 017: Add drag-abort and fix the StrictMode mounted-guard in two frontend surfaces

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- web/src/components/DraggableSidebarList.jsx modules/core/game-wiki/ScrimViewer.jsx`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: bug

**Two independent findings** in two files (Step 1 = drag-abort, Step 2 = the
one-line mounted-guard). Do them as separate commits.

- **Planned at**: commit `57a6c80`, 2026-07-03
- **Note**: `modules/core/game-wiki/ScrimViewer.jsx` is ALSO touched by plan
  `014-listen-unlisten-leak.md` (different regions — the `listen()` effects at
  lines 331-339 and 793-799; this plan touches line 325). If 014 landed first,
  re-run the drift check and confirm the ScrimViewer excerpt below still matches.

## Why this matters

**A — DraggableSidebarList stuck drag.** Pickup attaches `window` `pointermove` +
`pointerup` listeners; `onUp` is the **only** path that removes them and clears
`dRef` / `dragState`. There is no `pointercancel`, `blur`, `Escape`, or
`visibilitychange` handler. So if `pointerup` never arrives — the user releases
the button **outside** the OS window, or the window loses focus mid-drag
(Alt-Tab, a focus-stealing dialog) — the drag never tears down: `dRef` stays
`'drag'`, the drag clone stays glued to the cursor, the source tile stays
`pointer-events: none`, and the window listeners leak. That is a hard "stuck
drag" the file's own drop-sequence invariants (header, `:6-20`) are written to
avoid. This plan adds an abort path.

**B — ScrimViewer dead mounted-guard under StrictMode.** `mountedRef` is set to
`true` at declaration but the effect that owns it only ever sets it **false** (in
cleanup) and never re-sets it `true`. Under StrictMode's dev double-mount, the
first mount's cleanup sets it `false`, and the second (kept) mount never flips it
back — so for the whole dev session `mountedRef.current` is `false`, silently
killing the STT-availability probe (`setSttUp`) and the save-state indicator
(`setSafeSaveState`). Dev-only, low severity, but a one-line correctness restore
that matches the repo's established `aliveRef` pattern.

## Current state

### Finding A — `web/src/components/DraggableSidebarList.jsx`

Header invariants (the drop is a multi-frame pipeline that assumes a clean
release), `:6-9`:

```js
// ── Drop-sequence invariants (the drop-flicker saga, 2026-07-01) ─────────────
// The drop is a multi-frame pipeline: clone glides to slot (glideMs) → commit
// (reorder + clone removal in one flushSync) → bridge (until the next real
// pointermove). Four invariants, each broken once before being written down:
```

`grep -n "pointercancel\|[^a-z]blur\|Escape\|visibilitychange" web/src/components/DraggableSidebarList.jsx`
returns **no** window-listener handler today — confirming the gap.

`clearHold`, `:375-377`:

```js
  const clearHold = useCallback(() => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
  }, []);
```

`cleanup` — the full synchronous teardown (note it does NOT remove the `window`
`onMove`/`onUp` listeners; those are removed inside `onUp`/`onMove`), `:415-424`:

```js
  const cleanup = useCallback(() => {
    clearHold();
    clearDropAccent();
    itemRefs.current.forEach(el => { if (el) el.style.pointerEvents = ''; });
    dRef.current = null;
    setDragState(null);
    onDragActiveChange?.(false);
  }, [clearHold, clearDropAccent, onDragActiveChange]);

  useEffect(() => cleanup, [cleanup]);
```

`onMove` — the dock hold-cancel branch removes the listeners + clears `dRef`
(no `dragState` exists yet in the `'hold'` phase), `:478-484`:

```js
        clearHold();
        if (dragFromInteractive) {
          // Dock: a move during the hold cancels …
          dRef.current = null;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        } else {
```

`onUp` head — the ONLY listener-removal + teardown path today, `:514-524`:

```js
  const onUp = useCallback((e) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const drag = dRef.current;
    if (!drag) return;
    clearHold();

    if (drag.phase === 'hold') {
      dRef.current = null;
      return;
    }
    // … drag.phase === 'drag' branch: two-phase 'releasing' glide, commits onReorder …
```

Important: during the drag-release **glide** (the `drag.phase === 'drag'` branch),
`onUp` sets `dRef.current = null` at `:579` *before* the `setTimeout(…, glideMs)`
that commits the reorder. So while the glide is in flight, `dRef.current` is
already `null`. The abort handler must **not** interfere with an in-flight glide —
guarding on `dRef.current` being truthy achieves exactly that.

Pickup — where the window listeners are attached, `:685-690`:

```js
    dRef.current = { phase: 'hold', idx, sx: e.clientX, sy: e.clientY };
    mouseRef.current = { x: e.clientX, y: e.clientY };
    holdTimerRef.current = setTimeout(() => beginDrag(idx, r, e.clientX, e.clientY), HOLD_MS);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { passive: false });
  }, [enabled, dragFromInteractive, beginDrag, onMove, onUp]);
```

Definition order in the file (the abort callback must be defined after the things
it references): `clearHold`(375) → `cleanup`(415) → `onMove`(471) → `onUp`(514) →
`beginDrag`(602) → `onItemDown`/pickup(663). `dRef` is `useRef(null)` at `:354`.

`DraggableSidebarList` is used by the right-sidebar music/planner widgets and by
the Overlay Studio panel's reorderable tiles (`web/src/overlays/OverlayStudioPanel.jsx`),
so it is exercisable from the running app's right sidebar.

### Finding B — `modules/core/game-wiki/ScrimViewer.jsx:324-326`

```js
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const setSafeSaveState = (s) => { if (mountedRef.current) setSaveState(s); };
```

Consumers of the guard: `setSafeSaveState` (`:326`, gates `setSaveState`) and the
STT probe (`:334-335`, gates `setSttUp`):

```js
    const probe = () => invoke('stt_status')
      .then((s) => { if (mountedRef.current) setSttUp(s != null); })
      .catch(() => { if (mountedRef.current) setSttUp(false); });
```

### The correct pattern (already in the repo — match it)

`web/src/hooks/useUpcomingWindow.js:22-27` sets the ref `true` at the **top** of
the effect, before returning the false-setter:

```js
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
```

`web/src/hooks/useDaySections.js:12-17` is identical. These survive StrictMode's
double-mount because the second mount's effect body re-arms the ref.

### Repo facts the executor needs

- React 18 + Vite 6, plain JS. `StrictMode` ON (`web/src/main.jsx` ~line 13) —
  this is exactly what exposes finding B.
- Drag in this app is pointer-events based, not HTML5 drag-and-drop. `dRef` /
  `dragState` / the `window` `pointermove`+`pointerup` listeners are the whole
  drag machine.
- There is a pure-math drag check: `npm --prefix web run check-drag` (runs
  `web/scripts/check-drag-math.mjs`). It validates `dragMath.js`
  (`computeSlotY` etc.), which this plan does **not** touch — so it must still
  pass (a regression guard that the abort change didn't disturb the drop math).
- No JS unit-test framework otherwise. Verify via `check-drag`, `vite build`,
  and manual observation under `npm run tauri dev`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drag math regression | `npm --prefix web run check-drag` | exit 0, all checks pass |
| Build (syntax/import gate) | `npm --prefix web run build` | exit 0, `dist/` written |
| Confirm abort handler added | `grep -n "pointercancel" web/src/components/DraggableSidebarList.jsx` | ≥1 match (add + removes) |
| Confirm mounted-guard fixed | `grep -n "mountedRef.current = true" modules/core/game-wiki/ScrimViewer.jsx` | 1 match |
| Dev run (manual checks) | `npm run tauri dev` (repo root) | Vite + desktop window; no console errors |

## Scope

**In scope**:
- `web/src/components/DraggableSidebarList.jsx` (Step 1)
- `modules/core/game-wiki/ScrimViewer.jsx` (Step 2 — line 325 only)

**Out of scope** (do NOT touch):
- `web/src/components/dragMath.js` and `web/scripts/check-drag-math.mjs` — the
  drop-index math is unchanged; only lifecycle/teardown changes.
- The `drag.phase === 'drag'` two-phase **glide** logic in `onUp` (`:524-598`) —
  do not alter the release animation. The abort is a *separate* immediate path.
- Adding `setPointerCapture` / rearchitecting the drag to route out-of-window
  releases — that is a larger change; the abort handler is the minimal fix.
- The `listen()` effects in ScrimViewer (`:331-339`, `:793-799`) — those are plan
  014's. This plan changes only the `mountedRef` effect at `:325`.

## Git workflow

- Branch: `advisor/017-frontend-lifecycle-guards`
- **Two commits**:
  - `fix: abort DraggableSidebarList drag on pointercancel/window blur`
  - `fix: re-arm ScrimViewer mountedRef at effect top (StrictMode)`
- Commit message style: plain imperative, matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (finding A): Add a drag-abort on `pointercancel` + window `blur`

Add one `onAbort` callback that runs the same teardown as a cancelled drag, and
wire it to `pointercancel` + `blur` **alongside** the existing `onMove`/`onUp`
window listeners.

1. **Define `onAbort`** after `beginDrag` and before the pickup (`onItemDown`),
   i.e. around `:660-662`. It must reference `onMove`, `onUp`, `cleanup` (all
   defined above it):

   ```js
   // Abort a drag/hold that will never see a pointerup: a release outside the OS
   // window, or a window blur mid-drag (Alt-Tab / focus-stealing dialog). Guarding
   // on dRef.current keeps this a no-op during the post-release glide (onUp nulls
   // dRef before the glide's setTimeout), so it respects the two-phase release.
   const onAbort = useCallback(() => {
     if (!dRef.current) return;
     window.removeEventListener('pointermove', onMove);
     window.removeEventListener('pointerup', onUp);
     window.removeEventListener('pointercancel', onAbort);
     window.removeEventListener('blur', onAbort);
     cleanup(); // clearHold + clearDropAccent + restore pointerEvents + dRef=null + setDragState(null) + onDragActiveChange(false)
   }, [onMove, onUp, cleanup]);
   ```

   `cleanup()` does the full snap-back: the clone unmounts, the source reappears
   at its **original** slot (no reorder committed — an abort commits nothing), and
   `pointer-events` is restored. That is the correct abort semantics.

2. **Register `onAbort`'s two events at pickup**, right after the existing
   `pointermove`/`pointerup` adds (`:688-689`):

   ```js
       window.addEventListener('pointermove', onMove, { passive: false });
       window.addEventListener('pointerup', onUp, { passive: false });
       window.addEventListener('pointercancel', onAbort);
       window.addEventListener('blur', onAbort);
   ```

   Add `onAbort` to the `onItemDown` dependency array (`:690`):
   `}, [enabled, dragFromInteractive, beginDrag, onMove, onUp, onAbort]);`

3. **Deregister `onAbort`'s two events everywhere `onMove`/`onUp` are removed** —
   there are two such sites besides `onAbort` itself:
   - `onUp` head (`:515-516`): add
     `window.removeEventListener('pointercancel', onAbort); window.removeEventListener('blur', onAbort);`
     after the two existing removes. `onUp` references `onAbort` (defined below it)
     via closure — this matches the file's existing "read at call time" convention
     for the `onMove`↔`onUp` mutual reference (see the comment at `:509-510`); do
     **not** add `onAbort` to `onUp`'s dependency array (leave `:599` deps as-is,
     mirroring how `onMove` is already handled).
   - `onMove` dock-cancel branch (`:483-484`): add the same two `removeEventListener`
     lines after the existing two.

   Rule of thumb for the executor: **wherever `onMove`/`onUp` are added or removed
   from `window`, `onAbort`'s `pointercancel`+`blur` go with them.**

Do not change the `'hold'`/`'drag'` branch logic, the glide, or `onReorder`.

**Verify (build)**: `npm --prefix web run build` → exit 0.

**Verify (drag math regression)**: `npm --prefix web run check-drag` → exit 0,
all checks pass (proves the drop-index math is untouched).

**Verify (grep)**: `grep -n "pointercancel" web/src/components/DraggableSidebarList.jsx`
→ at least the pickup add + the removes.

**Verify (abort works + tap/hold intact, manual)**: `npm run tauri dev`, then in
the right sidebar (music/planner widgets) or the Overlay Studio panel:
- **Blur abort**: start dragging a tile (hold + move), then Alt-Tab away and back.
  The tile is **not** stuck to the cursor — it snapped back to rest and is
  interactive again. No orphaned clone.
- **Release-outside-window abort**: start dragging a tile, drag the pointer
  outside the app window, and release the mouse button there. Return to the
  window — the tile is back at rest, interactive (no stuck drag).
- **Tap still navigates**: a quick click on a draggable item still fires its
  normal click/open (drag did not swallow the tap).
- **Hold still drags + reorders**: a normal hold-drag still reorders tiles and
  commits the new order.

Record each observation.

### Step 2 (finding B): Re-arm `mountedRef` at the effect top

Change `modules/core/game-wiki/ScrimViewer.jsx:325` from the cleanup-only form to
set the ref `true` at the top of the effect, matching `useUpcomingWindow.js:24-27`:

```js
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const setSafeSaveState = (s) => { if (mountedRef.current) setSaveState(s); };
```

(Only the middle line changes; leave `:324` and `:326` as-is.)

**Verify (build)**: `npm --prefix web run build` → exit 0.

**Verify (grep)**: `grep -n "mountedRef.current = true" modules/core/game-wiki/ScrimViewer.jsx`
→ exactly 1 match (the effect body).

**Verify (dev-only behavior restore, manual)**: `npm run tauri dev` → open a
Deadlock scrim `.md` in the game-wiki viewer. Confirm:
- The save-state tag ("Saving…"/"Saved") appears when you edit a field (proves
  `setSafeSaveState` is no longer dead).
- The "Extract Comms" button's enabled/disabled state reflects the STT engine
  (proves the `setSttUp` probe path runs).

Record the observation (note: this only *regresses* in dev/StrictMode, so the
value of the fix is that these work in the dev build).

## Test plan

No general JS test framework exists. Verification:
1. `npm --prefix web run check-drag` exits 0 (drag-math regression guard for Step 1).
2. `npm --prefix web run build` exits 0 (both steps).
3. The greps in "Commands you will need".
4. The manual observations in Steps 1 and 2.

Do not scaffold a new test framework. `check-drag-math.mjs` is the only relevant
existing check and must keep passing unchanged.

## Done criteria

ALL must hold:

- [ ] `npm --prefix web run check-drag` exits 0 (unchanged, still passing).
- [ ] `npm --prefix web run build` exits 0.
- [ ] `DraggableSidebarList` registers a `pointercancel` + window `blur` abort at
      pickup and removes them at every `onMove`/`onUp` teardown site; the abort
      guards on `dRef.current` and calls `cleanup()`.
- [ ] Manual: blur-mid-drag and release-outside-window both snap the tile back
      (no stuck drag); tap-vs-hold still works (recorded).
- [ ] `ScrimViewer.jsx` sets `mountedRef.current = true` at the top of its effect.
- [ ] Manual: scrim save-tag + Extract-Comms enablement work in the dev build (recorded).
- [ ] No file outside the in-scope list modified (`git status`).
- [ ] `plans/README.md` status row updated (unless a reviewer maintains it).

## STOP conditions

Stop and report (do not improvise) if:

- Either "Current state" excerpt does not match the live code (drift since
  `57a6c80` — likely plan 014 already edited ScrimViewer; re-verify the
  `mountedRef` excerpt specifically, and confirm the DraggableSidebarList line
  numbers still align).
- `npm --prefix web run check-drag` **fails** after Step 1 — the abort change
  disturbed something the drag-math check depends on (it should not; the math is
  out of scope). Revert Step 1 and report.
- After Step 1, a normal hold-drag no longer reorders, or a tap no longer
  navigates — the abort is firing on a legitimate drag/tap. Most likely the
  `blur` listener is firing spuriously or the `dRef.current` guard was dropped.
  Revert and report.
- The `mountedRef` at `:324` is already `useRef(true)` **and** the effect already
  sets it `true` at the top (finding B already fixed) — skip Step 2, note it.
- `npm --prefix web run build` fails after a fix and a reasonable second attempt.

## Maintenance notes

- **Finding A**: the abort deliberately does an **immediate** teardown (no glide,
  no reorder) — an abort is not a drop. If a future change wants an aborted drag
  to animate back to origin, that is a new feature, not this fix.
- If the drag model is ever migrated to `setPointerCapture` (which routes
  out-of-window pointerups back to the element), the `pointercancel` half of this
  abort becomes partly redundant — but the window `blur` half still matters
  (Alt-Tab does not produce a pointerup). Keep both.
- An optional extra the operator may request: an `Escape`-key abort. It is a
  one-liner in the same spirit — a `window` `keydown` handler
  `if (e.key === 'Escape') onAbort();` registered/removed alongside the other two.
  Left out here to keep the diff minimal (blur + pointercancel cover the reported
  stuck-drag cases). Do not add it unless asked.
- **Finding B**: any new `useRef(true)` "is-mounted" guard in this codebase must
  set the ref `true` at the effect top (StrictMode-safe) — `useUpcomingWindow.js`
  / `useDaySections.js` are the canonical exemplars. A ref that is only set
  `false` in cleanup is a latent dev-only bug.
- `ScrimViewer.jsx` is also edited by plan `014`. If both land, confirm no
  textual overlap — they touch different lines (325 vs 331-339/793-799).
- Reviewer should scrutinize: (A) that `onAbort`'s `pointercancel`+`blur` are
  removed at **all three** sites (pickup-teardown parity), and that the
  `dRef.current` guard is present so the post-release glide is untouched; (B)
  that only the one middle line of the `mountedRef` effect changed.

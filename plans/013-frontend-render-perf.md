# Plan 013: Stop per-frame React re-renders in the radial clock and memoize the settings object

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- modules/core/planner/watchfaces/DualRingRect.jsx web/src/hooks/useSettings.js`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf

These are **two independent findings** in two files. They share no code and can
be done/reviewed/reverted separately. Do Step 1 (finding A) and Step 2 (finding
B) as separate commits.

- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

**A — DualRingRect radial clock.** While the timer runs, a `requestAnimationFrame`
loop calls `setFrameTick(c => c + 1)` on **every frame** purely to advance a
ref-held sub-second value. Each of those ~60 renders/sec recomputes four SVG
rounded-rect arc paths, and each path walk does per-corner `atan2`/`cos`/`sin`
trig. That is a full React reconcile + four trig-heavy path builds every frame,
for an animation whose only changing input is a number already living in a ref.
It threatens the 60fps budget of the watchface (and burns battery on a mostly
idle screen).

**B — useSettings object identity.** `useSettings()` builds a brand-new `settings`
object on **every render** (`{ ...globalSettings, accentColor: … }`), so every
consumer that keys an effect on `settings` or passes it to a memoized child sees
a "changed" prop even when nothing relevant changed. Worse, the cross-instance
resync handler calls `setGlobalSettings(loadGlobalSettings())` unconditionally on
any settings write — including the echo of this instance's own write — replacing
`globalSettings` with an equal-but-fresh object and forcing a wasted re-render
across all ~13 consumers. Memoizing the returned object and bailing the resync on
a no-op write removes that churn.

## Current state

### Finding A — `modules/core/planner/watchfaces/DualRingRect.jsx`

Refs + the tick-state, `:29-32`:

```js
  const totalSec = Math.max(0, Math.round(remainingMins * 60));
  const totalSecRef = useRef(totalSec);
  const subSecRef = useRef(0);
  const lastFrameRef = useRef(performance.now());
  const [, setFrameTick] = useState(0);
```

The RAF loop, `:41-54` — note `setFrameTick((c) => c + 1)` on every frame:

```js
  useEffect(() => {
    if (!running) return;
    let raf;
    const tick = (t) => {
      const dt = (t - lastFrameRef.current) / 1000;
      lastFrameRef.current = t;
      subSecRef.current = Math.min(1, subSecRef.current + dt);
      setFrameTick((c) => c + 1);
      raf = requestAnimationFrame(tick);
    };
    lastFrameRef.current = performance.now();
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);
```

Fraction computation (render body), `:56-66` — reads `subSecRef.current`:

```js
  const isDragMode = dragMins != null;
  let outerFraction, innerFraction;
  if (isDragMode) {
    outerFraction = Math.min(1, dragMins / 60);
    innerFraction = 1;
  } else {
    const liveRemainingSec = Math.max(0, totalSec - subSecRef.current);
    outerFraction = Math.min(1, liveRemainingSec / 3600);
    const liveMinSec = liveRemainingSec % 60;
    innerFraction = liveMinSec === 0 && liveRemainingSec > 0 ? 1 : liveMinSec / 60;
  }
```

`roundedRectArcPath` is a pure function defined in the component body at `:73-145`
(the per-corner `Math.atan2` / `Math.cos` / `Math.sin` math is at `:134-139`). It
takes all inputs as arguments — no external closure state that changes per frame.

Path builds (render body), `:147-155`:

```js
  const outerX = outerInset, outerY = outerInset;
  const outerW = width - 2 * outerInset, outerH = height - 2 * outerInset;
  const innerX = innerInset, innerY = innerInset;
  const innerW = width - 2 * innerInset, innerH = height - 2 * innerInset;

  const outerBgPath = roundedRectArcPath(outerX, outerY, outerW, outerH, outerR, 1);
  const innerBgPath = roundedRectArcPath(innerX, innerY, innerW, innerH, innerR, 1);
  const outerArcPath = roundedRectArcPath(outerX, outerY, outerW, outerH, outerR, outerFraction);
  const innerArcPath = roundedRectArcPath(innerX, innerY, innerW, innerH, innerR, innerFraction);
```

The `<path>` elements that consume the two *arc* paths, `:232-256` (the two `*Bg`
paths are constant — fraction `1` — and never change per frame). Note each arc is
drawn **twice**: a blurred glow copy (conditional on the `glow` prop) and the
solid stroke, both bound to the same path string:

```jsx
      {/* Outer arc — session progress. Always glows. */}
      {outerArcPath && (
        <>
          {glow && (
            <path d={outerArcPath} stroke={strokeColor}
              strokeWidth={outerHaloW} fill="none" strokeLinecap="round"
              opacity="0.32" filter="url(#dualRectGlow)"/>
          )}
          <path d={outerArcPath} stroke={strokeColor}
            strokeWidth={outerStrokeW} fill="none" strokeLinecap="round"/>
        </>
      )}

      {/* Inner arc — current-minute progress. Always glows. */}
      {innerArcPath && (
        <>
          {glow && (
            <path d={innerArcPath} stroke={strokeColor}
              strokeWidth={innerHaloW} fill="none" strokeLinecap="round"
              opacity="0.30" filter="url(#dualRectGlow)"/>
          )}
          <path d={innerArcPath} stroke={strokeColor}
            strokeWidth={innerStrokeW} fill="none" strokeLinecap="round"/>
        </>
      )}
```

### Finding B — `web/src/hooks/useSettings.js`

The hook signature + state, `:688-695`:

```js
export function useSettings(pageKey = 'pulse') {
  const [globalSettings, setGlobalSettings] = useState(() => loadGlobalSettings());
  const [accent, setAccentState] = useState(() => resolveActiveAccent(globalSettings));
  // Transient hover-preview accent (ThemePicker). Non-persisted; overlays the
  // committed accent in the returned `settings` …
  const [previewAccent, setPreviewAccent] = useState(null);
```

The resync handler, `:707-718` — unconditional `setGlobalSettings(loadGlobalSettings())`:

```js
  useEffect(() => {
    const resync = e => {
      if (e?.type === 'storage' && e.key && e.key !== 'focus_settings') return;
      setGlobalSettings(loadGlobalSettings());
    };
    window.addEventListener(GLOBAL_SETTINGS_EVENT, resync);
    window.addEventListener('storage', resync);
    return () => {
      window.removeEventListener(GLOBAL_SETTINGS_EVENT, resync);
      window.removeEventListener('storage', resync);
    };
  }, []);
```

The fresh-object build + return, `:928-929`:

```js
  const settings = { ...globalSettings, accentColor: previewAccent ?? accent };
  return { settings, setSetting, setPreviewAccent, resetSettings, resolvedTheme };
```

Supporting facts for the resync bail (`:621-643`, `:655-662`): `loadGlobalSettings()`
does `JSON.parse(localStorage.getItem('focus_settings'))` and rebuilds a fully
fresh nested object (new refs for `animations`, `sounds`, `dev`, `dock`, `agents`,
`downloads`, `keybinds`, `stt`) on **every** call — so a plain shallow `===`
compare against the current object is always false. `persistGlobalSettings` writes
localStorage then `queueMicrotask(emitGlobalSettingsChange)`, so this instance's
own writes echo back through `resync`. `useMemo` is already imported at
`:1` (`import { useCallback, useEffect, useMemo, useState } from 'react';`).

### Repo facts the executor needs

- React 18 + Vite 6, plain JS. `StrictMode` ON (`web/src/main.jsx` ~line 13).
- No JS test framework. Verify via `npm --prefix web run build`, `grep`, and
  manual observation under `npm run tauri dev`.
- `useSettings` is imported by ~13 consumers (11 `.jsx` files call it directly —
  e.g. `web/src/App.jsx`, `modules/core/planner/PlannerProvider.jsx`,
  `modules/core/game-wiki/ScrimViewer.jsx` — plus prop-drilled `settings`
  further down). Its return shape must stay `{ settings, setSetting,
  setPreviewAccent, resetSettings, resolvedTheme }`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build (syntax/import gate) | `npm --prefix web run build` | exit 0, `dist/` written |
| Confirm setFrameTick gone | `grep -n "setFrameTick" modules/core/planner/watchfaces/DualRingRect.jsx` | no matches |
| Confirm memo added | `grep -n "useMemo" web/src/hooks/useSettings.js` | matches include the `settings` build |
| Dev run (manual checks) | `npm run tauri dev` (repo root) | Vite + desktop window; no console errors |

## Scope

**In scope**:
- `modules/core/planner/watchfaces/DualRingRect.jsx` (Step 1)
- `web/src/hooks/useSettings.js` (Step 2)

**Out of scope** (do NOT touch):
- `modules/core/planner/watchfaces/DualRing.jsx` (the circular sibling) — not
  audited here; leave it.
- The **context + selector split** of `useSettings` (giving each consumer a
  narrow slice so an accent hover doesn't re-render the whole tree). That is the
  larger, higher-risk win and is deliberately deferred — this plan does the
  memo + resync-bail (the S/MED win) only. Do NOT introduce a settings context.
- The hover-preview re-render storm itself: `setPreviewAccent` genuinely changes
  `settings.accentColor`, so accent consumers *should* re-render on hover. The
  memo does not (and must not) suppress that. Do not try to "fix" hover here.
- `roundedRectArcPath`'s math — it must stay byte-for-byte identical (this is a
  perf change, not a behavior change).

## Git workflow

- Branch: `advisor/013-frontend-render-perf`
- **Two commits** — one per finding (they are independent):
  - `perf: drive DualRingRect arcs via ref/DOM writes instead of per-frame render`
  - `perf: memoize useSettings return object + bail resync on no-op write`
- Commit message style: plain imperative, matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (finding A): Drive the arcs by direct DOM writes, drop `setFrameTick`

Goal: keep the RAF loop, but instead of forcing a React render each frame, write
the recomputed arc path strings straight onto the `<path>` DOM nodes. The
animation math must stay identical; only the *write path* moves from React state
to refs/DOM.

1. **Remove the per-frame render trigger.** Delete `const [, setFrameTick] = useState(0);`
   (`:32`) and the `setFrameTick((c) => c + 1);` line inside `tick` (`:48`).

2. **Add four element refs** (one per animated `<path>`: outer glow, outer solid,
   inner glow, inner solid), near the other refs:

   ```js
   const outerGlowEl = useRef(null);
   const outerArcEl = useRef(null);
   const innerGlowEl = useRef(null);
   const innerArcEl = useRef(null);
   ```

3. **Add a "latest draw" closure stored in a ref**, reassigned on every render so
   it always sees the current geometry, `dragMins`, `totalSec`, and the current
   `roundedRectArcPath`. Place it in the render body *after* the geometry consts
   (`:147-150`) and the `roundedRectArcPath` definition:

   ```js
   const drawRef = useRef(() => {});
   drawRef.current = () => {
     let oF, iF;
     if (isDragMode) { oF = Math.min(1, dragMins / 60); iF = 1; }
     else {
       const liveRemainingSec = Math.max(0, totalSec - subSecRef.current);
       oF = Math.min(1, liveRemainingSec / 3600);
       const liveMinSec = liveRemainingSec % 60;
       iF = liveMinSec === 0 && liveRemainingSec > 0 ? 1 : liveMinSec / 60;
     }
     const oPath = roundedRectArcPath(outerX, outerY, outerW, outerH, outerR, oF);
     const iPath = roundedRectArcPath(innerX, innerY, innerW, innerH, innerR, iF);
     outerGlowEl.current?.setAttribute('d', oPath);
     outerArcEl.current?.setAttribute('d', oPath);
     innerGlowEl.current?.setAttribute('d', iPath);
     innerArcEl.current?.setAttribute('d', iPath);
   };
   ```

   The fraction math is copied **verbatim** from the render body `:56-66` — keep
   it identical.

4. **Call `drawRef.current()` in the tick** where `setFrameTick` was:

   ```js
   const tick = (t) => {
     const dt = (t - lastFrameRef.current) / 1000;
     lastFrameRef.current = t;
     subSecRef.current = Math.min(1, subSecRef.current + dt);
     drawRef.current();
     raf = requestAnimationFrame(tick);
   };
   ```

5. **Attach the refs** to the four animated `<path>` elements (`:232-256`), e.g.
   `<path ref={outerGlowEl} d={outerArcPath} … />`, `<path ref={outerArcEl} d={outerArcPath} … />`,
   and the inner pair likewise. **Keep** the `d={outerArcPath}` / `d={innerArcPath}`
   render-time bindings — they paint the correct first frame and the correct
   static frame when `running` is false (no RAF then). The RAF only *mutates* `d`
   during a run.

Leave the two background paths (`outerBgPath`, `innerBgPath`) and everything else
untouched. The conditional wrappers `{outerArcPath && (…)}` / `{innerArcPath && (…)}`
stay — the `?.setAttribute` guards handle the rare frame where a wrapper is
absent (arc fraction is 0 only at full depletion, when the timer isn't animating).

**Verify (build)**: `npm --prefix web run build` → exit 0.

**Verify (no per-frame render)**: `grep -n "setFrameTick" modules/core/planner/watchfaces/DualRingRect.jsx` → no matches.

**Verify (smooth animation, manual)**: `npm run tauri dev` → open the Focus Timer
/ planner watchface that renders `DualRingRect` (the compact rectangular dial),
start a timer, and confirm the arcs deplete **smoothly** (no stutter, no frozen
arc). If the app exposes DevTools, open React DevTools → Profiler / "Highlight
updates when components render" and confirm `DualRingRect` is **not** flashing
every frame while the timer runs (it should re-render only ~once/second when
`remainingMins` changes, not ~60×/sec). Record the observation.

### Step 2 (finding B): Memoize `settings` + bail the resync on a no-op write

1. **Mirror `globalSettings` into a ref** so the resync effect (deps `[]`) can
   compare against the current value without re-subscribing. Add right after the
   state declarations (near `:695`):

   ```js
   const globalRef = useRef(globalSettings);
   globalRef.current = globalSettings;
   ```

   (`useRef` is already imported — confirm the import line at `:1` includes it;
   if not, add it.)

2. **Bail the resync when the reloaded blob equals the current one.** Change
   `:707-718` so it does not call `setGlobalSettings` on a no-op:

   ```js
   useEffect(() => {
     const resync = e => {
       if (e?.type === 'storage' && e.key && e.key !== 'focus_settings') return;
       const next = loadGlobalSettings();
       // A local setSetting write echoes back through this same handler; skip the
       // no-op re-render (loadGlobalSettings() always returns a fresh object).
       // ponytail: JSON compare — cheap + correct on nested refs; only fires on
       // user-driven settings writes, never per-frame. Deep-equal if key-order
       // ever proves unstable.
       if (JSON.stringify(next) === JSON.stringify(globalRef.current)) return;
       setGlobalSettings(next);
     };
     window.addEventListener(GLOBAL_SETTINGS_EVENT, resync);
     window.addEventListener('storage', resync);
     return () => {
       window.removeEventListener(GLOBAL_SETTINGS_EVENT, resync);
       window.removeEventListener('storage', resync);
     };
   }, []);
   ```

3. **Memoize the returned `settings` object** at `:928`:

   ```js
   const settings = useMemo(
     () => ({ ...globalSettings, accentColor: previewAccent ?? accent }),
     [globalSettings, previewAccent, accent],
   );
   return { settings, setSetting, setPreviewAccent, resetSettings, resolvedTheme };
   ```

Do not change the return shape or the order of keys.

**Verify (build)**: `npm --prefix web run build` → exit 0.

**Verify (grep)**: `grep -n "useMemo" web/src/hooks/useSettings.js` → shows the
`settings` memo; `grep -n "JSON.stringify(next)" web/src/hooks/useSettings.js` →
shows the resync bail.

**Verify (behavior unchanged, manual)**: `npm run tauri dev` →
- Change a setting (e.g. toggle an animation, pick a theme accent) — it still
  applies live across the app (Planner times, accent, etc.). No stale UI.
- Open the ThemePicker and hover accents — the live accent preview still follows
  the hover (this path is intentionally *not* suppressed).
- With React DevTools "Highlight updates" on (if available), toggle one unrelated
  setting and confirm consumers that don't read the changed value no longer
  flash purely from the `settings` object churning. Record the observation.

## Test plan

No JS test framework exists (bespoke node checks only); neither file has a check
script. Verification is: `npm --prefix web run build` exits 0, the greps above,
and the manual observations in Steps 1 and 2. Do not scaffold a test framework.

## Done criteria

ALL must hold:

- [ ] `npm --prefix web run build` exits 0.
- [ ] `grep -n "setFrameTick" modules/core/planner/watchfaces/DualRingRect.jsx` → no matches.
- [ ] `DualRingRect` re-renders ~once/sec (not per frame) while the timer runs, and the arcs still animate smoothly (manual, recorded).
- [ ] `useSettings` returns a `useMemo`'d `settings` object keyed on `[globalSettings, previewAccent, accent]`, and the resync effect bails on a no-op reload.
- [ ] Settings changes still apply live; accent hover-preview still works (manual, recorded).
- [ ] No file outside the in-scope list modified (`git status`).
- [ ] `plans/README.md` status row updated (unless a reviewer maintains it).

## STOP conditions

Stop and report (do not improvise) if:

- **`DualRingRect.jsx` no longer uses `setFrameTick`** in the live code (finding A
  already fixed) — skip Step 1, note it.
- **`useSettings.js:928` no longer builds a fresh `{ ...globalSettings, … }` object**
  (e.g. it is already memoized, or the hook was refactored to a context) — skip
  Step 2, note it.
- Any "Current state" excerpt does not match the live code (drift since `57a6c80`).
- After Step 1, the arcs visibly **freeze**, lag, or animate differently than
  before (the DOM-write math diverged from the render math) — revert Step 1 and
  report; the two fraction computations must be identical.
- After Step 2, any setting stops applying live, or the accent hover-preview
  stops working — the resync bail is too aggressive; revert Step 2 and report.
- `npm --prefix web run build` fails after a fix and a reasonable second attempt.

## Maintenance notes

- **Finding A**: the direct-DOM-write is React's standard escape hatch for
  per-frame SVG animation. If `DualRingRect` ever gains a new animated `<path>`,
  it needs its own ref + a `setAttribute('d', …)` line in `drawRef.current`.
  If `width`/`height` become animated (not just static props), revisit — the
  `drawRef` closure captures current geometry per render, so it is safe as long
  as a geometry change triggers a render (it does, via prop change).
- **Finding B**: the JSON-string compare in the resync assumes `loadGlobalSettings()`
  and a `setSetting`-built `globalSettings` serialize with the same key order
  (they do today — `setSetting` spreads `prev` first). If a future edit reorders
  keys, the compare yields a false-negative (one extra render, never a dropped
  update) — upgrade to a deep-equal only if that shows up in profiling.
- The real fix for the accent-hover re-render storm is a settings **context +
  selector split** so consumers subscribe to only the slice they read. That is
  intentionally out of this plan (bigger, MED→HIGH risk). A reviewer green-lighting
  a follow-up should scope it separately.
- Reviewer should scrutinize: (A) that the arc fraction math in `drawRef` is a
  verbatim copy of the render-body branch, and (B) that the memo deps list is
  exactly `[globalSettings, previewAccent, accent]` (missing one would stale the
  returned object).

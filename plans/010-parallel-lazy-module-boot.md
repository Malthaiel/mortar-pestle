# Plan 010: Parallelize module chunk loading and lazy-load the heavy module routes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- web/src/module-loader.js web/src/main.jsx modules/core/game-wiki/index.jsx modules/core/terminal/index.jsx`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

The first React render is gated on `loadAll()` completing (main.jsx:10). Two
things make `loadAll` slow, and both sit on the cold-start critical path
(documented budget: module loader scan+register+mount < 100 ms for 10 modules):

1. **Sequential chunk waterfall.** `module-loader.js` awaits each module's
   dynamic `import()` one at a time in a `for` loop, so N modules cost N
   serial network/disk round-trips instead of one parallel batch.
2. **Heavy deps dragged onto boot.** Each module's `index.jsx` is fetched at
   boot (to call `register()`), and the game-wiki + terminal index files
   **statically** import their page components, which pull in `react-markdown`
   + `remark-gfm` (~100 KB+) and `@xterm/xterm` + addon (~200 KB) — even when
   the user never opens those routes. The correct lazy pattern already exists
   in the codebase (`GraphPage.jsx` keeps `pixi.js` off boot via `React.lazy`).

This plan parallelizes the chunk fetch (keeping `register()` strictly ordered)
and lazy-splits the two heavy route components, so `xterm`/`react-markdown`
leave the boot path and load only when their routes are visited.

## Current state

### `web/src/main.jsx` (lines 1–16, verbatim) — first paint waits on `loadAll`

```jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { loadAll } from './module-loader.js';
import { initSmoothWheel } from './util/smoothWheel.js';
import './pages/docs/register.jsx';   // side effect: registerPageSidebar('docs', …)
import './fonts.css';
import './styles.css';

loadAll().then(() => {
  initSmoothWheel();
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
```

### `web/src/module-loader.js` — the sequential loop (lines 128–154, verbatim)

```js
  const sorted = toposort(filtered.map(p => p.manifest));
  const byId   = new Map(filtered.map(p => [p.manifest.id, p]));

  const summary = [];
  const loadedManifests = {};
  for (const manifest of sorted) {
    const { path } = byId.get(manifest.id);
    const entryKey = entryKeyFor(path, manifest.entry);
    const loader = entryModules[entryKey];
    if (!loader) {
      throw new Error(
        `[${manifest.id}] entry file not found at "${entryKey}"; available: ${Object.keys(entryModules).join(', ') || '(none)'}`
      );
    }
    const mod = await loader();
    const entry = mod.default || mod;
    if (typeof entry?.register !== 'function') {
      throw new Error(`[${manifest.id}] module entry must default-export { register(api) }`);
    }
    entry.register(createApi(manifest.id));
    summary.push(manifest.id);
    loadedManifests[manifest.id] = manifest;
  }

  setManifests(loadedManifests);
  console.info(`[module-loader] registered: ${summary.join(', ') || '(none)'}`);
}
```

`entryModules` is built from **non-eager** `import.meta.glob('.../index.jsx')`
(module-loader.js:87–93), so each module's `index.jsx` is already its own async
chunk; the `await loader()` in the loop is what fetches it. `toposort`
(module-loader.js:49–73) orders modules by their `requires` deps — **no
manifest in the repo declares `requires`** (verified: `grep -rn '"requires"'
modules/*/*/manifest.json` returns nothing), so today the toposort order equals
glob order and register order is not yet load-bearing across modules. It must
stay ordered anyway (future-proof + within-run slot/provider order).

### `modules/core/game-wiki/index.jsx` (lines 7–10, 41–48, verbatim) — static heavy import

```jsx
import GameWikiTree from './GameWikiTree.jsx';
import GameWikiPage from './GameWikiPage.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import './game-wiki.css';
```
```jsx
    api.slots.registerRoute({
      match: matchGameWiki,
      render: ({ params, accent }) => (
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <GameWikiPage rest={params.rest} accent={accent}/>
        </div>
      ),
    });
```

`GameWikiPage.jsx:12–13` is the heavy import:
```jsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
```
`GameWikiTree` (the secondary-sidebar tree) is light — keep it eager.

### `modules/core/terminal/index.jsx` (lines 10–17, 46–62, verbatim) — static heavy import

```jsx
import { TerminalProvider } from './TerminalProvider.jsx';
import { SkillsProvider } from './SkillsProvider.jsx';
import { bindSkillsApi } from './api.js';
import TerminalSidebar from './TerminalSidebar.jsx';
import TerminalRouter from './TerminalRouter.jsx';
import SettingsTab from './SettingsTab.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import './terminal.css';
```
```jsx
    api.slots.registerRoute({
      // ...
      render: ({ params, accent }) => (
        <TerminalRouter rest={params.rest} legacy={params.legacy} accent={accent} />
      ),
    });
```

`TerminalRouter.jsx:7` imports `TerminalPage` → `Terminal.jsx:14–16` imports
`@xterm/xterm` + `@xterm/addon-fit` + xterm CSS; `SkillsPage` →
`SkillOutput.jsx:20–22` also imports xterm. **All xterm imports are reached
only through `TerminalRouter`** — verified: `grep -rn '@xterm' modules/core/
terminal` matches only `Terminal.jsx` and `SkillOutput.jsx` (all other hits are
comments/CSS). `TerminalProvider`, `SkillsProvider`, `api.js`,
`TerminalSidebar`, `SettingsTab` (the eager index imports) do **not** import
xterm — so lazy-splitting `TerminalRouter` fully removes xterm from boot.

### The exemplar to mirror — `web/src/pages/GraphPage.jsx` (lines 6, 22–47, verbatim)

```jsx
import { Component, lazy, Suspense, useMemo, useRef, useState } from 'react';
```
```jsx
// GraphCanvas pulls in pixi.js (a large WebGL dep); lazy-split so it only loads
// on first /graph visit, keeping it off the app's initial bundle. The error
// boundary keeps a failed chunk from unmounting the whole app tree.
const GraphCanvas = lazy(() => import('../components/GraphCanvas.jsx'));

class CanvasBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.error('[graph] canvas failed', err); }
  render() {
    if (this.state.failed) {
      return <div style={{ /* … */ }}>The graph renderer failed to load.</div>;
    }
    return this.props.children;
  }
}

function GraphCanvasLazy(props) {
  return (
    <CanvasBoundary>
      <Suspense fallback={<div /* … */><LoadingState label="Rendering…"/></div>}>
        <GraphCanvas {...props} />
      </Suspense>
    </CanvasBoundary>
  );
}
```

## Commands you will need

| Purpose        | Command                          | Expected on success                          |
|----------------|----------------------------------|----------------------------------------------|
| Build frontend | `npm --prefix web run build`     | exit 0; Vite prints the chunk list           |
| Dev run        | `npm run tauri dev` (repo root)  | window opens; DevTools available             |
| Dev (web only) | `npm --prefix web run dev`       | Vite at 127.0.0.1:5173                        |

`npm --prefix web run build` runs `vite build` (web/package.json:8); output goes
to `web/dist/`. Vite HMR covers these `.jsx` edits — no Rust rebuild needed.

## Scope

**In scope** (the only files you should modify):
- `web/src/module-loader.js` — parallelize the fetch; keep register ordered.
- `modules/core/game-wiki/index.jsx` — lazy-split `GameWikiPage`.
- `modules/core/terminal/index.jsx` — lazy-split `TerminalRouter`.

**Out of scope** (do NOT touch):
- `web/src/main.jsx` — the `loadAll().then(render)` gate stays; this plan makes
  `loadAll` faster, it does not change what gates first paint.
- `GameWikiPage.jsx`, `TerminalRouter.jsx`, `TerminalPage.jsx`, `Terminal.jsx`,
  `SkillOutput.jsx` — their internals are unchanged; only how the **index**
  imports them changes.
- `toposort`, `validateManifest`, the tier/platform gates in module-loader.js —
  leave the ordering + filtering logic exactly as is.
- `vite.config.*` / `manualChunks` — do not add manual chunk config; `React.lazy`
  dynamic imports are enough for the split.

## Git workflow

- Branch: `advisor/010-parallel-lazy-module-boot`.
- Conventional Commits (from `git log`). Use
  `perf(module-loader): parallel chunk fetch + lazy heavy routes`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Parallelize the chunk fetch, keep `register()` ordered

In `module-loader.js`, replace the sequential `for` loop (lines 131–150, the
block from `const summary = [];` through the loop's closing `}`, immediately
before `setManifests(loadedManifests);`) with a resolve → parallel-fetch →
ordered-register shape:

```js
  // Resolve every entry loader up-front (throws if any is missing) — pure map
  // lookups, no I/O yet, preserving toposort order.
  const jobs = sorted.map((manifest) => {
    const { path } = byId.get(manifest.id);
    const entryKey = entryKeyFor(path, manifest.entry);
    const loader = entryModules[entryKey];
    if (!loader) {
      throw new Error(
        `[${manifest.id}] entry file not found at "${entryKey}"; available: ${Object.keys(entryModules).join(', ') || '(none)'}`
      );
    }
    return { manifest, loader };
  });

  // Fetch all module chunks in parallel — was a sequential await-per-module
  // waterfall. Order-preserving: mods[i] corresponds to jobs[i].
  const mods = await Promise.all(jobs.map((j) => j.loader()));

  // Register SEQUENTIALLY in toposort order — registration order is
  // load-bearing (provider/slot ordering); only the fetch above is parallel.
  const summary = [];
  const loadedManifests = {};
  jobs.forEach(({ manifest }, i) => {
    const entry = mods[i].default || mods[i];
    if (typeof entry?.register !== 'function') {
      throw new Error(`[${manifest.id}] module entry must default-export { register(api) }`);
    }
    entry.register(createApi(manifest.id));
    summary.push(manifest.id);
    loadedManifests[manifest.id] = manifest;
  });
```

Leave `setManifests(loadedManifests);` + the `console.info` line that follow
untouched.

**Verify**:
- `npm --prefix web run build` → exit 0.
- `npm run tauri dev`, open DevTools console → the
  `[module-loader] registered: …` line lists the **same module ids in the same
  order** as before the change (register order preserved).

### Step 2: Lazy-split the Game Wiki page

In `modules/core/game-wiki/index.jsx`:

1. Change the top imports — drop the static `GameWikiPage` import, add `lazy` +
   `Suspense`:
   ```jsx
   import { lazy, Suspense } from 'react';
   import GameWikiTree from './GameWikiTree.jsx';
   import SidebarPill from '@host/components/SidebarPill.jsx';
   import './game-wiki.css';

   // react-markdown (+ remark-gfm, ~100KB) is only needed once a page is
   // actually viewed — lazy-split it off the boot chunk (mirrors
   // web/src/pages/GraphPage.jsx's pixi.js split).
   const GameWikiPage = lazy(() => import('./GameWikiPage.jsx'));
   ```
2. Wrap the route render in `<Suspense>`:
   ```jsx
   render: ({ params, accent }) => (
     <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
       <Suspense fallback={null}>
         <GameWikiPage rest={params.rest} accent={accent}/>
       </Suspense>
     </div>
   ),
   ```

`GameWikiTree` stays eagerly imported (light; renders in the secondary sidebar).
`fallback={null}` is acceptable — the chunk loads in a blink locally; use a
light placeholder only if you observe a flash.

**Verify**: `npm --prefix web run build` → exit 0. See Step 4 for the split
confirmation.

### Step 3: Lazy-split the Terminal route

In `modules/core/terminal/index.jsx`:

1. Change the top imports — drop the static `TerminalRouter` import, add `lazy`
   + `Suspense`; keep every other import (providers, `bindSkillsApi`,
   `TerminalSidebar`, `SettingsTab`, `SidebarPill`, css) as is:
   ```jsx
   import { lazy, Suspense } from 'react';
   import { TerminalProvider } from './TerminalProvider.jsx';
   import { SkillsProvider } from './SkillsProvider.jsx';
   import { bindSkillsApi } from './api.js';
   import TerminalSidebar from './TerminalSidebar.jsx';
   import SettingsTab from './SettingsTab.jsx';
   import SidebarPill from '@host/components/SidebarPill.jsx';
   import './terminal.css';

   // TerminalRouter pulls @xterm/xterm (+addon, ~200KB) via TerminalPage /
   // SkillsPage — only needed on the /tools/terminal route. Lazy-split it off
   // boot (mirrors web/src/pages/GraphPage.jsx). The providers + sidebar +
   // settings tab above register at boot and carry no xterm.
   const TerminalRouter = lazy(() => import('./TerminalRouter.jsx'));
   ```
2. Wrap the route render in `<Suspense>`:
   ```jsx
   render: ({ params, accent }) => (
     <Suspense fallback={null}>
       <TerminalRouter rest={params.rest} legacy={params.legacy} accent={accent} />
     </Suspense>
   ),
   ```

**Verify**: `npm --prefix web run build` → exit 0.

### Step 4: Confirm the heavy deps left the boot path

1. **Static self-check** (proves nothing eager pulls xterm/react-markdown):
   - `grep -rn '@xterm' modules/core/terminal` → matches ONLY `Terminal.jsx`,
     `SkillOutput.jsx`, comments, and `terminal.css` — never `index.jsx`,
     `TerminalProvider.jsx`, `TerminalSidebar.jsx`, or `SettingsTab.jsx`.
   - `grep -rn 'react-markdown\|remark-gfm' modules/core/game-wiki` → matches
     ONLY `GameWikiPage.jsx` — never `index.jsx` or `GameWikiTree.jsx`.
2. **Build chunk check**: run `npm --prefix web run build` and read the printed
   chunk list. **Expected**: two additional async chunks now exist for the
   lazily-imported `GameWikiPage` and `TerminalRouter`; the `xterm`/
   `react-markdown` code lives in those (or their child) chunks, and the
   game-wiki/terminal `index` chunks are smaller than before. (Optional
   baseline: `git stash`, build, note the chunk list, `git stash pop`, rebuild,
   diff.)
3. **Runtime proof (definitive)**: `npm run tauri dev`, open DevTools →
   **Network** tab, hard-reload. **Expected**: no `xterm`/`react-markdown`
   chunk is requested during boot. Click the **Terminal** dock button → an
   xterm chunk loads then. Click **Game Wiki** and open a page → a
   react-markdown chunk loads then.
4. **Loader-latency proof** (perf budget): temporarily wrap the loader body —
   in `module-loader.js`, add `console.time('loadAll')` as the first line inside
   `export async function loadAll()` and `console.timeEnd('loadAll')` right
   before `setManifests(...)`. `npm run tauri dev`, read the console.
   **Expected**: `loadAll` completes well under the 100 ms budget, and lower
   than a pre-change measurement (parallel fetch replaced the serial waterfall).
   **Remove the two temporary `console.time*` lines before finishing.**

## Test plan

There is no JS unit-test harness for the module loader (web/package.json
scripts are `dev`/`build`/`preview` + theme/drag checks; no `test`). Verification
is the build + the runtime Network/console checks in Step 4. Specifically
confirm:

- **Happy path**: all modules still register (the `[module-loader] registered:`
  console line is unchanged in membership and order).
- **The fix**: xterm + react-markdown are absent from the boot Network waterfall
  and appear only on route visit (Step 4.3).
- **No regression**: every dock button still opens its route; the Terminal
  actually runs a shell; a Game Wiki page renders markdown.

## Done criteria

ALL must hold:

- [ ] `npm --prefix web run build` exits 0.
- [ ] `module-loader.js` fetches chunks via `Promise.all` and registers via an
      ordered second pass (no `await` inside a per-module loop).
- [ ] `game-wiki/index.jsx` and `terminal/index.jsx` import their page/router
      via `React.lazy` wrapped in `<Suspense>`.
- [ ] Step 4 grep self-checks pass (no eager file imports xterm/react-markdown).
- [ ] Runtime: xterm + react-markdown load on route visit, not at boot.
- [ ] `[module-loader] registered:` lists the same ids in the same order as
      before.
- [ ] No temporary `console.time*` lines remain; `git status` shows only the
      three in-scope files modified.
- [ ] `plans/README.md` status row updated (if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- The code at the cited locations doesn't match the "Current state" excerpts
  (drift since 57a6c80).
- Any module manifest now declares a non-empty `requires` array
  (`grep -rn '"requires"' modules/*/*/manifest.json` is non-empty) AND that
  creates a cross-module ordering dependency — the parallel **fetch** is still
  safe, but confirm `register()` still runs strictly in `sorted` (toposort)
  order; if a module's top-level `index.jsx` code depends on another module
  having already `register()`ed (not just imported), Promise.all's concurrent
  top-level evaluation could break it — report before shipping.
- After the split, a dock button's route renders blank and the Network tab shows
  its lazy chunk **failing** to load (a `Suspense fallback={null}` masks a load
  error) — add an error boundary mirroring `GraphPage.jsx`'s `CanvasBoundary`
  and report.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The parallel fetch assumes module `index.jsx` files have no cross-module
  top-level side-effect coupling (each just imports its own components and
  exports `{ register }`). If a future module's top-level code reads a global
  another module's `register()` sets, revert that module to the ordered path or
  move the coupling into `register()`.
- If a new module adds a heavy, route-only dependency, apply the same
  `React.lazy` split at its `registerRoute` render site — do not let it import
  the heavy dep from `index.jsx`.
- Reviewer scrutiny: confirm register **order** is preserved (Step 1's
  `jobs.forEach`), and that no `Suspense` boundary lacks an error boundary where
  a chunk-load failure would blank a route.
- Deferred: manual `manualChunks` vendor-splitting in `vite.config` is not done
  — `React.lazy` already isolates the two heavy deps; add manual chunks only if
  profiling shows shared-vendor duplication across the new chunks.

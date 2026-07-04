# Plan 007: Delete the dead endpoint adapter and redirect machinery from the module SDK

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- modules/core/library/music/api.js web/src/module-sdk/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

The module SDK carries two chunks of machinery that serve nobody. The
`endpoint-adapter.js` HTTP-route→Tauri-command translator (13 route mappings)
exists to serve exactly **one** live caller, and that one caller invokes a
command (`reveal_in_files`) that is already invoked directly everywhere else in
the app — so the adapter is a redundant path for a single call. The router
`registerRedirect` mechanism has **zero** consumers: a module can register a
redirect and nothing ever reads it (the code that would read it, `MainApp`,
does not exist; a module even documents this in a comment). Both are dead
weight in the SDK's public surface that a reader has to understand and rule out.
Deleting them shrinks the SDK to what is actually wired, and removes a
deprecated `api.vault.endpoint` seam that invites new callers onto a dead path.

## Current state

Verified at `57a6c80`. Excerpts are first-hand — confirm they still match.

### The one and only `api.vault.endpoint` caller

`modules/core/library/music/api.js:41-42`:

```js
  // /api/reveal stays on the deprecated endpoint adapter until SF11 lands tauri-plugin-opener.
  revealInFiles:    (path) => _api.vault.endpoint('POST', '/api/reveal', { path }),
```

That comment is stale: `reveal_in_files` (a Tauri command) already exists and
is invoked directly in many places. The exemplar target pattern lives one file
up — `modules/core/library/api.js:61` already does exactly this:

```js
  revealInFiles:     (path) => _api.invoke('reveal_in_files', { path }),
```

`reveal_in_files` is registered in Rust (`src-tauri/src/lib.rs:724`,
`src-tauri/build.rs:166`, defined `src-tauri/src/commands/media.rs:290`) and
directly invoked in at least: `web/src/context-menu/defaultMenus.js:181,228`,
`web/src/downloads/DownloadsProvider.jsx:242`,
`web/src/components/vault-tree/revealInFiles.js:13`,
`modules/studio/video-editor/ExportDialog.jsx:231`,
`modules/studio/video-editor/EditorPage.jsx:1333`,
`modules/core/library/api.js:61`. Behavior is identical — the adapter just
routed `POST /api/reveal` → `reveal_in_files`. Switching music to a direct
invoke changes nothing observable.

### The endpoint adapter (delete entirely)

`web/src/module-sdk/endpoint-adapter.js` — 65 lines, a `ROUTES` array (13
entries) and one export `mapEndpoint(method, path, body)`. It is imported in
exactly one place: `web/src/module-sdk/index.js:5`
`import { mapEndpoint } from './endpoint-adapter.js';`.

### The `endpoint` method + warn set in the SDK factory

`web/src/module-sdk/index.js:61` and `:76-87`:

```js
const _warnedEndpointRoutes = new Set();
```
```js
    vault: {
      /** Deprecated: use api.invoke(commandName, args) instead. ... */
      endpoint: (method, path, body) => {
        const pathOnly = String(path).split('?')[0];
        const key = `${method} ${pathOnly}`;
        if (!_warnedEndpointRoutes.has(key)) {
          _warnedEndpointRoutes.add(key);
          console.warn(`[Module SDK] api.vault.endpoint is deprecated; ...`);
        }
        const mapped = mapEndpoint(method, path, body);
        if (mapped) return invoke(mapped.command, mapped.args);
        throw new Error(`[Module SDK] Endpoint not migrated: ${key}. ...`);
      },
      /** Subscribes to vault invalidation events. ... */
      subscribe: (eventName, handler) => subscribeEvents((name, data) => {
        if (name === eventName) handler(data);
      }),
    },
```

**Keep `vault.subscribe`** — it is used (`modules/core/library/music/api.js:46`
`_api.vault.subscribe('manifest', handler)`). Delete only the `endpoint`
method, the `mapEndpoint` import, and the `_warnedEndpointRoutes` set.

### The redirect machinery (delete entirely — zero consumers)

`web/src/module-sdk/index.js:107-111` — the `router` slot exposes it:

```js
    router: {
      navigate,
      useHashRoute,
      registerRedirect: (fromPattern, toFn) => registry.registerRedirect(moduleId, fromPattern, toFn),
    },
```

**Keep `navigate` and `useHashRoute`.** Delete only `registerRedirect`.

`web/src/module-sdk/registry.js` — `:8` `const _redirects = [];`, `:22`
`redirects: [..._redirects],` (inside `computeSnapshot`), and `:115-125` the
`registerRedirect(moduleId, fromPattern, toFn)` function.

`web/src/module-sdk/useModuleRegistry.js` — `:12`
`const getRedirects = () => getSnapshot().redirects;` and `:64-70`:

```js
// Returns the array of redirect entries: { moduleId, fromPattern, toFn }.
// Consumed once at the top of MainApp via a useEffect that fires the first
// non-null toFn() result for the current route. Re-renders when modules
// register/unregister redirects.
export function useRouterRedirects() {
  return useSyncExternalStore(subscribe, getRedirects);
}
```

That comment is **false** — grep finds no `MainApp` consumer and no
`useRouterRedirects` caller. `modules/core/terminal/index.jsx:8` even documents
the reality: `// registerRedirect is never consumed, so the rewrite lives in
the view`.

### Confirmed: exactly one `.endpoint(` caller, zero redirect consumers

At `57a6c80`, `grep -rn "\.endpoint(" web/ modules/` (js/jsx) returns exactly
one hit: `modules/core/library/music/api.js:42`. `grep -rn
"registerRedirect\|useRouterRedirects\|_warnedEndpointRoutes\|_redirects" web/
modules/` returns only the definition sites listed above plus the terminal
comment — no external consumer.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat 57a6c80..HEAD -- modules/core/library/music/api.js web/src/module-sdk/` | empty (no drift) |
| Build (verify) | `npm --prefix web run build` | exit 0, `dist/` written |
| Grep dead symbols | see Done criteria | no matches |

The repo has no typecheck or lint script (plain JS/JSX; the only checks are
`npm --prefix web run check-themes` / `check-drag`, unrelated here). `npm --prefix
web run build` (Vite build) is the compile gate — an unresolved import or bad
reference fails it. Driving the full desktop app (`npm run tauri dev`) is
optional and not required for this pure deletion.

## Scope

**In scope** (the only files you should modify):
- `modules/core/library/music/api.js` — switch the one `endpoint` caller to `invoke`
- `web/src/module-sdk/endpoint-adapter.js` — **delete the file**
- `web/src/module-sdk/index.js` — remove import, `_warnedEndpointRoutes`, `vault.endpoint`, `router.registerRedirect`
- `web/src/module-sdk/registry.js` — remove `_redirects`, snapshot field, `registerRedirect`
- `web/src/module-sdk/useModuleRegistry.js` — remove `getRedirects`, `useRouterRedirects`

**Out of scope** (do NOT touch):
- `src-tauri/src/commands/media.rs` and any Rust — `reveal_in_files` behavior is unchanged; do not alter the command.
- `modules/core/terminal/index.jsx` — its line-8 comment references `registerRedirect` and becomes slightly stale after deletion, but editing it is out of this plan's scope. Note it in the PR; leave the code alone.
- Any other module or host file.

## Git workflow

- Branch: `advisor/007-delete-dead-sdk-surface` (match the repo's convention if one is evident from `git branch`).
- Commit style: conventional commits (repo uses e.g. `fix(broadcast): ...`, `feat(scrim): ...`). Suggested message: `refactor(module-sdk): delete dead endpoint adapter + unused registerRedirect`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

Order matters: switch the caller first (Step 1), then delete the now-unused
adapter (Step 2), so the tree is never broken between steps.

### Step 1: Switch the music module off `api.vault.endpoint`

In `modules/core/library/music/api.js`, replace lines 41-42:

```js
  // /api/reveal stays on the deprecated endpoint adapter until SF11 lands tauri-plugin-opener.
  revealInFiles:    (path) => _api.vault.endpoint('POST', '/api/reveal', { path }),
```

with:

```js
  revealInFiles:    (path) => _api.invoke('reveal_in_files', { path }),
```

(Mirror `modules/core/library/api.js:61`. Drop the stale comment.)

**Verify**: `grep -rn "\.endpoint(" web/ modules/` → **no matches** (exit code 1).

### Step 2: Delete the endpoint adapter file and its import

Delete the file `web/src/module-sdk/endpoint-adapter.js`.

In `web/src/module-sdk/index.js`, remove line 5:
`import { mapEndpoint } from './endpoint-adapter.js';`

**Verify**: `grep -rn "endpoint-adapter\|mapEndpoint" web/ modules/` → **no matches**; `ls web/src/module-sdk/endpoint-adapter.js` → "No such file".

### Step 3: Remove `vault.endpoint` and `_warnedEndpointRoutes` from the SDK factory

In `web/src/module-sdk/index.js`:
- Delete `const _warnedEndpointRoutes = new Set();` (line ~61).
- In the `vault:` object, delete the entire `endpoint: (method, path, body) => { ... }` method (its JSDoc line + body, lines ~76-87). **Keep `subscribe`.**

The `vault:` object must end up as:

```js
    vault: {
      /** Subscribes to vault invalidation events. ... (keep the existing comment) */
      subscribe: (eventName, handler) => subscribeEvents((name, data) => {
        if (name === eventName) handler(data);
      }),
    },
```

**Verify**: `grep -rn "_warnedEndpointRoutes\|vault.endpoint\|\.endpoint(" web/ modules/` → **no matches**.

### Step 4: Remove `registerRedirect` from the SDK `router` slot

In `web/src/module-sdk/index.js`, in the `router:` object delete the
`registerRedirect: ...` line (line ~110). The object must end up as:

```js
    router: {
      navigate,
      useHashRoute,
    },
```

**Verify**: `grep -n "registerRedirect" web/src/module-sdk/index.js` → **no matches**.

### Step 5: Remove the redirect store from the registry

In `web/src/module-sdk/registry.js`:
- Delete `const _redirects = [];` (line ~8).
- In `computeSnapshot()`, delete the `redirects: [..._redirects],` line (line ~22).
- Delete the entire `export function registerRedirect(moduleId, fromPattern, toFn) { ... }` function (lines ~115-125).

**Verify**: `grep -n "redirects\|registerRedirect" web/src/module-sdk/registry.js` → **no matches**.

### Step 6: Remove the redirect hook and selector

In `web/src/module-sdk/useModuleRegistry.js`:
- Delete `const getRedirects = () => getSnapshot().redirects;` (line ~12).
- Delete the `useRouterRedirects` block (its 4-line comment + the exported function, lines ~64-70).

**Verify**: `grep -n "redirects\|useRouterRedirects" web/src/module-sdk/useModuleRegistry.js` → **no matches**.

### Step 7: Build

**Verify**: `npm --prefix web run build` → exit 0 (`dist/` written, no
unresolved-import or reference error).

## Test plan

No new tests. This is a pure deletion with one caller-swap to an
already-exercised command. The build (Step 7) is the compile gate. Optionally,
if you can drive the app (`npm run tauri dev`), open the Music library and use
"Reveal in Files" on an album to confirm the OS file manager opens — but this
is the same `reveal_in_files` command already used across the app, so the build
passing is sufficient evidence.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn "\.endpoint(" web/ modules/` → no matches
- [ ] `grep -rn "endpoint-adapter\|mapEndpoint\|_warnedEndpointRoutes" web/ modules/` → no matches
- [ ] `grep -rn "registerRedirect\|useRouterRedirects" web/ modules/` → no matches (the terminal comment at `modules/core/terminal/index.jsx:8` is prose, not code — if grep flags it, that is acceptable and left as-is per Scope)
- [ ] `web/src/module-sdk/endpoint-adapter.js` does not exist
- [ ] `npm --prefix web run build` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (if the file exists)

## STOP conditions

Stop and report back (do not improvise) if:

- **`grep -rn "\.endpoint(" web/ modules/` finds a SECOND caller** (any hit other than `modules/core/library/music/api.js:42`). It means the adapter serves more than the one documented caller and cannot be fully removed as-is. Report the extra caller(s) and stop — do NOT delete `endpoint-adapter.js`.
- Any "Current state" excerpt does not match the live code (drift since `57a6c80`).
- `npm --prefix web run build` fails after the edits and the cause is not an obvious leftover reference you introduced.
- Removing `registerRedirect`/`useRouterRedirects` surfaces an actual consumer the grep in "Current state" missed.

## Maintenance notes

- The line-8 comment in `modules/core/terminal/index.jsx` ("the registry's `registerRedirect` is never consumed") describes a mechanism that no longer exists after this plan. A future cleanup pass may simplify that comment; it is intentionally left out of scope here to keep the diff to the SDK surface.
- If a future feature genuinely needs cross-route redirects, build the consumer (a `MainApp`-level effect) and the registry store together — do not resurrect this half without its reader.
- Reviewer should confirm `vault.subscribe`, `router.navigate`, and `router.useHashRoute` survive untouched, and that the `computeSnapshot()` return object no longer lists `redirects`.

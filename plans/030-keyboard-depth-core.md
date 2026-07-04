# Plan 030: Extend keyboard depth into Core modules (Planner + Music first)

> **Executor instructions**: Follow this plan step by step. It adds rebindable
> keybinds to two Core modules by reusing the EXISTING host keybind system — no
> host/registry changes. Each keybind is two parts: (1) a registry ENTRY that
> makes it appear + rebindable in Settings ▸ Keybinds and the `?` overlay, and
> (2) a HANDLER that actually runs the action. You must do both or the key does
> nothing. Run every verification. If a STOP condition hits, stop and report.
> Update the `plans/README.md` status row if that file exists.
>
> **Drift check (run first)**:
> `git -C . diff --stat 57a6c80..HEAD -- web/src/keybinds modules/core/planner modules/core/library modules/studio/video-editor/keybinds.js`
> If any cited file changed since this plan was written, compare against the
> "Current state" excerpts before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S per module (coarse; two modules ≈ S–M total)
- **Risk**: LOW (additive; reuses shipped infra; no host changes)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

PRODUCT.md requires that "keyboard navigation must reach every action available
via mouse" (`PRODUCT.md:108`) and names Linear's "fast keystrokes" as a brand
anchor (`PRODUCT.md:41`). But keyboard depth today is lopsided: the paid **Studio**
tier (Video Editor, Broadcast) registers rich rebindable keymaps, while the free
**Core** tier — the Planner and Music player that every non-paying user actually
judges the app on — registers **zero** module keybinds. The infra to fix this
already ships (a module keybind registry + a rebind UI + a `?` cheatsheet
generated from it); it is simply unused by Core. This plan wires the two
highest-traffic Core modules into it, reusing the exact pattern Studio already
uses. It is small and host-change-free.

## Current state

All read first-hand at `57a6c80`.

- **The 6 global keybinds** — `web/src/keybinds/registry.js:17-54`, `KEYBIND_REGISTRY`.
  That is the entire host keymap: `command-palette.toggle` (⌘K),
  `sidebar.peek-left` (hold Shift), `sidebar.peek-right` (hold Alt),
  `hints.toggle` (`?`), `browser.new-tab` (⌘T), `browser.cycle-tab` (⌘Tab).
  Binding shapes (registry.js:8-11): `{ kind:'chord', key, modifiers:[...] }` or
  `{ kind:'hold', modifier }`.

- **The module-keybind extension point** — `web/src/keybinds/registry.js:73-83`:
  ```js
  const MODULE_REGISTRY = [];
  export function registerModuleKeybinds(entries) {
    for (const e of entries || []) {
      if (!e?.id || KEYBINDS_DEFAULT[e.id]) continue; // idempotent across HMR re-runs
      MODULE_REGISTRY.push({ id: e.id, group: e.group, label: e.label, default: e.default });
      KEYBINDS_DEFAULT[e.id] = e.default;
    }
  }
  export function getFullRegistry() { return [...KEYBIND_REGISTRY, ...MODULE_REGISTRY]; }
  ```
  `getFullRegistry()` is what the `?` cheatsheet and the Settings ▸ Keybinds
  rebind editor render from. Registering an entry here is how a row appears +
  becomes rebindable.
  **GOTCHA (found during planning):** the idempotency guard tests
  `KEYBINDS_DEFAULT[e.id]` for *truthiness*. A `default: null` ("unbound")
  entry sets `KEYBINDS_DEFAULT[id] = null` (falsy), so the next HMR re-run does
  NOT skip it and pushes a DUPLICATE into `MODULE_REGISTRY`. The shipped Studio
  entries dodge this because their defaults are truthy chord objects. Therefore
  this plan uses **real (truthy) default chords**, not unbound rows. (Editing
  the guard to be null-safe is a host change and is OUT of scope — see STOP.)

- **Only Studio registers module keybinds — zero Core.** A repo-wide search for
  `registerModuleKeybinds` returns exactly 3 files, all Studio:
  `modules/studio/broadcast/index.jsx`, `modules/studio/video-editor/index.jsx`,
  `modules/studio/video-editor/keybinds.js`. No `modules/core/*` file calls it.

- **The registration exemplar (lightest form)** — `modules/studio/broadcast/index.jsx:18-27`:
  ```js
  export const KEYBIND_ENTRIES = [
    { id: 'broadcast.record-toggle', group: 'Broadcast', label: 'Toggle recording',
      default: { kind: 'chord', key: 'b', modifiers: ['meta', 'shift'] } },
  ];
  export default {
    register(api) {
      const { IconBroadcast } = api.ui.icons;
      registerModuleKeybinds(KEYBIND_ENTRIES);   // ← line 27
      ...
  ```
  (The heavier exemplar, `video-editor/keybinds.js:52-54`, exports
  `VEDIT_KEYBIND_ENTRIES` = `DEFS.map(...)` for a 22-row keymap. For 3 rows,
  mirror Broadcast's inline form.) Note ⌘⇧B is TAKEN by Broadcast — avoid it.

- **The HANDLER hook** — `web/src/keybinds/useKeybind.js:24-49`:
  `useKeybindAction(id, keybinds, handler, opts)` adds a `window` keydown
  listener, ignores editable targets by default, and falls back to
  `KEYBINDS_DEFAULT[id]` if the user cleared the row. Host exemplar,
  `web/src/App.jsx:155-156`:
  ```js
  useKeybindAction('command-palette.toggle', settings.keybinds, togglePalette, { ignoreEditableTarget: true });
  useKeybindAction('hints.toggle', settings.keybinds, toggleHints);
  ```
  `settings.keybinds` comes from `useSettings()`.

- **Planner — actions already proven reachable.** `modules/core/planner/index.jsx`
  registers a provider + widget in `register(api)`. The control functions live in
  `modules/core/planner/PlannerProvider.jsx`, which is ALWAYS mounted (registered
  via `api.slots.registerProvider(PlannerProvider)`). That provider ALREADY wires
  the same actions into the ⌘K command palette
  (`PlannerProvider.jsx:748-773`) — proving they are in scope:
  ```js
  registerCommandAction({ id: 'planner.toggle', label: running ? 'Pause Planner' : 'Start Planner', run: () => toggleTimer() });
  registerCommandAction({ id: 'planner.skip',   label: ..., run: () => skipPhase() });
  registerCommandAction({ id: 'planner.reset',  label: 'Reset Planner', run: () => resetTimer() });
  ```
  The context value (`PlannerProvider.jsx:775-809`) exposes `toggleTimer`,
  `skipPhase`, `resetTimer` (timer controls) and also `settings` (line 777) — so
  `settings.keybinds` is already in local scope here.

- **Music — transport reachable via a hook, provider always mounted.** Transport
  is `modules/core/library/music/MusicPlayerProvider.jsx`: `toggle`
  (line 448, play/pause), `next` (454), `prev` (463), exposed on the context value
  (545-560) and read via `export function useMusicPlayer()` (line 565). The
  provider is mounted app-wide: `modules/core/library/index.jsx:94-117` composes
  `LibraryRoot` (which wraps `MusicPlayerProvider`) and registers it with
  `api.slots.registerProvider(LibraryRoot)` — the comment at lines 89-92 confirms
  "Registered providers persist across navigation, so playback ... keep[s]
  running wherever the user goes." So a global music-transport keybind is
  feasible: a tiny handler component mounted inside `LibraryRoot` can call
  `useMusicPlayer()` + `useKeybindAction`.

- **Proposed default chords (collision-checked; keycaps are maintainer-adjustable
  — see STOP).** All `meta+shift` chords (mirrors Broadcast's global-safe
  pattern; modifier-gated so they never fire mid-typing), mutually distinct, and
  distinct from the 6 globals (⌘K, ⌘T, ⌘Tab, `?`, Shift-hold, Alt-hold) and from
  ⌘⇧B (Broadcast):

  | id | group | label | proposed default |
  |---|---|---|---|
  | `music.play-pause` | Music | Play / pause | ⌘⇧Space (`key:' '`) |
  | `music.next` | Music | Next track | ⌘⇧] (`key:']'`) |
  | `music.prev` | Music | Previous track | ⌘⇧[ (`key:'['`) |
  | `planner.timer-toggle` | Planner | Start / pause focus timer | ⌘⇧Enter (`key:'Enter'`) |
  | `planner.skip-phase` | Planner | Skip focus/break phase | ⌘⇧. (`key:'.'`) |
  | `planner.reset` | Planner | Reset focus timer | ⌘⇧Backspace (`key:'Backspace'`) |

  (Named/multi-modifier keys like `Enter`, `Backspace`, brackets already ship in
  `video-editor/keybinds.js` DEFS — the shapes are proven.)

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Dev run | `npm run tauri dev` | Vite 127.0.0.1:5173 + desktop window, no console errors |
| Confirm Core now registers | `git -C . grep -rn "registerModuleKeybinds" modules/core` | hits in planner + library |
| Confirm no host edits | `git -C . status --porcelain web/src` | empty (no host files changed) |

## Scope

**In scope** (the only files you modify):
- `modules/core/planner/index.jsx` — add `registerModuleKeybinds([...planner rows])`
  in `register(api)` (mirror Broadcast index.jsx:27).
- `modules/core/planner/PlannerProvider.jsx` — add 3 `useKeybindAction(...)` calls
  next to the existing palette `useEffect` (the functions + `settings` are already
  in scope). Import `useKeybindAction` from `@host/keybinds/useKeybind.js`.
- `modules/core/library/index.jsx` — add `registerModuleKeybinds([...music rows])`
  in `register(api)`, and mount a tiny `MusicKeybinds` handler component INSIDE
  `LibraryRoot` (as a sibling of `{children}`, under `MusicPlayerProvider`). It
  uses `useMusicPlayer()` (already imported here), `useSettings()`
  (`@host/hooks/useSettings.js`), and `useKeybindAction`
  (`@host/keybinds/useKeybind.js`).

**Out of scope** (do NOT touch):
- `web/src/keybinds/*` — do NOT rebuild or modify the keybind registry, the
  `useKeybindAction` hook, or the `?` overlay. This plan only *consumes* them.
  (In particular, do not "fix" the null-default idempotency guard — see STOP.)
- Any Studio module. Any Core module beyond Planner + Music (Vault, Pulse,
  Browser already covered by globals, Graph, etc. are later).
- The Planner's block-run controls (`startBlockTimer`/`stopBlockRun`/
  `finishBlockEarly`) — a noted follow-up; bind only the 3 timer controls that
  the palette already exposes.

## Steps

### Step 1: Planner — register the 3 entries

In `modules/core/planner/index.jsx`, import `registerModuleKeybinds` from
`@host/keybinds/registry.js` (mirror video-editor/index.jsx:5) and, at the top of
`register(api)` (before/after `bindPlannerApi(api)`), call:
```js
registerModuleKeybinds([
  { id: 'planner.timer-toggle', group: 'Planner', label: 'Start / pause focus timer', default: { kind: 'chord', key: 'Enter',     modifiers: ['meta', 'shift'] } },
  { id: 'planner.skip-phase',   group: 'Planner', label: 'Skip focus/break phase',    default: { kind: 'chord', key: '.',         modifiers: ['meta', 'shift'] } },
  { id: 'planner.reset',        group: 'Planner', label: 'Reset focus timer',         default: { kind: 'chord', key: 'Backspace', modifiers: ['meta', 'shift'] } },
]);
```

**Verify**: `npm run tauri dev` boots; open the `?` overlay — a "Planner" group
shows the 3 rows with their chords.

### Step 2: Planner — wire the 3 handlers

In `modules/core/planner/PlannerProvider.jsx`, import
`useKeybindAction` from `@host/keybinds/useKeybind.js`. Just after the existing
palette-registration `useEffect` (ends at line ~773), add:
```js
useKeybindAction('planner.timer-toggle', settings.keybinds, toggleTimer);
useKeybindAction('planner.skip-phase',   settings.keybinds, skipPhase);
useKeybindAction('planner.reset',        settings.keybinds, resetTimer);
```
`settings`, `toggleTimer`, `skipPhase`, `resetTimer` are all already in scope in
this component (confirmed in Current state).

**Verify**: `npm run tauri dev`; press ⌘⇧Enter — the Planner timer starts/pauses
(same effect as the "Start Planner"/"Pause Planner" palette action). ⌘⇧. skips
phase; ⌘⇧Backspace resets. Confirm none fires while typing in a text field.

### Step 3: Music — register 3 entries + mount the handler

In `modules/core/library/index.jsx`:
1. Import `registerModuleKeybinds` (`@host/keybinds/registry.js`),
   `useKeybindAction` (`@host/keybinds/useKeybind.js`), and `useSettings`
   (`@host/hooks/useSettings.js`). `useMusicPlayer` is already imported (line 15).
2. In `register(api)`, add:
   ```js
   registerModuleKeybinds([
     { id: 'music.play-pause', group: 'Music', label: 'Play / pause',    default: { kind: 'chord', key: ' ', modifiers: ['meta', 'shift'] } },
     { id: 'music.next',       group: 'Music', label: 'Next track',      default: { kind: 'chord', key: ']', modifiers: ['meta', 'shift'] } },
     { id: 'music.prev',       group: 'Music', label: 'Previous track',  default: { kind: 'chord', key: '[', modifiers: ['meta', 'shift'] } },
   ]);
   ```
3. Add a handler component and mount it inside `LibraryRoot` (under
   `MusicPlayerProvider`, as a sibling of `{children}`):
   ```jsx
   function MusicKeybinds() {
     const { settings } = useSettings();
     const { toggle, next, prev } = useMusicPlayer();
     useKeybindAction('music.play-pause', settings.keybinds, toggle);
     useKeybindAction('music.next',       settings.keybinds, next);
     useKeybindAction('music.prev',       settings.keybinds, prev);
     return null;
   }
   // ...inside LibraryRoot's provider stack, next to {children}:
   //   <PlaylistProvider>{children}<MusicKeybinds/></PlaylistProvider>
   ```

**Verify**: `npm run tauri dev`; start a track, navigate to a different module,
press ⌘⇧Space — playback pauses/resumes from anywhere (proves the global
always-mounted handler). ⌘⇧] / ⌘⇧[ change track. The `?` overlay shows a "Music"
group with the 3 rows.

### Step 4: Confirm rebindability + no collisions

Open Settings ▸ Keybinds. Confirm the Planner and Music groups render with
editable rows (rebinding one and reloading persists — this is the
`settings.keybinds` round-trip; it is MANUAL to verify). Eyeball the `?` overlay
for any duplicate chord across groups.

**Verify**: the 6 new rows are visible and editable in Settings ▸ Keybinds; no
chord appears twice in the `?` overlay.

## Done criteria

Machine-checkable / reviewable. ALL must hold:

- [ ] `git -C . grep -rn "registerModuleKeybinds" modules/core` shows hits in
      `planner/index.jsx` and `library/index.jsx`.
- [ ] `git -C . status --porcelain web/src` is empty (no host files changed).
- [ ] `npm run tauri dev` boots with no console errors.
- [ ] The `?` overlay shows a Planner group (3 rows) and a Music group (3 rows).
- [ ] Manual: ⌘⇧Enter toggles the Planner timer; ⌘⇧Space toggles music playback
      from a non-Music module; both are rebindable in Settings ▸ Keybinds.
- [ ] Only the 3 in-scope files were modified (`git status`).
- [ ] `plans/README.md` status row updated (only if that file exists).

## STOP conditions

Stop and report (do not improvise) if:

- `registerModuleKeybinds`'s signature or the `KEYBIND_ENTRIES`/
  `VEDIT_KEYBIND_ENTRIES` shape differs from the Current-state excerpts (the
  registry drifted). Do NOT invent a new shape.
- Making a keybind work appears to require editing anything under
  `web/src/keybinds/` — that is a host change and out of scope. In particular, if
  you decide "unbound by default" rows are wanted, note that the idempotency
  guard at `registry.js:75` double-registers null defaults (see Current state) —
  do NOT patch the guard here; surface it as adjacent work and stop.
- The Planner control functions (`toggleTimer`/`skipPhase`/`resetTimer`) are no
  longer in `PlannerProvider.jsx`, or `useMusicPlayer()` no longer exposes
  `toggle`/`next`/`prev`.
- **Keycap choice**: the proposed default chords are a taste call the maintainer
  may want to own (they become the out-of-box brand keymap). If the maintainer
  wants different keys, use theirs — but keep them `meta+shift` (or otherwise
  modifier-gated) and collision-checked against the table in Current state.

## Maintenance notes

- This is the template for extending keyboard depth to the remaining Core modules
  (Vault, Pulse, Graph): register entries in `register(api)`, wire handlers with
  `useKeybindAction` in an always-mounted component that can reach the actions.
- A reviewer should confirm (1) no `web/src` host file changed, (2) handlers live
  under the module's always-mounted provider so global binds actually fire, and
  (3) `settings.keybinds` is passed to every `useKeybindAction` (so rebinds take
  effect without reload).
- Deferred: Planner block-run controls (`startBlockTimer`/`stopBlockRun`/
  `finishBlockEarly`), music `seek`/`cycleRepeat`/`toggleShuffle`, and a
  `keybinds.js`-per-module split (worth it only once a module exceeds ~a dozen
  rows, like the Video Editor).

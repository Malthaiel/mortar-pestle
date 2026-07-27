# App Conventions

De-facto standards for persistence, data access, and notifications. New code
follows these; drift is the exception and must be justified inline. **CSS
ownership** is a design-language concern and is documented in `docs/DESIGN.md`
(§ "CSS ownership"), beside the module↔host import-boundary note.

## Persistence
- **`useSettings` / the module-SDK `settings.*` surface is the standard** for
  user and module preferences.
- Use raw `localStorage` only where `settings.*` is unreachable — the documented
  case is the bare overlay-host webview (`overlay-studio-order`), which can't
  reach the server-backed `useSidebarOrder`.
- Use server/vault-JSON persistence when the value must survive a reinstall or
  be shared across vaults (name the case at the call site).

## Data access
- **One path: a module-owned `api.js` wrapper → the SDK `invoke`.** Modules that
  talk to Rust own a thin `api.js` (see `modules/core/library/api.js`) rather
  than calling raw `invoke` scattered across components.
- `vault.endpoint` is deprecated — do not add new callers.

## Notifications
- **One entry point: `notify` (the `agentic:notify` bus).** `Toast.`/`showToast`/
  `toast(` are legacy and are being swept out.

## Follow-up sweeps (tracked, not yet done)

These are the deferred reconciliations — named above as standing conventions,
but the enforcement sweep is future work. Do each a few files at a time with a
manual smoke, since localStorage and notification routing are both
silent-regression-prone. Regenerate the lists with the greps cited inline.

### Raw `localStorage` — 42 files bypass `useSettings`

`grep -rl "localStorage\.\(get\|set\|remove\)Item" modules web/src`

```
modules/core/game-wiki/MatchViewPopup.jsx
modules/core/game-wiki/ScrimViewer.jsx
modules/core/game-wiki/useGameWikiTree.js
modules/core/library/music/AlbumBrowser.jsx
modules/core/library/music/MusicPage.jsx
modules/core/library/music/MusicPlayerProvider.jsx
modules/core/library/SeriesBrowser.jsx
modules/core/library/SeriesDetail.jsx
modules/core/library/VideoPlayerProvider.jsx
modules/core/planner/PlannerProvider.jsx
modules/studio/video-editor/color/useGlDisplay.js
web/src/components/AppShell.jsx
web/src/components/ConfettiBurst.jsx
web/src/components/planner/ItemChips.jsx
web/src/components/settings/settings-registry.js
web/src/components/SettingsDrawer.jsx
web/src/components/Sidebar.jsx
web/src/components/SidebarSeam.jsx
web/src/components/vault-tree/useTreeExpansion.js
web/src/components/vault-tree/useVaultTree.js
web/src/hooks/useActiveModule.jsx
web/src/hooks/useEventReminders.js
web/src/hooks/useLastSeenVersion.js
web/src/hooks/useModuleEnabled.js
web/src/hooks/usePlannerSplit.js
web/src/hooks/useRailVariant.js
web/src/hooks/useRecentPages.js
web/src/hooks/useSectionMemory.js
web/src/hooks/useSettings.js
web/src/hooks/useSidebarGroupMode.js
web/src/hooks/useTactileSound.js
web/src/hooks/useToolkitExpanded.js
web/src/module-sdk/index.js
web/src/notifications/NotificationProvider.jsx
web/src/overlays/AgentsOverlayLauncher.jsx
web/src/overlays/OverlayBrowserPanel.jsx
web/src/overlays/OverlayStudioPanel.jsx
web/src/overlays/ScrimOverlayPanel.jsx
web/src/overlays/useOverlayPanelDrag.js
web/src/overlays/useOverlayPanelResize.js
web/src/overlays/useScrimOverlay.js
```

Note: `web/src/hooks/useSettings.js` appears because it *is* the settings
implementation (50 `localStorage` refs) — it is not a violation. The overlay
files (`web/src/overlays/*`) are the documented bare-webview exception. The
rest are the sweep targets.

### Legacy notification entry points — collapse to `notify`

`grep -rn "Toast\.\|showToast\|[^a-zA-Z]toast(" modules web/src`

- `notify(` — 80 calls (the winner, the `agentic:notify` bus).
- `Toast.` — 20 calls (legacy).
- `showToast` — 20 calls (legacy).
- `toast(` — 7 calls (legacy).

The download/import providers already route through the central `agentic:notify`
bus (see `modules/core/library/music/DownloadProvider.jsx`). Sweep the 47 legacy
call sites toward `notify`.

### Module-owned `api.js` wrappers + `vault.endpoint` deprecation

Five module-owned `api.js` wrappers coexist with the `@host/api.js` barrel and
the deprecated `vault.endpoint`. New code uses the module wrapper → SDK `invoke`;
do not add new `vault.endpoint` callers. Reconciling the existing wrappers and
removing `vault.endpoint` is a separate scoped plan.
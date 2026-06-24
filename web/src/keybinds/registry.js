// Single source of truth for the host's global keybinds. Each entry declares
// its id, display group, label, and default binding. KEYBINDS_DEFAULT is
// derived from this list and is consumed by useSettings (to seed defaults),
// useKeybindAction / useKeybindHold (as a fallback when the user clears a
// row to "Unbound" and then reloads), and KeyboardHintsOverlay (to render
// the cheatsheet from the same data the editor writes against).
//
// Binding shapes:
//   chord: { kind: 'chord', key: 'k',  modifiers: ['meta'] }   // Cmd/Ctrl+K
//   chord: { kind: 'chord', key: '?',  modifiers: [] }         // just ?
//   hold:  { kind: 'hold',  modifier: 'Shift' }                // hold Shift
//
// 'meta' is platform-primary — matches Cmd on Mac, Ctrl on Win/Linux. This
// preserves the existing App.jsx `const meta = e.metaKey || e.ctrlKey`
// behavior so default shortcuts work identically on every platform.

export const KEYBIND_REGISTRY = [
  {
    id: 'command-palette.toggle',
    group: 'Navigation',
    label: 'Open command palette',
    default: { kind: 'chord', key: 'k', modifiers: ['meta'] },
  },
  {
    id: 'sidebar.peek-left',
    group: 'Navigation',
    label: 'Hold to peek the left sidebar',
    default: { kind: 'hold', modifier: 'Shift' },
  },
  {
    id: 'sidebar.peek-right',
    group: 'Navigation',
    label: 'Hold to peek the right sidebar',
    default: { kind: 'hold', modifier: 'Alt' },
  },
  {
    id: 'hints.toggle',
    group: 'Help',
    label: 'Toggle keyboard shortcuts overlay',
    default: { kind: 'chord', key: '?', modifiers: [] },
  },
  {
    id: 'browser.new-tab',
    group: 'Browser',
    label: 'Open a new browser tab',
    default: { kind: 'chord', key: 't', modifiers: ['meta'] },
  },
  {
    id: 'browser.cycle-tab',
    group: 'Browser',
    label: 'Cycle to the next browser tab',
    default: { kind: 'chord', key: 'tab', modifiers: ['meta'] },
  },
];

export const KEYBINDS_DEFAULT = Object.fromEntries(
  KEYBIND_REGISTRY.map(({ id, default: def }) => [id, def]),
);

export function getRegistryEntry(id) {
  return getFullRegistry().find(e => e.id === id);
}

// ── Module-registered keybinds (tier-aware) ────────────────────────────────
// A module registers its keybind defs from register(api) — loadAll() runs
// every module entry before first render, so KEYBINDS_DEFAULT is complete
// before useSettings seeds/merges from it. Tier safety falls out for free:
// a build that doesn't ship the module never registers its rows, so
// KeybindsTab and the ? cheatsheet stay clean — no static registry entries
// for absent features.
const MODULE_REGISTRY = [];

export function registerModuleKeybinds(entries) {
  for (const e of entries || []) {
    if (!e?.id || KEYBINDS_DEFAULT[e.id]) continue; // idempotent across HMR re-runs
    MODULE_REGISTRY.push({ id: e.id, group: e.group, label: e.label, default: e.default });
    KEYBINDS_DEFAULT[e.id] = e.default;
  }
}

export function getFullRegistry() {
  return [...KEYBIND_REGISTRY, ...MODULE_REGISTRY];
}

// Live view of settings.keybinds for non-React consumers (module keydown
// handlers resolve bindings at event time, so Settings rebinds apply
// instantly without re-rendering the module). useSettings publishes here on
// every keybinds change.
let liveKeybinds = null;
export function publishKeybinds(kb) { liveKeybinds = kb; }
export function getLiveKeybinds() { return liveKeybinds || KEYBINDS_DEFAULT; }

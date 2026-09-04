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
  // GLOBAL push-to-talk, not an in-app chord: this row is edited here but is
  // enforced by the STT daemon's system-wide keyboard hook, so it fires even when
  // Mortar & Pestle is unfocused. SttProvider watches it and pushes the matching
  // Win32 virtual-key to the daemon. Modifiers are ignored (the hook matches ONE
  // plain key), so keep the default modifier-less. The sibling F8 dictate bind is
  // fixed in the daemon and deliberately absent — there is nothing to edit.
  {
    id: 'stt.scrim-note',
    group: 'Voice',
    label: 'Hold to dictate a note onto the live scrim',
    default: { kind: 'chord', key: 'f9', modifiers: [] },
  },
  // Personal VODs match timer. Like `stt.scrim-note` above these are edited here
  // but NOT enforced here — they matter only while Deadlock has focus, where a
  // DOM listener is deaf, so `VodTimerBridge` pushes them to Rust's
  // `global_shortcut` plugin (OS-level RegisterHotKey). Never call
  // useKeybindAction on these ids or an in-app press fires the action twice.
  // Defaults dodge F8/F9 (the fixed dictate bind + the scrim-note hold).
  {
    id: 'vod.timer-start',
    group: 'Coaching',
    label: 'Start the match timer (works in-game)',
    default: { kind: 'chord', key: 'f6', modifiers: [] },
  },
  {
    id: 'vod.timer-pause',
    group: 'Coaching',
    label: 'Pause / resume the match timer (works in-game)',
    default: { kind: 'chord', key: 'f7', modifiers: [] },
  },
  {
    id: 'vod.timer-end',
    group: 'Coaching',
    label: 'End the match timer (works in-game)',
    default: { kind: 'chord', key: 'f10', modifiers: [] },
  },
  {
    id: 'markup.toggle',
    group: 'Design',
    label: 'Toggle markup mode (hover a component for its name + source path)',
    default: { kind: 'chord', key: 'm', modifiers: ['meta', 'shift'] },
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

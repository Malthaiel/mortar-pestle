import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitSidebarGroupModeChange } from './useSidebarGroupMode.js';
import { sharedEvents, readModuleBag, writeModuleSetting } from '../module-sdk/index.js';
import { KEYBINDS_DEFAULT, publishKeybinds } from '../keybinds/registry.js';
import { setSmoothness } from '../util/smoothWheel.js';
import { THEME_BY_ID, DEFAULT_THEME_ID } from '../themes/registry.js';
import { paintTheme } from '../themes/applyTheme.js';

// ── Animation + Sound catalogs ──────────────────────────────────────────────
// Fourteen bucketed animation toggles + three sound toggles. Each animation
// key maps to a body data-attr `data-anim-<key>="on|off"` that CSS rules in
// styles.css gate on (see § Settings gating). JS-driven animations
// (spring-press, drag-tile-follow, clock-ambient's dial glow, counter-tick,
// task-celebration) read their key from settings.animations directly. Sound
// keys are read by useTactileSound.

export const ANIMATION_KEYS = [
  'clock-ambient',
  'spring-press',
  'page-transitions',
  'drawer-modal',
  'flyout',
  'section-accordion',
  'pulse-indicators',
  'drag-tile-follow',
  'drag-tile-smoothness',
  'drag-drop-glide',
  'theme-transition',
  'planner-day-slide',
  'counter-tick',
  'task-celebration',
  'copy-day-pop',
  'frame-reset-restore',
];

// Per-key config for non-boolean animation buckets. Keys absent here are
// plain boolean toggles. Keys present carry a `default` and a `values` enum
// and round-trip through the body data-attr as their literal string value.
export const ANIMATION_KEY_CONFIG = {
  'drag-tile-follow': {
    default: 'slot-snap',
    values: ['off', 'cursor', 'slot-snap'],
  },
  // Chase-rate bucket for the 'cursor' drag-tile-follow mode. The picked-up
  // tile follows the cursor delta with exponential smoothing; this picks the
  // smoothing factor: none = 1.0 (instant 1:1), light = 0.35, medium = 0.18
  // (default), heavy = 0.08 (significant drag). Read by DraggableSidebarList.
  'drag-tile-smoothness': {
    default: 'medium',
    values: ['none', 'light', 'medium', 'heavy'],
  },
  // Glide duration for the drop-release animation. When the user lets go of
  // a picked-up tile, PlainDragTile animates the clone from its current
  // position into the final slot. This bucket picks how fast that glide
  // runs: 100 = 120ms (snappy), 75 = 160ms (default, brisk), 50 = 240ms,
  // 25 = 480ms (slow + cinematic), 'off' = skip the animation entirely
  // (clone instantly snaps to slot — matches the pre-feature behavior).
  'drag-drop-glide': {
    default: '75',
    values: ['off', '25', '50', '75', '100'],
  },
};

function defaultAnimationValue(key) {
  return ANIMATION_KEY_CONFIG[key]?.default ?? true;
}

export const SOUND_KEYS = [
  'tactile-button-thock',
  'reorder-pickup-thock',
  'reorder-drop-thock',
];

const ANIMATIONS_DEFAULT = Object.fromEntries(ANIMATION_KEYS.map(k => [k, defaultAnimationValue(k)]));
const SOUNDS_DEFAULT     = Object.fromEntries(SOUND_KEYS.map(k => [k, false]));

// Animation preset → exact bag. 'minimal' keeps only the four animations
// that carry navigation/interaction meaning; toggling them off makes the app
// feel broken. 'quiet' silences every animation.
export const ANIMATION_PRESETS = {
  full:    { ...ANIMATIONS_DEFAULT },
  minimal: Object.fromEntries(ANIMATION_KEYS.map(k => {
    if (k === 'drag-tile-follow') return [k, 'cursor'];
    if (k === 'drag-tile-smoothness') return [k, 'medium'];
    if (k === 'drag-drop-glide') return [k, '75'];
    return [k, ['page-transitions', 'drawer-modal', 'section-accordion', 'theme-transition'].includes(k)];
  })),
  quiet:   Object.fromEntries(ANIMATION_KEYS.map(k => {
    if (k === 'drag-tile-follow') return [k, 'off'];
    if (k === 'drag-tile-smoothness') return [k, 'none'];
    if (k === 'drag-drop-glide') return [k, 'off'];
    return [k, false];
  })),
};

// Sound preset → exact bag. The 'tactile' preset retired with the Pomodoro
// tick/chime (Planner Overhaul epic): with only host UI sounds left it was
// identical to 'full'. A persisted soundsPreset of 'tactile' renders as
// 'full' in SoundsTab and self-heals on the next sounds edit (inferSoundPreset).
// 'silent' is all-off (default; matches the pre-migration silent state).
export const SOUND_PRESETS = {
  full:    Object.fromEntries(SOUND_KEYS.map(k => [k, true])),
  silent:  Object.fromEntries(SOUND_KEYS.map(k => [k, false])),
};

function bagsEqual(a, b, keys) {
  for (const k of keys) {
    if (ANIMATION_KEY_CONFIG[k]) {
      if (a[k] !== b[k]) return false;
    } else if (Boolean(a[k]) !== Boolean(b[k])) {
      return false;
    }
  }
  return true;
}

export function inferAnimationPreset(bag) {
  for (const [name, preset] of Object.entries(ANIMATION_PRESETS)) {
    if (bagsEqual(bag, preset, ANIMATION_KEYS)) return name;
  }
  return 'custom';
}

export function inferSoundPreset(bag) {
  for (const [name, preset] of Object.entries(SOUND_PRESETS)) {
    if (bagsEqual(bag, preset, SOUND_KEYS)) return name;
  }
  return 'custom';
}

const DEV_DEFAULT = {
  autoCheckUpdates: true,
  updatePollInterval: 30000,
};

// Design mode (SF1-SF11 of Design Mode plan). `mode` is the master overlay
// toggle exposed by the dock brush button. The Atelier chat window drags freely
// with an edge magnet: `magnetRadius` (px; 0 = off) is how close to a
// content-area edge before it snaps flush, `snapCorners` also docks corners, and
// `dragSmoothness` (none|light|medium|heavy) sets how much it trails the cursor.
// `pendingEdits` mirrors the Tauri-persisted pending-overrides list for fast
// reads at chat-window mount; the Rust side at app_config_root()/design-pending.json
// is the source of truth.
// (The bag lives at settings.agents since the Agents-tab rename; the overlay
// feature and its design_* IPC keep the Design Mode name.)
export const AGENTS_DEFAULT = {
  mode: false,
  magnetRadius: 80,
  snapCorners: false,
  dragSmoothness: 'medium',
  // SF10 — pending overrides moved to Tauri-backed JSON at
  // <app_config>/design-pending.json (see useLiveOverrides.js +
  // design_pending_get/set commands). The dormant localStorage array was
  // never written to in shipped code, so no migration is needed.
  // SF7 — persisted Atelier chat-window position. null = derive from current
  // viewport (bottom-right default); the Reset-position button writes null.
  // Stored as { x, y, anchor } where anchor ∈ {'left'|'right'|'top'|'bottom'|
  // 'top-left'|'top-right'|'bottom-left'|'bottom-right'|'free'} drives the
  // on-resize recompute path.
  chatPosition: null,
  // v1.5.0 — Auth backend selection. 'api-key' streams via the Anthropic
  // Messages API; 'claude-cli' spawns the local `claude` binary for Pro/Max
  // subscribers. `undefined` triggers the one-shot migration below.
  authBackend: undefined,
  // Model alias passed to both backends ('opus' | 'sonnet' | 'haiku').
  model: 'opus',
  // Optional CLI binary path override. Empty = PATH lookup.
  claudeCliPath: '',
  // Concierge (app-wide helper) — its own drag position so it doesn't fight
  // Atelier's. Shallow-merged into the agents bag, so for v1 this scoped bag
  // holds only chatPosition.
  concierge: { chatPosition: null },
};

// Dock chrome settings. The dock is a full-width bar flush with the screen
// bottom, always visible. `edgeStyle` picks the bottom-bar edge depth
// ('flush' top hairline | 'band' soft upward shadow). The fill is fixed
// charcoal across every theme (the Dock color picker + graphite/slate were
// removed). Icon face colour follows the resolved color mode (light chips in
// light mode, dark in dark) via data-dock-icon-style={resolvedTheme} on Dock
// — no user picker. `order` is the
// drag-persisted button order (empty array = declaration order).
// `expandMs` / `collapseMs` are the dock hover-expand grow / shrink durations
// (ms), published as --dock-expand-ms / --dock-collapse-ms and consumed by the
// .dock-btn width transition in styles.css.
// `modules` is the dock-driven sidebar selection bag — see useActiveModule.js:
//   - defaultMode:    'last' (persist last-clicked) | 'specific' (always boot
//                     to defaultModule)
//   - defaultModule:  moduleId used when defaultMode = 'specific'
//   - clickBehavior:  'navigate-and-swap' (click navigates AND swaps sidebar)
//                     | 'swap-only' (click only swaps sidebar)
//   - navSync:        'auto' (route changes auto-select matching module) |
//                     'sticky' (selection survives route changes)
//   - slideDuration:  260 | 220 | 320 | 'staggered' (consumed by useSidebarSwap)
//   - activeIndicator: 'accent-fill' | 'vertical-beam' | 'lift'
//                     (consumed by ModuleDockButton)

export const DOCK_DEFAULT = {
  edgeStyle: 'flush',
  order: [],
  hidden: [],            // button ids hidden from the dock (right-click → Hide)
  edgeSnap: false,       // snap a dragged icon to the nearest zone on release
  snapStrength: 'medium',// edge-snap trigger distance: 'subtle' | 'medium' | 'strong'
  defaultLayout: 'center',// 'center' | 'three-zone' — what Reset order returns to
  expandMs: 240,
  collapseMs: 240,
  modules: {
    defaultMode: 'last',
    defaultModule: 'pulse',
    clickBehavior: 'navigate-and-swap',
    navSync: 'auto',
    slideDuration: 260,
    activeIndicator: 'accent-fill',
  },
};

// Downloads history retention (Downloads popup + manager). historyExpiryDays: 0
// = keep forever. Persisted nested object; deep-merged like dock/agents.
export const DOWNLOADS_DEFAULT = { historyCap: 100, historyExpiryDays: 30 };

// Voice Transcription (STT) — the Modules › Voice settings page (Phase 5).
// `defaultModel` is the registry model SttProvider preloads on mount (replaced the
// hardcoded 'base.en'). `forceCpu` picks the whisper backend (true → use_gpu=false;
// false → auto GPU-first). `vadThreshold` (0..1) + `hangoverMs` tune dictation VAD;
// defaults mirror the engine's crate::vad DEFAULT_THRESHOLD / DEFAULT_HANGOVER_MS.
// Persisted nested object; deep-merged like dock/agents/downloads.
export const STT_DEFAULT = {
  defaultModel: 'small.en',
  forceCpu: false,
  vadThreshold: 0.5,
  hangoverMs: 300,
};

// Exported for the settings drawer's scoped-reset + modified-dot comparisons
// (settings-registry.js scopeModified).
export const SETTINGS_DEFAULTS = {
  // Recycling bin retention (Settings → System). retentionDays: items older
  // than this are auto-purged; maxItems: hard cap, oldest fall off first.
  // Mirrored to RecycleBin/retention.json for the Rust startup purge.
  recycleBinRetentionDays: 30,
  recycleBinMaxItems: 200,
  density: 'cozy',
  radiusScale: 'default',
  calendarHourHeight: 52,
  timeFormat24h: true,
  showCalendarHourGutter: true,
  // Health Column → Fitness: show the workout-streak chip in the section header.
  // Default OFF — a streak that silently breaks is demotivating ("loss is silent"),
  // so it's opt-in. Read by FitnessSection via computeFitnessStreak.
  showFitnessStreak: false,
  themeMode: 'dark',
  // Active Community Themes preset id (themes/registry.js). 'monastic' = the
  // built-in default (null override maps → styles.css base stands). While a
  // community (non-monastic) preset is active, accent collapses to the single
  // global `themeAccent` and the per-page accent system is suspended.
  themePreset: 'monastic',
  themeAccent: '#7c2d2d',
  // Global font families (Settings → Appearance → Fonts). Each value is a key
  // into FONT_OPTIONS below; the CSS-var useEffect resolves it to a font-stack
  // on :root. Defaults preserve the pre-font-changer look (DM Sans body +
  // headings + candy labels, DM Mono mono).
  fontBody: 'dm-sans',
  fontHeading: 'dm-sans',
  fontMono: 'dm-mono',
  fontCandy: 'dm-sans',
  // Hover-preview trailing-drag bucket for the animation preview cards.
  // 'none' | 'light' | 'medium' | 'heavy'. Read in AnimationRows.jsx (AnimationField).
  previewFollowDrag: 'light',
  // Smooth mouse-wheel scrolling level (Settings → Appearance → Motion).
  // 'off' = native instant scroll; 'light' | 'medium' | 'heavy' ease each wheel
  // notch toward its target (lower lerp = floatier). useSettings pushes this to
  // util/smoothWheel.js via setSmoothness(); see SMOOTHNESS_PRESETS there.
  scrollSmoothness: 'medium',
  // Candy-button hover press strength. Scales how far the button visually
  // depresses on hover (rest depth → 0). Values: '100' / '75' / '50' / '25'
  // / 'off'. Written to body[data-hover-press]; styles.css redeclares
  // --candy-depth-hover-* tokens per level.
  hoverPressIntensity: '50',
  // Candy-button rest depth, per category. Large = pills / rectangles
  // (brand pill, settings tabs, form primitives). Small = circles / small
  // squares (dock icons, transport, swatches). Values: '3' / '5' / '7' /
  // '9'. Written to body[data-large-depth] + [data-small-depth]; styles.css
  // redeclares --candy-depth + --candy-depth-small per level.
  largeButtonDepth: '7',
  smallButtonDepth: '5',
  // Music tile candy wrap depth bucket. 'large' → --candy-depth (drives off
  // largeButtonDepth). 'small' → --candy-depth-small (drives off
  // smallButtonDepth). Written to body[data-music-tile-depth]; styles.css
  // redeclares --candy-depth at .music-tile scope when 'small'.
  musicTileDepth: 'large',
  // Candy SURFACE depth bucket — the static offset-shadow band under framed
  // container surfaces (.candy-* family: modals, cards, panels, sections,
  // inputs, toggles, rows). Independent of the button depth pickers above;
  // containers never translate. Values: 'off' / 'low' / 'medium' / 'high'.
  // Written to body[data-surface-depth]; styles.css redeclares
  // --candy-surface-depth per level.
  surfaceDepth: 'medium',
  // Sidebar background texture motif (Settings → Appearance). Pure-CSS gradient
  // motifs switched via :root[data-sidebar-pattern]; see styles.css § Sidebar
  // background pattern. 'grid' | 'hatch' | 'arcs' | 'crosshatch' | 'none'.
  sidebarPattern: 'grid',
  // Sidebar group collapse behavior:
  //   'expanded'   — all groups always show their items
  //   'accordion'  — one group expanded at a time; clicking another switches
  //   'independent' — all collapsed by default; click to toggle each one (multi)
  sidebarGroupMode: 'accordion',
  // Page transition variant — which enter animation plays on route change.
  // 'candy' | 'depth' | 'reveal' | 'accent'. On/off is the separate
  // `page-transitions` animation bucket below. Written to body[data-page-tx-style];
  // styles.css § Page transitions selects the matching keyframes.
  pageTransitionStyle: 'candy',
  // Vault file-tree folder reveal/collapse animation speed. 'off' = instant;
  // 'fast' | 'normal' | 'slow' set the per-child cascade step + slide duration.
  // Read directly by VaultTree.jsx (StaggerChild delay + Collapsible duration).
  vaultTreeReveal: 'normal',
  // Show name suffixes in the vault file tree: a trailing "/" after folder names
  // + ".md" after note names. Read directly by VaultTree.jsx (SuffixCtx).
  vaultTreeSuffix: false,
  // Per-animation toggles + preset. See ANIMATION_KEYS above.
  animations: { ...ANIMATIONS_DEFAULT },
  animationsPreset: 'full',
  // Per-sound toggles + preset. See SOUND_KEYS above. All host sounds default
  // OFF to mirror the legacy uiSounds=false default; the old Pomodoro sounds also
  // default OFF (pre-migration audioEnabled=false default).
  sounds: { ...SOUNDS_DEFAULT },
  soundsPreset: 'silent',
  // In-app updater (Stage 2). `autoCheckUpdates` gates the visible badge +
  // toast (the Rust poll loop keeps running). `updatePollInterval` is read
  // by the Rust loop as ms; default 30s.
  dev: { ...DEV_DEFAULT },
  // Dock chrome configuration. Persisted nested object; see DOCK_DEFAULT.
  dock: { ...DOCK_DEFAULT },
  // Agents configuration (Design Mode overlay + Atelier). Persisted nested
  // object; see AGENTS_DEFAULT.
  agents: { ...AGENTS_DEFAULT },
  // Downloads history retention. Persisted nested object; see DOWNLOADS_DEFAULT.
  downloads: { ...DOWNLOADS_DEFAULT },
  // Per-action keybind overrides. Map of action id -> binding shape (see
  // keybinds/registry.js). Missing or empty entries fall back to defaults
  // via useKeybindAction / useKeybindHold lookups.
  keybinds: { ...KEYBINDS_DEFAULT },
  // Voice Transcription (STT) settings. Persisted nested object; see STT_DEFAULT.
  stt: { ...STT_DEFAULT },
};

const FALLBACK_ACCENT = '#7c2d2d';

// One-time migration: the Pomodoro section was merged into Pulse. Copy any
// custom Pomodoro accent into the Pulse slot if Pulse hasn't been customized,
// then drop the old key.
(function migratePomodoroAccentToPulse() {
  try {
    if (localStorage.getItem('accent_pomodoro_merged_into_pulse')) return;
    const oldVal = localStorage.getItem('accent_pomodoro_timer');
    if (oldVal && !localStorage.getItem('accent_pulse')) {
      localStorage.setItem('accent_pulse', oldVal);
    }
    localStorage.removeItem('accent_pomodoro_timer');
    localStorage.setItem('accent_pomodoro_merged_into_pulse', '1');
  } catch {}
})();

// One-time migration: 'vital_systems' was renamed to 'pulse'. If the user had
// a custom accent saved under the old key, copy it over before discarding.
(function migrateVitalSystemsToPulse() {
  try {
    if (localStorage.getItem('accent_pulse_migrated_from_vs')) return;
    const oldVal = localStorage.getItem('accent_vital_systems');
    if (oldVal && !localStorage.getItem('accent_pulse')) {
      localStorage.setItem('accent_pulse', oldVal);
    }
    localStorage.removeItem('accent_vital_systems');
    localStorage.setItem('accent_pulse_migrated_from_vs', '1');
  } catch {}
})();

// One-time migration: clear any per-page accents users hadn't customized away
// from the old bright defaults, so the new warm defaults take effect.
const OLD_ACCENT_DEFAULTS = {
  pulse:          '#27ae60',
  knowledge:      '#2980b9',
  infrastructure: '#6c5ce7',
};
(function migrateAccentPaletteV2() {
  try {
    if (localStorage.getItem('accent_palette_v2')) return;
    for (const [key, oldHex] of Object.entries(OLD_ACCENT_DEFAULTS)) {
      const cur = localStorage.getItem(`accent_${key}`);
      if (!cur || cur.toLowerCase() === oldHex.toLowerCase()) {
        localStorage.removeItem(`accent_${key}`);
      }
    }
    localStorage.setItem('accent_palette_v2', '1');
  } catch {}
})();

// v0.18.0 migration: per-animation + per-sound toggles. Maps the legacy
// single uiSounds boolean into the three host-sound keys, and reads the
// existing Pomodoro audioEnabled module setting into the two Pomodoro-sound
// keys. After migration the host sounds map is authoritative; audioEnabled
// stays on the Pomodoro module bag for backwards-compat reads but no longer
// gates audio.
(function migrateAnimationsSoundsV2() {
  try {
    if (localStorage.getItem('focus_settings_v2_animations_sounds')) return;
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    const legacyUiSounds = raw.uiSounds === true;
    let pomodoroAudio = false;
    try {
      const pomBag = raw?.modules?.pomodoro || {};
      pomodoroAudio = pomBag.audioEnabled === true;
    } catch {}
    const sounds = {
      'tactile-button-thock':  legacyUiSounds,
      'reorder-pickup-thock':  legacyUiSounds,
      'reorder-drop-thock':    legacyUiSounds,
      'timer-tick':            pomodoroAudio,
      'phase-end-chime':       pomodoroAudio,
    };
    const next = { ...raw, sounds };
    delete next.uiSounds;
    localStorage.setItem('focus_settings', JSON.stringify(next));
    localStorage.setItem('focus_settings_v2_animations_sounds', '1');
  } catch {}
})();

// Planner rename migration (Planner Overhaul epic): the pomodoro module id and
// the Tempo brand became 'planner'. Old persisted ids keep working across the
// upgrade: the module settings bag moves, dock entries remap to the new
// 'planner-timer' mini-indicator id (NOT 'planner' — that dock id belongs to
// the planner-modal opener), and the rail-variant key follows the module id.
// The 'pomodoro' literals below are deliberate legacy keys. Idempotent via the
// guard flag. Runs at first import, before module registration.
(function migratePlannerRenameV1() {
  try {
    if (localStorage.getItem('planner_rename_v1')) return;
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    let dirty = false;
    if (raw.modules && raw.modules.pomodoro) {
      if (!raw.modules.planner) raw.modules.planner = raw.modules.pomodoro;
      delete raw.modules.pomodoro;
      dirty = true;
    }
    const mapId = (id) => (id === 'pomodoro' ? 'planner-timer' : id);
    for (const key of ['order', 'hidden']) {
      const arr = raw.dock?.[key];
      if (!Array.isArray(arr)) continue;
      const next = [];
      for (const id of arr) {
        const m = mapId(id);
        if (!next.includes(m)) next.push(m);
      }
      if (JSON.stringify(next) !== JSON.stringify(arr)) {
        raw.dock[key] = next;
        dirty = true;
      }
    }
    if (dirty) localStorage.setItem('focus_settings', JSON.stringify(raw));
    const rv = localStorage.getItem('module:pomodoro:railVariant');
    if (rv != null) {
      if (localStorage.getItem('module:planner:railVariant') == null) {
        localStorage.setItem('module:planner:railVariant', rv);
      }
      localStorage.removeItem('module:pomodoro:railVariant');
    }
    localStorage.setItem('planner_rename_v1', '1');
  } catch { /* corrupt storage — boot with defaults rather than crash */ }
})();

// Agents rename migration — the Design (AI) tab became Agents: move the whole
// settings.design bag to settings.agents verbatim, unknown keys included.
// MUST run before the two design-era migrations below — they now seed
// `agents`, and the async auth-backend one would otherwise recreate a stray
// `design` bag after this rename.
(function migrateDesignToAgentsV1() {
  try {
    if (localStorage.getItem('focus_settings_v7_agents_rename')) return;
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    if (raw.design && typeof raw.design === 'object') {
      raw.agents = { ...raw.design, ...(raw.agents || {}) };
    }
    delete raw.design;
    localStorage.setItem('focus_settings', JSON.stringify(raw));
    localStorage.setItem('focus_settings_v7_agents_rename', '1');
  } catch {}
})();

// Design Mode migration: dormant settings.dev.devMode is promoted to the
// master overlay toggle (now agents.mode — the dock brush button), and the
// legacy key is dropped. Any user with devMode previously enabled gets Design
// mode pre-activated on first launch after upgrade. The v4 flag predates the
// agents rename — keep its name, or already-migrated users would re-run it.
(function migrateDevModeToDesignMode() {
  try {
    if (localStorage.getItem('focus_settings_v4_design_mode')) return;
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    const dev = { ...(raw.dev || {}) };
    const agents = { ...(raw.agents || {}) };
    if (dev.devMode === true && agents.mode === undefined) {
      agents.mode = true;
    }
    delete dev.devMode;
    const next = { ...raw, dev, agents };
    localStorage.setItem('focus_settings', JSON.stringify(next));
    localStorage.setItem('focus_settings_v4_design_mode', '1');
  } catch {}
})();

// v1.5.0 migration — auth backend default (now seeds agents.*). Pre-v1.5.0
// users had only the api-key path; on upgrade we auto-detect: if a keychain
// key is present, stay on 'api-key' (no surprise change for working setups).
// Otherwise default to 'claude-cli' so Pro/Max subscribers get the better
// path without manual opt-in. Fire-and-forget — the dispatch in
// useAgentChat.js falls back to 'api-key' while this resolves on first launch.
(async function migrateDesignAuthBackend() {
  try {
    if (localStorage.getItem('focus_settings_v5_design_auth_backend')) return;
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    const agents = { ...(raw.agents || {}) };
    if (agents.authBackend === undefined) {
      let hasKey = false;
      try { hasKey = await invoke('design_get_api_key'); } catch {}
      agents.authBackend = hasKey ? 'api-key' : 'claude-cli';
    }
    if (agents.model === undefined) agents.model = 'opus';
    if (agents.claudeCliPath === undefined) agents.claudeCliPath = '';
    const next = { ...raw, agents };
    localStorage.setItem('focus_settings', JSON.stringify(next));
    localStorage.setItem('focus_settings_v5_design_auth_backend', '1');
  } catch {}
})();

// v0.19.0 migration: drag-tile-follow boolean → enum. v0.18.0 users with
// true → 'cursor' (preserves the cursor-tracking behavior they were on);
// false → 'off' (preserves the parked-at-origin behavior); missing →
// 'slot-snap' (default for new installs and factory reset).
(function migrateDragTileEnumV3() {
  try {
    if (localStorage.getItem('focus_settings_v3_drag_tile_enum')) return;
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    const animations = { ...(raw.animations || {}) };
    const current = animations['drag-tile-follow'];
    if (current === true)       animations['drag-tile-follow'] = 'cursor';
    else if (current === false) animations['drag-tile-follow'] = 'off';
    else                        animations['drag-tile-follow'] = 'slot-snap';
    const next = { ...raw, animations };
    localStorage.setItem('focus_settings', JSON.stringify(next));
    localStorage.setItem('focus_settings_v3_drag_tile_enum', '1');
  } catch {}
})();

// Cleanup migration: the dead `appAccent` setting (former Pomodoro / music
// accent, orphaned when Pomodoro merged into Pulse) lingers in the
// focus_settings blob for upgraders. It's never read — drop it. Lives inside
// the blob, not a standalone key, so mutate the blob (don't removeItem).
(function migrateDropAppAccent() {
  try {
    if (localStorage.getItem('focus_settings_v6_drop_app_accent')) return;
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    if ('appAccent' in raw) {
      delete raw.appAccent;
      localStorage.setItem('focus_settings', JSON.stringify(raw));
    }
    localStorage.setItem('focus_settings_v6_drop_app_accent', '1');
  } catch {}
})();

const RADIUS_SCALE = {
  sharp:    { sm: 2,  md: 4,  lg: 6  },
  default:  { sm: 4,  md: 8,  lg: 12 },
  rounded:  { sm: 7,  md: 14, lg: 20 },
  pill:     { sm: 11, md: 22, lg: 32 },
};
const DENSITY_SCALE = { compact: 0.85, cozy: 1, comfortable: 1.15 };

// Candy surface-depth bucket → px. Named tiers (surfaces are conceptual depth,
// not pixel-matched to buttons). Exported for the settings UI; the actual token
// swap lives in styles.css body[data-surface-depth] rules.
export const SURFACE_DEPTH_SCALE = {
  off: 0, low: 2, medium: 4, high: 7,
};

// Font family registry (Settings → Appearance → Fonts). A key maps to a CSS
// font-stack; settings persist the KEY (stable across font renames) and the
// CSS-var useEffect resolves it onto --font-body / -heading / -mono / -candy.
// woff2 files live in web/public/fonts and are @font-face'd in web/src/fonts.css.
// SANS_OPTIONS feeds the Body / Heading / Candy pickers; MONO_OPTIONS feeds Mono.
export const FONT_OPTIONS = {
  'dm-sans':        { stack: "'DM Sans', sans-serif",                      label: 'DM Sans' },
  'inter':          { stack: "'Inter', sans-serif",                        label: 'Inter' },
  'ibm-plex-sans':  { stack: "'IBM Plex Sans', sans-serif",                label: 'IBM Plex Sans' },
  'dm-mono':        { stack: "'DM Mono', ui-monospace, monospace",         label: 'DM Mono' },
  'jetbrains-mono': { stack: "'JetBrains Mono', ui-monospace, monospace",  label: 'JetBrains Mono' },
  'ibm-plex-mono':  { stack: "'IBM Plex Mono', ui-monospace, monospace",   label: 'IBM Plex Mono' },
};
export const SANS_OPTIONS = [
  { value: 'dm-sans',       label: 'DM Sans' },
  { value: 'inter',         label: 'Inter' },
  { value: 'ibm-plex-sans', label: 'IBM Plex Sans' },
];
export const MONO_OPTIONS = [
  { value: 'dm-mono',         label: 'DM Mono' },
  { value: 'jetbrains-mono',  label: 'JetBrains Mono' },
  { value: 'ibm-plex-mono',   label: 'IBM Plex Mono' },
];

function loadGlobalSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    // Strip any legacy top-level accentColor from the blob — accent is the themed global accent now (themeAccent), never a persisted top-level key.
    // `design` is likewise stripped: the pre-rename agents bag (e.g. from a
    // restored backup) must not leak through ...rest as a ghost key.
    const { accentColor, design, animations, sounds, dev, dock, agents, downloads, keybinds, stt, ...rest } = raw;
    return {
      ...SETTINGS_DEFAULTS,
      ...rest,
      animations: { ...ANIMATIONS_DEFAULT, ...(animations || {}) },
      sounds:     { ...SOUNDS_DEFAULT,     ...(sounds     || {}) },
      dev:        { ...DEV_DEFAULT,        ...(dev        || {}) },
      dock:       { ...DOCK_DEFAULT,       ...(dock       || {}) },
      agents:     { ...AGENTS_DEFAULT,     ...(agents     || {}) },
      downloads:  { ...DOWNLOADS_DEFAULT,  ...(downloads  || {}) },
      keybinds:   { ...KEYBINDS_DEFAULT,   ...(keybinds   || {}) },
      stt:        { ...STT_DEFAULT,        ...(stt        || {}) },
    };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

// Broadcast so every live useSettings() instance — and the #/player popout
// window — re-reads when any instance writes. Without this, each useSettings()
// holds a private localStorage snapshot taken at mount and never re-syncs (the
// always-mounted PlannerProvider would keep showing stale times after a
// Time-format toggle). Mirrors useSidebarGroupMode's window-event pattern.
const GLOBAL_SETTINGS_EVENT = 'focus-global-settings-changed';
function emitGlobalSettingsChange() {
  try { window.dispatchEvent(new CustomEvent(GLOBAL_SETTINGS_EVENT)); } catch {}
}

function persistGlobalSettings(s) {
  try {
    localStorage.setItem('focus_settings', JSON.stringify(s));
    // Defer past React's commit so the dispatch can't trigger a consumer
    // setState mid-render (this runs inside a setGlobalSettings updater).
    queueMicrotask(emitGlobalSettingsChange);
  } catch {}
}

// The single global accent that drives --accent. Every theme — including
// Monastic — carries one default accent (registry defaultAccent); the user's
// override lives in `themeAccent` and is re-seeded to the new theme's default on
// every theme switch. Accent is one value app-wide (per-page accents retired).
export function resolveActiveAccent(settings) {
  return settings.themeAccent
    || THEME_BY_ID[settings.themePreset]?.defaultAccent
    || FALLBACK_ACCENT;
}

function useResolvedTheme(themeMode) {
  const getMatch = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const [systemDark, setSystemDark] = useState(getMatch);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const handler = e => setSystemDark(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);
  if (themeMode === 'system') return systemDark ? 'dark' : 'light';
  return themeMode;
}

export function useSettings(pageKey = 'pulse') {
  const [globalSettings, setGlobalSettings] = useState(() => loadGlobalSettings());
  const [accent, setAccentState] = useState(() => resolveActiveAccent(globalSettings));
  // Transient hover-preview accent (ThemePicker). Non-persisted; overlays the
  // committed accent in the returned `settings` so EVERY accent consumer — JS-prop
  // (TabButton, color-mix strings) and CSS var(--accent) alike — previews a theme
  // on hover, then clears on leave/commit. null = no preview (show committed).
  const [previewAccent, setPreviewAccent] = useState(null);

  // Recompute when the active preset or the global themeAccent changes. Accent
  // is one global value per theme now — page changes never move it.
  useEffect(() => {
    setAccentState(resolveActiveAccent(globalSettings));
  }, [globalSettings.themePreset, globalSettings.themeAccent]);

  // Re-sync this instance when any other useSettings() instance (or another
  // window) writes the focus_settings blob, so changes reach already-mounted
  // consumers without a restart. The 'storage' arm covers the #/player popout;
  // the CustomEvent arm covers same-window cross-instance writes.
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

  // Mirror keybinds into the registry's live view so non-React consumers
  // (module keydown handlers) resolve rebinds at event time.
  useEffect(() => {
    publishKeybinds(globalSettings.keybinds);
  }, [globalSettings.keybinds]);

  const setSetting = useCallback((key, val) => {
    const edits = typeof key === 'object' ? key : { [key]: val };
    if ('accentColor' in edits) {
      const hex = edits.accentColor;
      // eslint-disable-next-line no-unused-vars
      const { accentColor, ...rest } = edits;
      setAccentState(hex);
      // Accent is one global value per theme → always write the global themeAccent.
      setGlobalSettings(prev => {
        const next = { ...prev, themeAccent: hex, ...rest };
        persistGlobalSettings(next);
        return next;
      });
      return;
    }
    setGlobalSettings(prev => {
      // Deep-merge animations + sounds + dev bags so partial patches don't
      // drop keys. Auto-recompute preset slugs from the resulting bag so the
      // preset chip in the UI snaps to 'custom' when the user manually
      // toggles a row.
      const next = { ...prev, ...edits };
      if ('animations' in edits && edits.animations && typeof edits.animations === 'object') {
        next.animations = { ...prev.animations, ...edits.animations };
        if (!('animationsPreset' in edits)) {
          next.animationsPreset = inferAnimationPreset(next.animations);
        }
      }
      if ('sounds' in edits && edits.sounds && typeof edits.sounds === 'object') {
        next.sounds = { ...prev.sounds, ...edits.sounds };
        if (!('soundsPreset' in edits)) {
          next.soundsPreset = inferSoundPreset(next.sounds);
        }
      }
      if ('dev' in edits && edits.dev && typeof edits.dev === 'object') {
        next.dev = { ...prev.dev, ...edits.dev };
      }
      if ('dock' in edits && edits.dock && typeof edits.dock === 'object') {
        next.dock = { ...prev.dock, ...edits.dock };
      }
      if ('agents' in edits && edits.agents && typeof edits.agents === 'object') {
        next.agents = { ...prev.agents, ...edits.agents };
      }
      if ('downloads' in edits && edits.downloads && typeof edits.downloads === 'object') {
        next.downloads = { ...prev.downloads, ...edits.downloads };
      }
      if ('keybinds' in edits && edits.keybinds && typeof edits.keybinds === 'object') {
        next.keybinds = { ...prev.keybinds, ...edits.keybinds };
      }
      if ('stt' in edits && edits.stt && typeof edits.stt === 'object') {
        next.stt = { ...prev.stt, ...edits.stt };
      }
      // Re-seed the global accent to the new theme's default on every theme
      // switch (including Monastic), unless the caller set themeAccent too.
      if ('themePreset' in edits && !('themeAccent' in edits)
          && next.themePreset !== prev.themePreset) {
        next.themeAccent = THEME_BY_ID[next.themePreset]?.defaultAccent || next.themeAccent;
      }
      persistGlobalSettings(next);
      if ('sidebarGroupMode' in edits) emitSidebarGroupModeChange();
      return next;
    });
  }, [pageKey, globalSettings.themePreset]);

  const resetSettings = useCallback((keys) => {
    setGlobalSettings(prev => {
      let next;
      if (Array.isArray(keys) && keys.length > 0) {
        next = { ...prev };
        for (const k of keys) {
          if (k in SETTINGS_DEFAULTS) next[k] = SETTINGS_DEFAULTS[k];
        }
      } else {
        next = { ...SETTINGS_DEFAULTS };
      }
      persistGlobalSettings(next);
      return next;
    });
    // Accent re-derives from the reset settings via the accent effect
    // (themeAccent returns to its Monastic default), so no explicit reset here.
  }, []);

  const resolvedTheme = useResolvedTheme(globalSettings.themeMode);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    // Expose the active preset so theme-conditional CSS (e.g. the dock reskin)
    // can target community themes without JS. Always set, including 'monastic'.
    root.dataset.themePreset = globalSettings.themePreset || DEFAULT_THEME_ID;
    const density = DENSITY_SCALE[globalSettings.density] || 1;
    root.style.setProperty('--density', String(density));
    root.style.setProperty('--space-scale', String(density));
    const r = RADIUS_SCALE[globalSettings.radiusScale] || RADIUS_SCALE.default;
    root.style.setProperty('--radius-sm', r.sm + 'px');
    root.style.setProperty('--radius-md', r.md + 'px');
    root.style.setProperty('--radius-lg', r.lg + 'px');
    // Font families — resolve each setting key to a CSS stack via FONT_OPTIONS.
    // The ?? fallback covers a persisted key that's missing or renamed.
    root.style.setProperty('--font-body',    FONT_OPTIONS[globalSettings.fontBody]?.stack    ?? FONT_OPTIONS['dm-sans'].stack);
    root.style.setProperty('--font-heading', FONT_OPTIONS[globalSettings.fontHeading]?.stack ?? FONT_OPTIONS['dm-sans'].stack);
    root.style.setProperty('--font-mono',    FONT_OPTIONS[globalSettings.fontMono]?.stack    ?? FONT_OPTIONS['dm-mono'].stack);
    root.style.setProperty('--font-candy',   FONT_OPTIONS[globalSettings.fontCandy]?.stack   ?? FONT_OPTIONS['dm-sans'].stack);
    // Paint accent from live settings (sync) rather than the `accent` state
    // (which lags a tick) so committing a theme can't flash the old accent.
    root.style.setProperty('--accent', resolveActiveAccent(globalSettings));
    // Layer the active preset's colour-token overrides on top of the CSS base,
    // keyed off the resolved light/dark variant. Monastic = null maps → every
    // key is removed and the styles.css `:root` base re-shows. Reusing this one
    // effect means the light↔dark toggle auto-re-picks the correct variant.
    paintTheme(root, THEME_BY_ID[globalSettings.themePreset] || THEME_BY_ID[DEFAULT_THEME_ID], resolvedTheme);
  }, [resolvedTheme, globalSettings.density, globalSettings.radiusScale,
      globalSettings.themePreset, globalSettings.themeAccent,
      globalSettings.fontBody, globalSettings.fontHeading, globalSettings.fontMono, globalSettings.fontCandy]);

  // Push per-animation toggles onto body data-attrs so the matching CSS
  // rules in styles.css (§ Settings gating) can disable keyframes /
  // transitions without component churn. JS-driven animations (confetti,
  // ripple, spring-press transform, drag clone tracking) read the bag
  // directly through useSettings.
  useEffect(() => {
    const body = document.body;
    if (!body) return;
    for (const key of ANIMATION_KEYS) {
      const val = globalSettings.animations[key];
      if (ANIMATION_KEY_CONFIG[key]) {
        body.setAttribute(`data-anim-${key}`, String(val ?? defaultAnimationValue(key)));
      } else {
        body.setAttribute(`data-anim-${key}`, val !== false ? 'on' : 'off');
      }
    }
  }, [globalSettings.animations]);

  // Candy-button hover press strength. Drives body[data-hover-press] which
  // styles.css uses to redeclare --candy-depth-hover-* tokens at 100/75/50/
  // 25/off levels (with matching small variant tokens for circles + small
  // squares). See § Candy depth — hover press scale in styles.css.
  useEffect(() => {
    const body = document.body;
    if (!body) return;
    body.setAttribute('data-hover-press', globalSettings.hoverPressIntensity || '50');
  }, [globalSettings.hoverPressIntensity]);

  // Candy-button rest depth, per category. data-large-depth controls pills +
  // rectangles via --candy-depth; data-small-depth controls circles + small
  // squares via --candy-depth-small. See § Candy depth — per-category in
  // styles.css.
  useEffect(() => {
    const body = document.body;
    if (!body) return;
    body.setAttribute('data-large-depth', globalSettings.largeButtonDepth || '7');
    body.setAttribute('data-small-depth', globalSettings.smallButtonDepth || '5');
  }, [globalSettings.largeButtonDepth, globalSettings.smallButtonDepth]);

  // Music tile candy wrap depth bucket. 'large' → inherits --candy-depth;
  // 'small' → .music-tile rule swaps in --candy-depth-small. See
  // § Music tile candy wrap in styles.css.
  useEffect(() => {
    const body = document.body;
    if (!body) return;
    body.setAttribute('data-music-tile-depth', globalSettings.musicTileDepth || 'large');
  }, [globalSettings.musicTileDepth]);

  // Candy surface depth bucket. data-surface-depth drives --candy-surface-depth
  // (the static shadow band under the .candy-* container family). Mirrors the
  // button depth effects above but is independent — containers don't translate.
  // See § Candy depth — surface (container) picker in styles.css.
  useEffect(() => {
    const body = document.body;
    if (!body) return;
    body.setAttribute('data-surface-depth', globalSettings.surfaceDepth || 'medium');
  }, [globalSettings.surfaceDepth]);

  // Page transition variant. data-page-tx-style drives which enter keyframes
  // play on route change (styles.css § Page transitions). On/off is the separate
  // `page-transitions` bucket (data-anim-page-transitions); style is independent.
  useEffect(() => {
    const body = document.body;
    if (!body) return;
    body.setAttribute('data-page-tx-style', globalSettings.pageTransitionStyle || 'candy');
  }, [globalSettings.pageTransitionStyle]);

  // Sidebar background texture motif. data-sidebar-pattern on :root selects the
  // active pure-CSS gradient motif (styles.css § Sidebar background pattern).
  // Set on documentElement (not body) so the :root[data-…] selectors match.
  useEffect(() => {
    document.documentElement.setAttribute('data-sidebar-pattern', globalSettings.sidebarPattern || 'grid');
  }, [globalSettings.sidebarPattern]);

  // Smooth mouse-wheel scrolling level → util/smoothWheel.js. Unlike the body
  // data-attr effects above, this pushes to a module config since the easing
  // runs in a plain util (not CSS). 'off' restores native wheel scrolling.
  useEffect(() => {
    setSmoothness(globalSettings.scrollSmoothness || 'medium');
  }, [globalSettings.scrollSmoothness]);

  const settings = { ...globalSettings, accentColor: previewAccent ?? accent };
  return { settings, setSetting, setPreviewAccent, resetSettings, resolvedTheme };
}

// Module-namespaced settings hook. Reads/writes settings.modules.<moduleId>.<key>
// in the `focus_settings` localStorage blob. Re-renders when `api.settings.set`
// emits `settings:change` from anywhere in the app.
export function useModuleSettings(moduleId) {
  const [version, bump] = useState(0);

  useEffect(() => {
    return sharedEvents.on('settings:change', ({ moduleId: changed }) => {
      if (changed === moduleId) bump(v => v + 1);
    });
  }, [moduleId]);

  const settings = useMemo(() => readModuleBag(moduleId), [moduleId, version]);

  const setSetting = useCallback((key, value) => {
    writeModuleSetting(moduleId, key, value);
    sharedEvents.emit('settings:change', { moduleId, key, value });
  }, [moduleId]);

  return { settings, setSetting };
}

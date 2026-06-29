// Single source of truth for Settings-drawer navigation: tab sub-tab strips,
// module-page strips, legacy deep-link aliases, and the {tab, page, section}
// address helpers. The drawer owns the live address; everything else (deep
// links, search jumps, context-aware open, scoped reset) speaks this shape.
//
// Address: { tab, page, section }
//   tab     top-level rail id ('appearance' | 'modules' | …)
//   page    module id, only under tab:'modules'; null elsewhere
//   section sub-tab id within a tab strip or module page; null when the
//           surface has no strip
// String form: 'system/downloads' | 'modules/browser/vault' — segment 2 is a
// page only under 'modules'.

// Per-tab sub-tab strips. Filled in as each tab gains its strip; tabs absent
// here render flat content with section: null.
export const TAB_SECTIONS = {
  navigation: {
    default: 'dock',
    sections: [
      { id: 'dock',    label: 'Dock' },
      { id: 'left',    label: 'Left Sidebar' },
      { id: 'right',   label: 'Right Sidebar' },
      { id: 'general', label: 'General' },
    ],
  },
  system: {
    default: 'system',
    sections: [
      { id: 'system',    label: 'System' },
      { id: 'downloads', label: 'Downloads' },
      { id: 'recycle',   label: 'Recycling Bin' },
    ],
  },
  modules: {
    default: 'core',
    sections: [
      { id: 'core',      label: 'Core' },
      { id: 'studio',    label: 'Studio' },
      { id: 'widget',    label: 'Widget' },
      { id: 'tools',     label: 'Tools' },
      { id: 'community', label: 'Community' },
    ],
  },
  agents: {
    default: 'general',
    sections: [
      { id: 'general',     label: 'General' },
      { id: 'atelier',     label: 'Atelier' },
      { id: 'concierge',   label: 'Concierge' },
    ],
  },
  // Releases tab sections ARE Area names (free-form, module-less subset built
  // live in ReleasesTab from the manifest registry), so the strip is dynamic.
  // Only a landing default is needed here; 'General' is always module-less.
  releases: { default: 'General', sections: [] },
};

// Per-module-page strips, keyed by module id (browser is the first consumer).
export const PAGE_SECTIONS = {
  browser: {
    default: 'adblock',
    sections: [
      { id: 'adblock', label: 'AD Blocker' },
      { id: 'data',    label: 'Browsing Data' },
      { id: 'vault',   label: 'Password Vault' },
      { id: 'sidebar', label: 'Browser Sidebar' },
    ],
  },
  // The 'video-settings' legacy alias lands here with section:null → 'anime',
  // so pre-strip deep links keep resolving to the old (Anime) content.
  library: {
    default: 'anime',
    sections: [
      { id: 'anime', label: 'Anime' },
      { id: 'music', label: 'Music' },
    ],
  },
};

// Old rail-tab ids → addresses, so every pre-rework `host:open-settings`
// payload keeps landing after its tab retires. Entries activate in the
// sub-feature that removes the tab — an alias must never point at a tab
// that doesn't exist yet.
export const LEGACY_TAB_ALIASES = {
  'downloads':       { tab: 'system',  page: null,             section: 'downloads' },
  'browser-shield':  { tab: 'modules', page: 'browser',        section: null },
  'planner':         { tab: 'modules', page: 'planner',        section: null },
  'video-settings':  { tab: 'modules', page: 'library',        section: null },
  'skills-browser':  { tab: 'modules', page: 'skills-browser', section: null },
  'pulse':           { tab: 'modules', page: 'pulse',          section: null },
  'design':          { tab: 'agents',  page: null,             section: null },
};

// Fill section from the strip defaults when unspecified.
export function withDefaults(addr) {
  if (!addr?.tab) return { tab: 'appearance', page: null, section: null };
  const page = addr.page ?? null;
  const section = addr.section
    ?? (page ? PAGE_SECTIONS[page]?.default : TAB_SECTIONS[addr.tab]?.default)
    ?? null;
  return { tab: addr.tab, page, section };
}

// Accept a path string, an address object, or a legacy {tab: oldId} payload.
// Returns a full address, or null when the input names no known tab (the
// caller falls back to its own default).
export function normalizeAddress(input, validTabIds) {
  if (!input) return null;
  let a = input;
  if (typeof a === 'string') {
    const [tab, seg2, seg3] = a.split('/').filter(Boolean);
    a = tab === 'modules' && seg2
      ? { tab, page: seg2, section: seg3 ?? null }
      : { tab, page: null, section: seg2 ?? null };
  }
  if (a.tab && LEGACY_TAB_ALIASES[a.tab]) a = LEGACY_TAB_ALIASES[a.tab];
  if (!a.tab) return null;
  if (validTabIds && !validTabIds.has(a.tab)) return null;
  return withDefaults(a);
}

// Exclusive tier homes. A module with no app surface beyond its widget
// (no route / left-sidebar / overlay) counts as a standalone widget.
// Lives here (not ModulesTab) so resolveOpenAddress can bucket card-flash
// targets without importing a component.
export function tierOf(m) {
  if (m.tier === 'studio') return 'studio';
  const slots = m.slots || [];
  const hasAppSurface = slots.some(s => s === 'route' || s === 'left-sidebar' || s === 'overlay');
  if (slots.includes('widget') && !hasAppSurface) return 'widget';
  return 'core';
}

// Route-specific overrides that beat manifest routeBase matching — for
// surfaces whose settings home is a host TAB rather than a module page
// (generic matching can only land on Modules). /pulse/calendar needs no
// entry: planner's own routeBase IS /pulse/calendar, so longest-match wins.
const ROUTE_OVERRIDES = [
  { base: '/vault', addr: { tab: 'vaults' } }, // vault module configures on the Vaults tab
];

// Context-aware open: resolve the landing address for a context-less open
// (no explicit deep link) from the current hash route. Route overrides →
// longest enabled routeBase boundary-prefix → module settings page, or the
// Modules tab with the module's card flagged for scroll+flash. Returns
// { addr, highlight? } or null (caller falls back to lastTab + search focus).
export function resolveOpenAddress({ route, manifests, enabledMap, hasPage }) {
  if (!route) return null;
  const matches = (base) => route === base || route.startsWith(base + '/');
  for (const o of ROUTE_OVERRIDES) {
    if (matches(o.base)) return { addr: withDefaults(o.addr) };
  }
  let best = null;
  for (const m of Object.values(manifests || {})) {
    if (typeof m?.routeBase !== 'string' || !m.routeBase) continue;
    if (enabledMap && enabledMap[m.id] === false) continue;
    if (!matches(m.routeBase)) continue;
    if (!best || m.routeBase.length > best.routeBase.length) best = m;
  }
  if (!best) return null;
  if (hasPage?.(best.id)) return { addr: withDefaults({ tab: 'modules', page: best.id }) };
  return { addr: withDefaults({ tab: 'modules', section: tierOf(best) }), highlight: best.id };
}

// Scoped reset: what the footer Reset button restores for each visible
// surface, keyed 'tab' or 'tab/section'. `keys` resets top-level settings
// keys via resetSettings; `bag`+`fields` resets a subset of a nested bag via
// setSetting (resetSettings only handles whole top-level keys). Surfaces
// without an entry (module pages, keybinds, vaults, dev, placeholders)
// disable the footer Reset — their state isn't plain settings keys.
export const RESET_SCOPES = {
  'appearance':         { label: 'Appearance', keys: ['themeMode', 'themePreset', 'themeAccent', 'density', 'radiusScale', 'animations', 'animationsPreset', 'scrollSmoothness', 'previewFollowDrag', 'hoverPressIntensity', 'largeButtonDepth', 'smallButtonDepth', 'musicTileDepth', 'surfaceDepth', 'sidebarPattern', 'fontBody', 'fontHeading', 'fontMono', 'fontCandy'] },
  'sounds':             { label: 'Sounds', keys: ['sounds', 'soundsPreset'] },
  'navigation/dock':    { label: 'Navigation › Dock', keys: ['dock'] },
  'navigation/left':    { label: 'Navigation › Left Sidebar', keys: ['sidebarGroupMode', 'vaultTreeReveal', 'vaultTreeSuffix'] },
  'navigation/general': { label: 'Navigation › General', bag: 'animations', fields: ['flyout', 'section-accordion', 'page-transitions', 'pulse-indicators', 'drag-tile-follow', 'drag-tile-smoothness', 'drag-drop-glide'] },
  // The agents bag interleaves (mode / auth / drag tuning), so both real
  // sub-tabs reset the whole bag; the Vault Agent placeholder resets nothing.
  'agents/general':     { label: 'Agents', keys: ['agents'] },
  'agents/atelier':     { label: 'Agents', keys: ['agents'] },
  'system/system':      { label: 'System', bag: 'dev', fields: ['autoCheckUpdates', 'updatePollInterval'] },
  'system/downloads':   { label: 'System › Downloads', keys: ['downloads'] },
  'system/recycle':     { label: 'System › Recycling Bin', keys: ['recycleBinMaxItems', 'recycleBinRetentionDays'] },
};

export function scopeFor(addr) {
  if (!addr?.tab || addr.page) return null; // module pages: bags hold non-setting state
  return RESET_SCOPES[addr.section ? `${addr.tab}/${addr.section}` : addr.tab] || null;
}

// Any key/field in the scope differing from factory defaults → the strip
// tile shows a modified dot. Bags compare structurally (loadGlobalSettings
// rebuilds them defaults-first, so key order is stable).
export function scopeModified(scope, settings, defaults) {
  if (!scope || !settings || !defaults) return false;
  const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (scope.bag) return scope.fields.some(f => !eq(settings[scope.bag]?.[f], defaults[scope.bag]?.[f]));
  return scope.keys.some(k => !eq(settings[k], defaults[k]));
}

// Last-visited top-level tab — the fallback target for context-less opens.
const LAST_TAB_KEY = 'settings:lastTab';

export function readLastTab() {
  try { return localStorage.getItem(LAST_TAB_KEY) || null; } catch { return null; }
}

export function writeLastTab(tab) {
  try { localStorage.setItem(LAST_TAB_KEY, tab); } catch {}
}

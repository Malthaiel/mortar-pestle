const _leftSidebar = new Map();
const _widgets = new Map();
const _settingsTab = new Map();
const _pageSidebar = new Map();   // keyed by pageKey (route.page) — non-module page sidebars
const _routes = [];
const _providers = [];
const _overlays = [];
const _redirects = [];
let _manifests = {};

const _subscribers = new Set();

function computeSnapshot() {
  return {
    leftSidebar: [..._leftSidebar.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    widgets: [..._widgets.values()].sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0)),
    settingsTab: [..._settingsTab.values()],
    pageSidebar: Object.fromEntries(_pageSidebar),
    routes: [..._routes],
    providers: [..._providers],
    overlays: [..._overlays],
    redirects: [..._redirects],
    manifests: _manifests,
  };
}

let _snapshot = computeSnapshot();

function notify() {
  _snapshot = computeSnapshot();
  _subscribers.forEach(fn => fn());
}

export function subscribe(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

export function getSnapshot() {
  return _snapshot;
}

function requireId(moduleId, slot, id) {
  if (typeof id !== 'string' || !id) {
    throw new Error(`[${moduleId}] ${slot} slot requires a string id`);
  }
}

function rejectDuplicate(moduleId, slot, map, id) {
  if (map.has(id)) {
    const prev = map.get(id);
    throw new Error(
      `[${moduleId}] duplicate ${slot} slot id "${id}" (already registered by [${prev.moduleId}])`
    );
  }
}

export function registerLeftSidebar(moduleId, { id, render, isActive, renderSecondary, renderRail, order } = {}) {
  requireId(moduleId, 'left-sidebar', id);
  rejectDuplicate(moduleId, 'left-sidebar', _leftSidebar, id);
  _leftSidebar.set(id, { moduleId, id, render, isActive, renderSecondary, renderRail, order });
  notify();
}

// Non-module page sidebars. A routed page (not a module) can claim the left
// sidebar for its own route by registering renderSecondary (and optionally a
// renderRail + label for the collapsed rail). Keyed by pageKey = route.page;
// Sidebar.jsx resolves the current route's page sidebar with priority over the
// active module, so leaving the route restores the module automatically.
export function registerPageSidebar(pageKey, { label, renderSecondary, renderRail } = {}) {
  if (typeof pageKey !== 'string' || !pageKey) throw new Error('registerPageSidebar requires a string pageKey');
  if (_pageSidebar.has(pageKey)) throw new Error(`duplicate page-sidebar "${pageKey}"`);
  _pageSidebar.set(pageKey, { pageKey, label, renderSecondary, renderRail });
  notify();
}

export function registerWidget(moduleId, { id, render, weight, flexWeight, renderRail, railVariants } = {}) {
  requireId(moduleId, 'widget', id);
  rejectDuplicate(moduleId, 'widget', _widgets, id);
  _widgets.set(id, { moduleId, id, render, weight, flexWeight, renderRail, railVariants });
  notify();
}

export function registerSettingsTab(moduleId, { id, label, render } = {}) {
  requireId(moduleId, 'settings-tab', id);
  rejectDuplicate(moduleId, 'settings-tab', _settingsTab, id);
  _settingsTab.set(id, { moduleId, id, label, render });
  notify();
}

export function registerRoute(moduleId, { match, render } = {}) {
  if (typeof match !== 'function') throw new Error(`[${moduleId}] route slot requires a match function`);
  if (typeof render !== 'function') throw new Error(`[${moduleId}] route slot requires a render function`);
  _routes.push({ moduleId, match, render });
  notify();
}

export function registerProvider(moduleId, Component) {
  if (typeof Component !== 'function') throw new Error(`[${moduleId}] provider slot requires a Component`);
  _providers.push({ moduleId, Component });
  notify();
}

export function registerOverlay(moduleId, Component) {
  if (typeof Component !== 'function') throw new Error(`[${moduleId}] overlay slot requires a Component`);
  _overlays.push({ moduleId, Component });
  notify();
}

export function setManifests(map) {
  _manifests = { ...map };
  notify();
}

export function registerRedirect(moduleId, fromPattern, toFn) {
  const okFrom = typeof fromPattern === 'string' || fromPattern instanceof RegExp;
  if (!okFrom) {
    throw new Error(`[${moduleId}] registerRedirect: fromPattern must be a string prefix or RegExp`);
  }
  if (typeof toFn !== 'function') {
    throw new Error(`[${moduleId}] registerRedirect: toFn must be a function returning string | null`);
  }
  _redirects.push({ moduleId, fromPattern, toFn });
  notify();
}

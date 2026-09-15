// Context-backed selection store for the dock-driven sidebar — owns which
// module's renderSecondary mounts in the left sidebar's body. Selection lives
// in localStorage (`dock:active-module:v1`) so it survives reload.
//
// Wrap the app tree in <ActiveModuleProvider/>; consume via useActiveModule().
// Both Sidebar (SF3) and the dock module buttons (SF5) read the same state.
//
// Reconciles three signals:
//   1. Persisted selection (last clicked or the user's specific default).
//   2. Current hash route — when nav-sync is "auto", route changes outside
//      the active module's routeBase update selection silently.
//   3. Enabled-module map — if the active module gets disabled via the
//      Modules settings tab, selection demotes to the default.
//
// Behavior toggles (all in settings.dock.modules):
//   - defaultMode:     'last' | 'specific'
//   - defaultModule:   moduleId (used when defaultMode = 'specific')
//   - clickBehavior:   'navigate-and-swap' | 'swap-only'
//   - navSync:         'auto' | 'sticky'
//
// Exposed API:
//   { activeModuleId, activeModule, setActiveModule(id, { source }),
//     settings, setters }
//
// Source values for setActiveModule:
//   - 'dock-click'  — user clicked a module button in the dock. Honors
//                     clickBehavior; if 'navigate-and-swap', navigates to
//                     the module's routeBase.
//   - 'route-change' — route reconciliation set this; no navigation.
//   - 'init'         — boot-time selection; no navigation.
//   - 'deselect'     — explicit null (e.g. brand-pill click in active mode).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useManifests } from '../module-sdk/useModuleRegistry.js';
import { useModuleEnabledMap } from './useModuleEnabled.js';
import { useHashRoute, navigate, safeDecode } from '../router.js';
import { recordRoute, lastRoute, lastRouteFor, moduleKeyFor } from '../util/pageMemory.js';
import { api } from '../api.js';
import { DOCK_DEFAULT } from './useSettings.js';
import { isPopoutWindow } from '../util/popout.js';

const STORAGE_KEY = 'dock:active-module:v1';
const SIDEBAR_EXPANDED_STORAGE_KEY = 'sidebar:expanded:v1';
const FIRST_LAUNCH_FALLBACK = 'pulse';

function readBag(dockModules, key) {
  if (dockModules && dockModules[key] !== undefined) return dockModules[key];
  return DOCK_DEFAULT.modules[key];
}

function readPersisted() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch { return null; }
}

function writePersisted(value) {
  // A module pop-out window shares this localStorage key with the main window.
  // Without this guard, popping out Terminal rewrites which module the MAIN
  // window boots into next launch. See util/popout.js.
  if (isPopoutWindow()) return;
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, String(value));
    }
  } catch {}
}

// Sidebar expand/collapse is a separate concern from module selection — the
// brand-pill toggle only flips this boolean. Persisted across reloads.
// Default true (expanded) for new installs.
function readSidebarExpandedPersisted() {
  try {
    const v = localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY);
    if (v === null) return true;
    return v === 'true';
  } catch { return true; }
}

function writeSidebarExpandedPersisted(value) {
  try { localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, String(!!value)); } catch {}
}

function isLeftSidebarManifest(manifest) {
  return !!manifest
    && Array.isArray(manifest.slots)
    && manifest.slots.includes('left-sidebar')
    && typeof manifest.routeBase === 'string';
}

function isEnabled(enabledMap, id) {
  return enabledMap[id] !== false;
}

function routeMatchesModule(routePath, manifest) {
  if (!manifest || typeof manifest.routeBase !== 'string') return false;
  const base = manifest.routeBase;
  return routePath === base || routePath.startsWith(base + '/');
}

function pickFallback(manifests, enabledMap, settingsModules) {
  const mode = readBag(settingsModules, 'defaultMode');
  const specific = readBag(settingsModules, 'defaultModule');
  const candidates = [];
  if (mode === 'specific' && specific) candidates.push(specific);
  candidates.push(FIRST_LAUNCH_FALLBACK);
  for (const id of candidates) {
    const m = manifests[id];
    if (m && isLeftSidebarManifest(m) && isEnabled(enabledMap, id)) return id;
  }
  for (const m of Object.values(manifests)) {
    if (isLeftSidebarManifest(m) && isEnabled(enabledMap, m.id)) return m.id;
  }
  return null;
}

const ActiveModuleContext = createContext(null);

export function ActiveModuleProvider({ settings, setSetting, children }) {
  const manifests = useManifests();
  const enabledMap = useModuleEnabledMap();
  const route = useHashRoute();
  const dockModules = settings?.dock?.modules || DOCK_DEFAULT.modules;

  const [activeModuleId, setActiveModuleIdState] = useState(() => readPersisted());
  const [sidebarExpanded, setSidebarExpandedState] = useState(readSidebarExpandedPersisted);

  useEffect(() => {
    if (activeModuleId) {
      const m = manifests[activeModuleId];
      if (m && isLeftSidebarManifest(m) && isEnabled(enabledMap, activeModuleId)) return;
    }
    const fallback = pickFallback(manifests, enabledMap, dockModules);
    if (fallback !== activeModuleId) {
      setActiveModuleIdState(fallback);
      writePersisted(fallback);
    }
  }, [manifests, enabledMap, dockModules?.defaultMode, dockModules?.defaultModule]);

  // navSync auto-route effect — fires only on route change. activeModuleId is
  // read through a ref so explicit deselects (brand-pill click → null) don't
  // immediately re-trigger this and re-select the route's module. On a real
  // route change the effect fires and reconciles per the user's setting.
  const activeModuleIdRef = useRef(activeModuleId);
  useEffect(() => { activeModuleIdRef.current = activeModuleId; });

  useEffect(() => {
    if (readBag(dockModules, 'navSync') !== 'auto') return;
    if (!route?.path) return;
    const currentId = activeModuleIdRef.current;
    const activeManifest = currentId ? manifests[currentId] : null;
    if (activeManifest && routeMatchesModule(route.path, activeManifest)) return;
    let best = null;
    for (const m of Object.values(manifests)) {
      if (!isLeftSidebarManifest(m)) continue;
      if (!isEnabled(enabledMap, m.id)) continue;
      if (!routeMatchesModule(route.path, m)) continue;
      if (!best || m.routeBase.length > best.routeBase.length) best = m;
    }
    if (best && best.id !== currentId) {
      setActiveModuleIdState(best.id);
      writePersisted(best.id);
    }
  }, [route?.path, dockModules, manifests, enabledMap]);

  // ── Page memory (util/pageMemory.js) ───────────────────────────────────────
  // Record every route, keyed by the module that owns it. Feeds two restores:
  // the dock buttons below, and the boot restore after that.
  const sidebarBases = useMemo(
    () => Object.values(manifests).filter(isLeftSidebarManifest).map(m => m.routeBase),
    [manifests],
  );

  // Startup emits a transient route of its own (measured 2026-08-13: `/vault` at
  // 984 ms, 46 ms before the boot restore landed on the real page). Recording it
  // is a race the wrong value can win — and when it wins it overwrites that
  // module's remembered deep page with its bare routeBase. So nothing is
  // recorded until the boot decision below has resolved.
  const bootSettledRef = useRef(false);
  useEffect(() => {
    if (!bootSettledRef.current) return;
    if (!route?.path || route.path === '/') return;
    recordRoute(route.path, moduleKeyFor(route.path, sidebarBases));
  }, [route?.path, sidebarBases]);

  // Boot restore — an empty hash is a fresh launch, so land on the page we left.
  // Waits for the manifests: they decide whether the remembered page's module
  // still exists and is enabled. Runs once (a deep-link in wins over memory).
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    // Deep-linked in (or HMR remount): memory doesn't apply, so recording starts
    // immediately.
    if (route?.path && route.path !== '/') { bootedRef.current = true; bootSettledRef.current = true; return; }
    if (!Object.keys(manifests).length) return;
    bootedRef.current = true;
    const last = lastRoute();
    if (!last) { bootSettledRef.current = true; return; }
    let owner = null;
    for (const m of Object.values(manifests)) {
      if (!isLeftSidebarManifest(m)) continue;
      if (!routeMatchesModule(last, m)) continue;
      if (!owner || m.routeBase.length > owner.routeBase.length) owner = m;
    }
    const home = owner ? owner.routeBase : '/' + FIRST_LAUNCH_FALLBACK;
    // Recording resumes once we have actually landed — never before, or the
    // transient startup route above gets saved as "where you were".
    // Landing on `last` needs no record — it IS the stored value. A fallback
    // does: otherwise every future launch keeps retrying the dead page.
    const settle = (to) => {
      navigate(to);
      bootSettledRef.current = true;
      if (to !== last) recordRoute(to, moduleKeyFor(to, sidebarBases));
    };
    // A disabled module's home is dead too, so that falls all the way back.
    if (owner && !isEnabled(enabledMap, owner.id)) { settle('/' + FIRST_LAUNCH_FALLBACK); return; }
    // The remembered note may have been deleted since. One read decides between
    // the page and its module's home; every other kind of route lands as-is.
    const page = /^\/page\/(.+)$/.exec(last);
    if (page) {
      api.getPage(safeDecode(page[1])).then(() => settle(last)).catch(() => settle(home));
      return;
    }
    settle(last);
  }, [route?.path, manifests, enabledMap, sidebarBases]);

  const setActiveModule = useCallback((id, opts = {}) => {
    const source = opts.source || 'dock-click';
    if (id === null || id === undefined) {
      setActiveModuleIdState(null);
      writePersisted(null);
      return;
    }
    const manifest = manifests[id];
    if (!manifest || !isLeftSidebarManifest(manifest)) return;
    if (!isEnabled(enabledMap, id)) return;
    setActiveModuleIdState(id);
    writePersisted(id);
    // Selection and sidebar-expansion are independent. Dock-click never
    // auto-expands a collapsed sidebar — the user opens the sidebar
    // explicitly via the brand pill.
    if (source === 'dock-click'
        && readBag(dockModules, 'clickBehavior') === 'navigate-and-swap'
        && typeof manifest.routeBase === 'string') {
      // Return to where the user was inside this module, not to its root.
      navigate(lastRouteFor(manifest.routeBase) || manifest.routeBase);
    }
  }, [manifests, enabledMap, dockModules]);

  const setSidebarExpanded = useCallback((value) => {
    const v = !!value;
    setSidebarExpandedState(v);
    writeSidebarExpandedPersisted(v);
  }, []);

  const toggleSidebarExpanded = useCallback(() => {
    setSidebarExpandedState(prev => {
      const next = !prev;
      writeSidebarExpandedPersisted(next);
      return next;
    });
  }, []);

  const setDefaultMode = useCallback((mode) => {
    setSetting('dock', { modules: { ...dockModules, defaultMode: mode } });
  }, [setSetting, dockModules]);

  const setDefaultModuleId = useCallback((id) => {
    setSetting('dock', { modules: { ...dockModules, defaultModule: id } });
  }, [setSetting, dockModules]);

  const setClickBehavior = useCallback((b) => {
    setSetting('dock', { modules: { ...dockModules, clickBehavior: b } });
  }, [setSetting, dockModules]);

  const setNavSync = useCallback((s) => {
    setSetting('dock', { modules: { ...dockModules, navSync: s } });
  }, [setSetting, dockModules]);

  const activeModule = useMemo(() => {
    if (!activeModuleId) return null;
    return manifests[activeModuleId] || null;
  }, [activeModuleId, manifests]);

  const value = useMemo(() => ({
    activeModuleId,
    activeModule,
    setActiveModule,
    sidebarExpanded,
    setSidebarExpanded,
    toggleSidebarExpanded,
    settings: dockModules,
    setters: { setDefaultMode, setDefaultModuleId, setClickBehavior, setNavSync },
  }), [activeModuleId, activeModule, setActiveModule,
       sidebarExpanded, setSidebarExpanded, toggleSidebarExpanded,
       dockModules,
       setDefaultMode, setDefaultModuleId, setClickBehavior, setNavSync]);

  return (
    <ActiveModuleContext.Provider value={value}>
      {children}
    </ActiveModuleContext.Provider>
  );
}

export function useActiveModule() {
  const ctx = useContext(ActiveModuleContext);
  if (!ctx) {
    throw new Error('useActiveModule must be used inside <ActiveModuleProvider/>');
  }
  return ctx;
}

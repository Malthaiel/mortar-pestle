import { useSyncExternalStore, useMemo } from 'react';
import { subscribe, getSnapshot } from './registry.js';
import { useModuleEnabledMap } from '../hooks/useModuleEnabled.js';
import { useHashRoute } from '../router.js';

const getLeftSidebar       = () => getSnapshot().leftSidebar;
const getWidgets      = () => getSnapshot().widgets;
const getSettingsTab       = () => getSnapshot().settingsTab;
const getRoutes            = () => getSnapshot().routes;
const getProviders         = () => getSnapshot().providers;
const getOverlays          = () => getSnapshot().overlays;
const getRedirects         = () => getSnapshot().redirects;
const getManifests         = () => getSnapshot().manifests;
const getPageSidebar       = () => getSnapshot().pageSidebar;

function useEnabledFilter(rawList) {
  const enabledMap = useModuleEnabledMap();
  return useMemo(
    () => rawList.filter(s => enabledMap[s.moduleId] !== false),
    [rawList, enabledMap],
  );
}

export function useLeftSidebarSlots() {
  const raw = useSyncExternalStore(subscribe, getLeftSidebar);
  return useEnabledFilter(raw);
}

export function useWidgetSlots() {
  const raw = useSyncExternalStore(subscribe, getWidgets);
  return useEnabledFilter(raw);
}

export function useSettingsSlots() {
  const raw = useSyncExternalStore(subscribe, getSettingsTab);
  return useEnabledFilter(raw);
}

export function useRouteSlots() {
  const raw = useSyncExternalStore(subscribe, getRoutes);
  return useEnabledFilter(raw);
}

export function useProviders() {
  const raw = useSyncExternalStore(subscribe, getProviders);
  return useEnabledFilter(raw);
}

export function useOverlays() {
  const raw = useSyncExternalStore(subscribe, getOverlays);
  return useEnabledFilter(raw);
}

export function useManifests() {
  return useSyncExternalStore(subscribe, getManifests);
}

// Map of non-module page sidebars, keyed by pageKey (route.page). No
// enabled-filter — page sidebars aren't modules and carry no moduleId.
export function usePageSidebars() {
  return useSyncExternalStore(subscribe, getPageSidebar);
}

// Returns the array of redirect entries: { moduleId, fromPattern, toFn }.
// Consumed once at the top of MainApp via a useEffect that fires the first
// non-null toFn() result for the current route. Re-renders when modules
// register/unregister redirects.
export function useRouterRedirects() {
  return useSyncExternalStore(subscribe, getRedirects);
}

// Active left-sidebar module based on prefix-matching the current hash path
// against each enabled manifest's routeBase field. Boundary match — '/knowledge'
// matches '/knowledge' and '/knowledge/foo' but NOT '/knowledge-base'. Longest
// match wins. Returns { id, module } or { id: null, module: null }.
export function useActiveSection() {
  const manifests = useManifests();
  const enabledMap = useModuleEnabledMap();
  const route = useHashRoute();
  return useMemo(() => {
    const path = route?.path || '';
    let best = null;
    for (const m of Object.values(manifests)) {
      if (!m || typeof m.routeBase !== 'string') continue;
      if (enabledMap[m.id] === false) continue;
      const base = m.routeBase;
      const matches = path === base || path.startsWith(base + '/');
      if (!matches) continue;
      if (!best || base.length > best.routeBase.length) best = m;
    }
    return best ? { id: best.id, module: best } : { id: null, module: null };
  }, [manifests, enabledMap, route?.path]);
}

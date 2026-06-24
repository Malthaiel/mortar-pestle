import * as registry from './registry.js';
import * as hostIcons from '../components/icons.jsx';
import { navigate, useHashRoute } from '../router.js';
import { invoke, subscribeEvents } from '../api.js';
import { mapEndpoint } from './endpoint-adapter.js';

const _eventBus = new Map();
export const sharedEvents = {
  emit(name, payload) {
    const handlers = _eventBus.get(name);
    if (!handlers) return;
    handlers.forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
  },
  on(name, handler) {
    let handlers = _eventBus.get(name);
    if (!handlers) { handlers = new Set(); _eventBus.set(name, handlers); }
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
};

// Module-level dirty-module set so hooks mounted after a module signals dirty
// still see the current state (the 'module:dirty' event alone has no replay).
const _dirtyModules = new Set();
export function getDirtyModules() {
  return _dirtyModules;
}

const uiTokens = Object.freeze({
  accent: '--accent',
  bg: '--surface',
  text: '--text',
  textMuted: '--text-muted',
  textFaint: '--text-faint',
  border: '--border',
  hover: '--hover',
  radiusSm: '--radius-sm',
  radiusMd: '--radius-md',
  radiusLg: '--radius-lg',
});

export function readModuleBag(moduleId) {
  try {
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    return raw.modules?.[moduleId] || {};
  } catch {
    return {};
  }
}

export function writeModuleSetting(moduleId, key, value) {
  try {
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    raw.modules ??= {};
    raw.modules[moduleId] ??= {};
    raw.modules[moduleId][key] = value;
    localStorage.setItem('focus_settings', JSON.stringify(raw));
  } catch {}
}

const _warnedEndpointRoutes = new Set();

export function createApi(moduleId) {
  return {
    /** Invoke a Rust Tauri command directly. Throws if not running inside the Tauri shell — desktop-only by design. */
    invoke: (cmd, args = {}) => invoke(cmd, args),
    slots: {
      registerLeftSidebar: (cfg) => registry.registerLeftSidebar(moduleId, cfg),
      registerWidget: (cfg) => registry.registerWidget(moduleId, cfg),
      registerSettingsTab: (cfg) => registry.registerSettingsTab(moduleId, cfg),
      registerRoute: (cfg) => registry.registerRoute(moduleId, cfg),
      registerProvider: (Component) => registry.registerProvider(moduleId, Component),
      registerOverlay: (Component) => registry.registerOverlay(moduleId, Component),
    },
    vault: {
      /** Deprecated: use api.invoke(commandName, args) instead. Kept for one release cycle as a thin adapter mapping (method, path) → Tauri command. Unmapped routes throw — no HTTP surface exists post-SF12. */
      endpoint: (method, path, body) => {
        const pathOnly = String(path).split('?')[0];
        const key = `${method} ${pathOnly}`;
        if (!_warnedEndpointRoutes.has(key)) {
          _warnedEndpointRoutes.add(key);
          console.warn(`[Module SDK] api.vault.endpoint is deprecated; use api.invoke(commandName, args) instead. (caller: ${key})`);
        }
        const mapped = mapEndpoint(method, path, body);
        if (mapped) return invoke(mapped.command, mapped.args);
        throw new Error(`[Module SDK] Endpoint not migrated: ${key}. Use api.invoke directly.`);
      },
      /** Subscribes to vault invalidation events. Tauri-event-backed inside the desktop shell via `@tauri-apps/api/event::listen` (per SF5); falls back to EventSource('/events') for browser-tab dev. Returns a sync unsub function. */
      subscribe: (eventName, handler) => subscribeEvents((name, data) => {
        if (name === eventName) handler(data);
      }),
    },
    settings: {
      get: (key, defaultValue) => {
        const v = readModuleBag(moduleId)[key];
        return v === undefined ? defaultValue : v;
      },
      set: (key, value) => {
        writeModuleSetting(moduleId, key, value);
        sharedEvents.emit('settings:change', { moduleId, key, value });
      },
    },
    ui: {
      icons: hostIcons,
      tokens: uiTokens,
    },
    router: {
      navigate,
      useHashRoute,
      registerRedirect: (fromPattern, toFn) => registry.registerRedirect(moduleId, fromPattern, toFn),
    },
    events: sharedEvents,
    dirty: {
      set(reason) {
        if (_dirtyModules.has(moduleId)) return;
        _dirtyModules.add(moduleId);
        sharedEvents.emit('module:dirty', { moduleId, reason: reason ?? null });
      },
      clear() {
        if (!_dirtyModules.has(moduleId)) return;
        _dirtyModules.delete(moduleId);
        sharedEvents.emit('module:clean', { moduleId });
      },
    },
  };
}

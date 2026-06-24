import { useEffect, useMemo, useState } from 'react';
import { sharedEvents, getDirtyModules } from '../module-sdk/index.js';

function readEnabledMap() {
  try {
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    const modules = raw.modules || {};
    const out = {};
    for (const id of Object.keys(modules)) {
      // explicit false disables; anything else (true, undefined, missing) enabled
      out[id] = modules[id]?.enabled !== false;
    }
    return out;
  } catch {
    return {};
  }
}

export function useModuleEnabledMap() {
  const [version, bump] = useState(0);

  useEffect(() => {
    return sharedEvents.on('settings:change', ({ key }) => {
      if (key === 'enabled') bump(v => v + 1);
    });
  }, []);

  return useMemo(() => readEnabledMap(), [version]);
}

export function useModuleEnabled(moduleId) {
  const map = useModuleEnabledMap();
  return map[moduleId] !== false;
}

// Tracks modules currently signalling dirty state via api.dirty.set/clear.
// Returns a Set<moduleId>. The Modules tab consults this before allowing
// a disable toggle, showing a confirm modal when the module is dirty.
export function useDirtyModules() {
  const [dirty, setDirty] = useState(() => new Set(getDirtyModules()));

  useEffect(() => {
    const offDirty = sharedEvents.on('module:dirty', ({ moduleId }) => {
      setDirty(prev => {
        if (prev.has(moduleId)) return prev;
        const next = new Set(prev);
        next.add(moduleId);
        return next;
      });
    });
    const offClean = sharedEvents.on('module:clean', ({ moduleId }) => {
      setDirty(prev => {
        if (!prev.has(moduleId)) return prev;
        const next = new Set(prev);
        next.delete(moduleId);
        return next;
      });
    });
    return () => { offDirty(); offClean(); };
  }, []);

  return dirty;
}

export function setModuleEnabled(moduleId, enabled) {
  try {
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    raw.modules ??= {};
    raw.modules[moduleId] ??= {};
    raw.modules[moduleId].enabled = !!enabled;
    localStorage.setItem('focus_settings', JSON.stringify(raw));
    sharedEvents.emit('settings:change', { moduleId, key: 'enabled', value: !!enabled });
  } catch {}
}

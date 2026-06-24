// Per-key sidebar ordering hook. Reads from /api/sidebar-order and listens for
// in-app 'sidebar-order' broadcasts so multiple components stay in sync after
// a save from SettingsDrawer.

import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

const EVENT = 'sidebar-order-changed';

export function emitSidebarOrderChange(key) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { key } }));
}

export function useSidebarOrder(key) {
  const [order, setOrder] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    if (!key) { setOrder(null); setLoaded(true); return; }
    let cancelled = false;
    api.getSidebarOrder(key)
      .then(d => { if (!cancelled) { setOrder(d?.order || null); setLoaded(true); } })
      .catch(() => { if (!cancelled) { setOrder(null); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [key]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  useEffect(() => {
    if (!key) return;
    const handler = (e) => {
      if (e.detail?.key === key) load();
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, [key, load]);

  return { order, loaded };
}

// Reorder items so listed ids come first in order, unlisted items keep
// their incoming order afterwards. `idOf` extracts the id used in the order.
export function applyOrder(items, order, idOf = (x) => x.path) {
  if (!Array.isArray(order) || order.length === 0) return items.slice();
  const remaining = new Map();
  for (const item of items) remaining.set(idOf(item), item);
  const out = [];
  for (const id of order) {
    if (remaining.has(id)) {
      out.push(remaining.get(id));
      remaining.delete(id);
    }
  }
  for (const item of items) {
    const id = idOf(item);
    if (remaining.has(id)) {
      out.push(remaining.get(id));
      remaining.delete(id);
    }
  }
  return out;
}

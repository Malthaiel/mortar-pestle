// Per-key sidebar ordering hook. Reads from /api/sidebar-order and listens for
// in-app 'sidebar-order' broadcasts so multiple components stay in sync after
// a save from SettingsDrawer.

import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

const EVENT = 'sidebar-order-changed';

export function emitSidebarOrderChange(key) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { key } }));
}

// Synchronous mirror of the saved order. The real store is app-data behind a
// Tauri command, which is only readable asynchronously — so for the first frames
// `order` is null, `applyOrder` falls back to raw REGISTRATION order, and the
// sidebar paints the WRONG stack and then visibly reshuffles when the fetch
// lands. Measured on a cold start 2026-08-28: still wrong ~6s in. Holding the
// tiles back instead was tried and is worse (a ~10s blank panel — the cold-start
// IPC is just slow), so the first paint gets a cached answer rather than none.
// This is a CACHE, never the source of truth: the fetch always overwrites it,
// and a miss simply restores the old behaviour.
const cacheKeyFor = (key) => (key ? `sidebar:order:v1:${key}` : null);

function readOrderCache(key) {
  const k = cacheKeyFor(key);
  if (!k) return null;
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

function writeOrderCache(key, order) {
  const k = cacheKeyFor(key);
  if (!k) return;
  try {
    if (Array.isArray(order)) localStorage.setItem(k, JSON.stringify(order));
    else localStorage.removeItem(k);
  } catch { /* private mode / quota — the IPC fetch still lands */ }
}

export function useSidebarOrder(key) {
  // Seeded in the initializer so the value is present for the FIRST paint; an
  // effect would run after it and reshuffle exactly as before. `key` is a plain
  // constant at every call site, so there is no late-arriving-key hazard here —
  // and the effect below re-seeds anyway if one ever changes.
  const [order, setOrder] = useState(() => readOrderCache(key));
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    if (!key) { setOrder(null); setLoaded(true); return; }
    let cancelled = false;
    // Re-seed from the cache on a key change, so a switched key never paints the
    // PREVIOUS key's order while its own fetch is in flight.
    setOrder(readOrderCache(key));
    api.getSidebarOrder(key)
      .then(d => {
        if (cancelled) return;
        const next = d?.order || null;
        setOrder(next);
        writeOrderCache(key, next);   // the fetch is the truth; refresh the mirror
        setLoaded(true);
      })
      // A failed fetch keeps the cached order on screen rather than snapping the
      // sidebar back to registration order.
      .catch(() => { if (!cancelled) setLoaded(true); });
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

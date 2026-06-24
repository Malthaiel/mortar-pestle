// Tracks the last N pages the user visited so the Cmd+K palette can render
// a "Recent" section and the sidebar can render a recently-visited capsule.
//
// Storage shape (localStorage key 'recent_pages'):
//   [{ path: '/page/Knowledge/Deadlock/Heroes/Vyper.md',
//      label: 'Vyper',
//      visitedAt: '2026-05-21T15:42:11.000Z' }, …]
//
// Newest first. Capped at 12 entries (sidebar capsule shows 5, palette
// shows everything). Duplicates collapse to a single entry whose visitedAt
// updates to the latest visit.

import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'recent_pages';
const MAX_ENTRIES = 12;
const EVENT = 'recent-pages-change';

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {}
}

// Imperative — call from a hashchange handler or route effect.
export function recordVisit(path, label) {
  if (!path || typeof path !== 'string') return;
  const list = read();
  const filtered = list.filter(e => e.path !== path);
  filtered.unshift({ path, label: label || path, visitedAt: new Date().toISOString() });
  write(filtered.slice(0, MAX_ENTRIES));
}

export function useRecentPages(limit = MAX_ENTRIES) {
  const [list, setList] = useState(read);

  useEffect(() => {
    const update = () => setList(read());
    window.addEventListener(EVENT, update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener('storage', update);
    };
  }, []);

  const clear = useCallback(() => write([]), []);

  return { recent: list.slice(0, limit), clear };
}

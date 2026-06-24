// Expand-state for the non-vault tree sidebars (Browser / Library / Skills / Docs).
// The vault keeps its richer lazy useVaultTree; these surfaces have small, fully
// in-memory trees, so one Set of open folder ids (persisted to localStorage) is
// enough. Exposes the same expand surface the vault controller does, so
// TreeToolbar / TreeSidebar consume both identically. expandAll/reveal take ids
// (the surface knows its full folder-id list / the ancestor chain to open).

import { useCallback, useState } from 'react';

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) { const v = JSON.parse(raw); if (Array.isArray(v)) return new Set(v); }
  } catch {}
  return new Set(fallback || []);
}

export function useTreeExpansion(storageKey, defaultOpen) {
  const [expanded, setExpanded] = useState(() => load(storageKey, defaultOpen));
  const persist = useCallback((set) => {
    try { localStorage.setItem(storageKey, JSON.stringify([...set])); } catch {}
  }, [storageKey]);

  const isOpen = useCallback((id) => expanded.has(id), [expanded]);
  const toggle = useCallback((node) => {
    const id = node?.id ?? node;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      persist(next); return next;
    });
  }, [persist]);
  const expandAll = useCallback((ids) => {
    setExpanded(() => { const n = new Set(ids || []); persist(n); return n; });
  }, [persist]);
  const collapseAll = useCallback(() => {
    setExpanded(() => { const n = new Set(); persist(n); return n; });
  }, [persist]);
  // Open the given ids without touching others (used by Reveal-current to expand an
  // active leaf's ancestor folder).
  const reveal = useCallback((ids) => {
    setExpanded((prev) => {
      let changed = false; const next = new Set(prev);
      for (const id of (ids || [])) if (!next.has(id)) { next.add(id); changed = true; }
      if (!changed) return prev; persist(next); return next;
    });
  }, [persist]);

  return { expanded, isOpen, toggle, expandAll, collapseAll, reveal, anyExpanded: expanded.size > 0 };
}

// Tiny localStorage-backed string state — used by the non-vault controllers for the
// persisted sort mode (Skills / Docs / Browser). Returns [value, setValue].
export function usePersistedState(key, fallback) {
  const [v, setV] = useState(() => {
    try { const s = localStorage.getItem(key); return s == null ? fallback : s; } catch { return fallback; }
  });
  const set = useCallback((nv) => {
    try { localStorage.setItem(key, nv); } catch {}
    setV(nv);
  }, [key]);
  return [v, set];
}

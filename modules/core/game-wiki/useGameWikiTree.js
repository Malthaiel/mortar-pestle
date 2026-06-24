// Game Wiki file tree — expand-state + lazy children for the read-only games tree.
// A trimmed mirror of useVaultTree: top-level nodes are the GAMES (immediate
// subfolders of the GameWiki vault root), each lazily expanded one disk level at a
// time via vault_get_folder(root:'gamewiki'). No file ops, no sort, no manifest —
// the gamewiki vault is read-only reference. Expand state persists to localStorage.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@host/api.js';

const LS_KEY = 'gamewiki:tree:expanded';

function loadExpanded() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const v = JSON.parse(raw); if (Array.isArray(v)) return new Set(v); }
  } catch {}
  return new Set();
}
function persist(set) { try { localStorage.setItem(LS_KEY, JSON.stringify([...set])); } catch {} }

function sortNodes(nodes) {
  return nodes.slice().sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1; // folders first
    return a.name.localeCompare(b.name);
  });
}

// Build child nodes from a vault_get_folder result. `parentPath` = the full
// gamewiki-relative path of the folder being listed (file paths come back full).
function childNodes(parentPath, res) {
  const folders = (res?.subfolders || []).map((sf) => ({
    name: sf.name,
    vaultPath: parentPath ? `${parentPath}/${sf.name}` : sf.name,
    isFolder: true,
  }));
  const files = (res?.pages || []).map((p) => {
    const vp = (p.path || '').replace(/^\/+/, '').replace(/\.md$/, '');
    return { name: vp.split('/').pop(), vaultPath: vp, isFolder: false };
  });
  return sortNodes([...folders, ...files]);
}

// (slug, rel) for a full gamewiki path — slug = first segment (the game).
function slugRel(fp) {
  if (!fp) return ['', ''];
  const [slug, ...rest] = fp.split('/');
  return [slug, rest.join('/')];
}

export function useGameWikiTree() {
  const [expanded, setExpanded] = useState(loadExpanded);
  const [cache, setCache] = useState({}); // vaultPath -> { loading, nodes }
  const [games, setGames] = useState(null); // top-level games | null while loading
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  const fetchChildren = useCallback(async (vaultPath) => {
    setCache((c) => ({ ...c, [vaultPath]: { ...(c[vaultPath] || {}), loading: true } }));
    const [slug, rel] = slugRel(vaultPath);
    try {
      const res = await api.getVaultFolder(slug, rel, 'gamewiki');
      setCache((c) => ({ ...c, [vaultPath]: { loading: false, nodes: childNodes(vaultPath, res) } }));
    } catch {
      setCache((c) => ({ ...c, [vaultPath]: { loading: false, nodes: [] } }));
    }
  }, []);

  const toggle = useCallback((vaultPath) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(vaultPath)) next.delete(vaultPath);
      else { next.add(vaultPath); if (!cacheRef.current[vaultPath]) fetchChildren(vaultPath); }
      persist(next);
      return next;
    });
  }, [fetchChildren]);

  const isOpen = useCallback((vp) => expanded.has(vp), [expanded]);
  const childrenOf = useCallback((vp) => cache[vp], [cache]);
  const collapseAll = useCallback(() => setExpanded(() => { const n = new Set(); persist(n); return n; }), []);

  // Top-level games = immediate subfolders of the gamewiki root (slug '').
  useEffect(() => {
    let cancelled = false;
    api.getVaultFolder('', '', 'gamewiki').then((res) => {
      if (cancelled) return;
      setGames((res?.subfolders || [])
        .map((sf) => ({ name: sf.name, vaultPath: sf.name, isFolder: true }))
        .sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => { if (!cancelled) setGames([]); });
    return () => { cancelled = true; };
  }, []);

  // Materialize children for any open-but-uncached folder (localStorage restore).
  useEffect(() => {
    for (const vp of expanded) if (!cacheRef.current[vp]) fetchChildren(vp);
  }, [expanded, fetchChildren]);

  return { games, isOpen, toggle, childrenOf, collapseAll, anyExpanded: expanded.size > 0 };
}

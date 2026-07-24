// Game Wiki file tree — expand-state + lazy children for the read-only games tree.
// A trimmed mirror of useVaultTree: top-level nodes are the GAMES (immediate
// subfolders of the GameWiki vault root), each lazily expanded one disk level at a
// time via vault_get_folder(root:'gamewiki'). No file ops, no sort, no manifest —
// the gamewiki vault is read-only reference. Expand state persists to localStorage.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@host/api.js';
import { sortNodes } from '@host/components/vault-tree/useVaultTree.js';

const LS_KEY = 'gamewiki:tree:expanded';
const LS_SORT = 'gamewiki:tree:sort';

// Virtual scrim sub-folders: match groups (`Matches/Match N`, plus their Report
// leaf's `/tldr` sub-key) expand like disk folders — same expanded Set, so
// collapse-all and persistence cover them — but have NO disk children; never
// fetch them (vault_get_folder would just 404 into an empty cache entry). The
// Report|Coaching arm covers stale persisted keys from the retired scrim-level
// virtual groups (pre match-folder tree) so a localStorage restore stays quiet.
const VIRTUAL_RE = /^Deadlock\/Coaching\/Scrim\/[^/]+\/(Report|Coaching|Matches\/Match \d+(\/tldr)?)$/;

function loadExpanded() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const v = JSON.parse(raw); if (Array.isArray(v)) return new Set(v); }
  } catch {}
  return new Set();
}
function persist(set) { try { localStorage.setItem(LS_KEY, JSON.stringify([...set])); } catch {} }

// Build child nodes from a vault_get_folder result — UNSORTED; childrenOf
// applies the live sort mode (the vault's shared sortNodes) at read time so a
// mode change re-orders cached folders without refetching. `parentPath` = the
// full gamewiki-relative path of the folder being listed (file paths come back
// full). mtime/created ride along for the time sort modes.
function childNodes(parentPath, res) {
  const folders = (res?.subfolders || []).map((sf) => ({
    name: sf.name,
    vaultPath: parentPath ? `${parentPath}/${sf.name}` : sf.name,
    isFolder: true,
  }));
  const files = (res?.pages || []).map((p) => {
    const vp = (p.path || '').replace(/^\/+/, '').replace(/\.md$/, '');
    return { name: vp.split('/').pop(), vaultPath: vp, isFolder: false, mtime: p.mtime, created: p.created };
  });
  return [...folders, ...files];
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
  const [sortMode, setSortModeState] = useState(() => {
    try { return localStorage.getItem(LS_SORT) || 'name-asc'; } catch { return 'name-asc'; }
  });
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  const setSortMode = useCallback((mode) => {
    setSortModeState(mode);
    try { localStorage.setItem(LS_SORT, mode); } catch {}
  }, []);

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
      else { next.add(vaultPath); if (!VIRTUAL_RE.test(vaultPath) && !cacheRef.current[vaultPath]) fetchChildren(vaultPath); }
      persist(next);
      return next;
    });
  }, [fetchChildren]);

  const isOpen = useCallback((vp) => expanded.has(vp), [expanded]);
  // Sort applied at read time with the vault's shared sortNodes (scrim folders +
  // Matches/ re-rank downstream in GameWikiTree regardless of mode).
  const childrenOf = useCallback((vp) => {
    const e = cache[vp];
    return e?.nodes ? { ...e, nodes: sortNodes(e.nodes, sortMode) } : e;
  }, [cache, sortMode]);
  // Re-list a folder's children after a file op the hook didn't initiate (scrim
  // bundle rename/delete/new from the GameWikiTree context menu). Drops the cache
  // entry so the next render isn't stale; re-fetches if the folder is open.
  const refresh = useCallback((vaultPath) => {
    setCache((c) => { const next = { ...c }; delete next[vaultPath]; return next; });
    if (cacheRef.current[vaultPath] || expanded.has(vaultPath)) fetchChildren(vaultPath);
  }, [fetchChildren, expanded]);
  // Reveal-current: expand every ancestor folder of a path (virtual Report/
  // Coaching groups join the same Set; only real folders fetch). The toolbar's
  // scroll-into-view runs after the cascade, same recipe as VaultTree/LibraryNav.
  const reveal = useCallback((vaultPath) => {
    if (!vaultPath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const segs = vaultPath.split('/');
      for (let i = 1; i < segs.length; i++) {
        const p = segs.slice(0, i).join('/');
        if (!next.has(p)) {
          next.add(p);
          if (!VIRTUAL_RE.test(p) && !cacheRef.current[p]) fetchChildren(p);
        }
      }
      persist(next);
      return next;
    });
  }, [fetchChildren]);
  const collapseAll = useCallback(() => setExpanded(() => { const n = new Set(); persist(n); return n; }), []);
  // Expand-all = open the top-level games (children stay lazy — a recursive disk
  // walk is the wrong cost for a reference vault). TreeToolbar's collapse toggle.
  const expandAll = useCallback(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const g of games || []) {
        if (!next.has(g.vaultPath)) {
          next.add(g.vaultPath);
          if (!cacheRef.current[g.vaultPath]) fetchChildren(g.vaultPath);
        }
      }
      persist(next);
      return next;
    });
  }, [games, fetchChildren]);

  // Top-level games = immediate subfolders of the gamewiki root (slug '').
  // Unsorted here; sorted at return by the live mode. refreshGames re-lists
  // after a root-level op (New folder).
  const refreshGames = useCallback(() =>
    api.getVaultFolder('', '', 'gamewiki').then((res) => {
      setGames((res?.subfolders || []).map((sf) => ({ name: sf.name, vaultPath: sf.name, isFolder: true })));
    }).catch(() => setGames((g) => g || [])), []);
  useEffect(() => { refreshGames(); }, [refreshGames]);

  // Materialize children for any open-but-uncached folder (localStorage restore).
  useEffect(() => {
    for (const vp of expanded) if (!VIRTUAL_RE.test(vp) && !cacheRef.current[vp]) fetchChildren(vp);
  }, [expanded, fetchChildren]);

  return {
    games: games && sortNodes(games, sortMode),
    isOpen, toggle, childrenOf, refresh, refreshGames, reveal, collapseAll, expandAll,
    sortMode, setSortMode,
    anyExpanded: expanded.size > 0,
  };
}

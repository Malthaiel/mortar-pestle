// Vault File Tree — expand-state + lazy children for the recursive sidebar.
//
// One hook owns the expanded `Set` (persisted to localStorage) and a per-folder
// children cache. Children come from `vault_get_folder` (a one-level disk scan),
// so structure is always disk-accurate and manifest-independent. The hook is
// instantiated once in `VaultTree` and shared across both sections, so expand
// state is unified and a single localStorage blob round-trips it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribeEvents } from '../../api.js';
import { encodePagePath } from '../SidebarBrowser.jsx';
import { navigate } from '../../router.js';
import { walkFolders, mergeWalk } from './treeSearch.js';

// Fired after any op that can change the vault's TOP level, for listeners that
// cannot rely on the manifest watcher event (see regenManifest below).
export const ROOTS_CHANGED = 'vault:roots-changed';

const LS_KEY = 'vault:tree:expanded';
const LS_SORT = 'vault:tree:sort';

function loadExpanded() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return new Set(v);
    }
  } catch {}
  return new Set(['Knowledge', 'Infrastructure']); // sections open by default
}

function persist(set) {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...set])); } catch {}
}

function loadSort() {
  try { const v = localStorage.getItem(LS_SORT); if (v) return v; } catch {}
  return 'name-asc';
}
function persistSort(mode) {
  try { localStorage.setItem(LS_SORT, mode); } catch {}
}

// The six Obsidian-style sort modes (mode → menu label) sortNodes understands.
// Lives beside sortNodes so non-vault trees (Deadlock) can reuse the pair
// without importing the VaultTree component.
export const VAULT_SORT_MODES = [
  ['name-asc', 'Name (A → Z)'],
  ['name-desc', 'Name (Z → A)'],
  ['mtime-desc', 'Modified (New → Old)'],
  ['mtime-asc', 'Modified (Old → New)'],
  ['created-desc', 'Created (New → Old)'],
  ['created-asc', 'Created (Old → New)'],
];

// Folders always grouped first. Name modes sort folders + files by name (reverse
// on -desc); time modes (mtime/created) reorder FILES by the ISO timestamp string
// (lexical == chronological; missing sorts last) while folders stay alphabetical.
// mode: name-asc | name-desc | mtime-desc | mtime-asc | created-desc | created-asc.
export function sortNodes(nodes, mode = 'name-asc') {
  const dir = mode.endsWith('-desc') ? -1 : 1;
  const key = mode.startsWith('mtime') ? 'mtime' : mode.startsWith('created') ? 'created' : 'name';
  return nodes.slice().sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    if (a.isFolder) return (key === 'name' ? dir : 1) * a.name.localeCompare(b.name);
    if (key === 'name') return dir * a.name.localeCompare(b.name);
    const av = a[key] || '', bv = b[key] || '';
    if (av === bv) return a.name.localeCompare(b.name);
    if (!av) return 1;
    if (!bv) return -1;
    return dir * av.localeCompare(bv);
  });
}

// Build child nodes from a vault_get_folder result.
export function childNodes(parent, res) {
  const folders = (res?.subfolders || []).map((sf) => ({
    name: sf.name,
    vaultPath: parent.vaultPath + '/' + sf.name,
    section: parent.section,
    rel: parent.rel ? parent.rel + '/' + sf.name : sf.name,
    isFolder: true,
    count: sf.count || 0,
    depth: parent.depth + 1,
  }));
  const files = (res?.pages || []).map((p) => ({
    name: p.name,
    title: p.title || p.name,
    vaultPath: p.path,
    href: '/page/' + encodePagePath(p.path),
    isFolder: false,
    depth: parent.depth + 1,
    mtime: p.mtime,
    created: p.created,
  }));
  return sortNodes([...folders, ...files]);
}

// Reconstruct a fetchable folder node from a stored vaultPath ("Section/a/b").
function nodeFromPath(vp) {
  const [section, ...rest] = vp.split('/');
  return { vaultPath: vp, section, rel: rest.join('/'), depth: rest.length, isFolder: true };
}

export function useVaultTree(route) {
  const [expanded, setExpanded] = useState(loadExpanded);
  const [sortMode, setSortModeState] = useState(loadSort);
  const [cache, setCache] = useState({}); // vaultPath -> { loading, nodes, error }
  // Root-level .md files (e.g. CLAUDE.md). The section tree only covers named top
  // folders, so root files are fetched separately and rendered as flat leaves at
  // the bottom of the tree. Reloads on manifest rebuild (vault switch / regen).
  const [rootFiles, setRootFiles] = useState([]);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  // Current open page path (for ops that must follow / clear it). Read live.
  const subRef = useRef('');
  subRef.current = route?.page === 'page' ? (route.sub || '') : '';

  const fetchChildren = useCallback(async (node) => {
    const key = node.vaultPath;
    setCache((c) => ({ ...c, [key]: { ...(c[key] || {}), loading: true } }));
    try {
      const res = await api.getVaultFolder(node.section, node.rel || '');
      setCache((c) => ({ ...c, [key]: { loading: false, nodes: childNodes(node, res) } }));
    } catch (e) {
      setCache((c) => ({ ...c, [key]: { loading: false, nodes: [], error: String(e) } }));
    }
  }, []);

  const toggle = useCallback((node) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.vaultPath)) {
        next.delete(node.vaultPath);
      } else {
        next.add(node.vaultPath);
        if (!cacheRef.current[node.vaultPath]) fetchChildren(node);
      }
      persist(next);
      return next;
    });
  }, [fetchChildren]);

  const isOpen = useCallback((vp) => expanded.has(vp), [expanded]);
  const childrenOf = useCallback((vp) => cache[vp], [cache]);

  const refresh = useCallback((vp) => {
    if (cacheRef.current[vp]) fetchChildren(nodeFromPath(vp));
  }, [fetchChildren]);

  const setSortMode = useCallback((mode) => { persistSort(mode); setSortModeState(mode); }, []);

  // Collapse every folder (section roots included) — Obsidian's "collapse all".
  const collapseAll = useCallback(() => {
    setExpanded(() => { const n = new Set(); persist(n); return n; });
  }, []);

  // Load every folder under the given section roots into the cache without
  // opening any (the toolbar search needs to see inside closed folders). One
  // setCache at the end, so no per-folder re-render storm. rootPaths = the
  // section vaultPaths (Knowledge, …). Returns the walk { vaultPath: nodes }.
  const loadAll = useCallback(async (rootPaths) => {
    const got = await walkFolders(rootPaths || [], async (vp) => {
      const cached = cacheRef.current[vp]?.nodes;
      if (cached) return cached;
      const node = nodeFromPath(vp);
      return childNodes(node, await api.getVaultFolder(node.section, node.rel || ''));
    });
    setCache((c) => mergeWalk(c, got));
    return got;
  }, []);

  // Load + expand every folder under the given section roots.
  const expandAll = useCallback(async (rootPaths) => {
    const got = await loadAll(rootPaths);
    setExpanded((prev) => { const n = new Set([...prev, ...Object.keys(got)]); persist(n); return n; });
  }, [loadAll]);

  // Expand the ancestor chain of a vault path (the "locate current file" toolbar
  // action, even after a manual collapse). The materialize effect below fetches
  // any newly-opened uncached folder.
  const revealPath = useCallback((vp) => {
    if (!vp) return;
    const parts = vp.replace(/\.md$/, '').split('/');
    const anc = [];
    for (let k = 1; k < parts.length; k++) anc.push(parts.slice(0, k).join('/'));
    if (!anc.length) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const a of anc) if (!next.has(a)) { next.add(a); changed = true; }
      if (!changed) return prev;
      persist(next);
      return next;
    });
  }, []);

  // ── File operations (SF3) ────────────────────────────────────────────────
  // Knowledge/Infrastructure live in the Content vault (root = undefined →
  // RootKind::Content), and a node's vaultPath ("Knowledge/Anime/Foo.md") IS the
  // content-relative path these commands take.

  // Open a folder (if collapsed) and (re)fetch its children — used after creating
  // inside a possibly-collapsed folder so the new child shows.
  const revealAndRefresh = useCallback((vp) => {
    setExpanded((prev) => {
      if (prev.has(vp)) return prev;
      const next = new Set(prev); next.add(vp); persist(next); return next;
    });
    fetchChildren(nodeFromPath(vp));
  }, [fetchChildren]);

  // Folder ops emit no file-watcher event, so each op explicitly refetches the
  // affected parent AND best-effort regenerates the manifest so search / counts
  // converge (the tree itself is disk-accurate without it).
  const regenManifest = useCallback(async () => {
    try {
      const out = await api.vaults.list();
      if (out?.activeId) await api.vaults.generateManifest(out.activeId);
    } catch {}
    // The `manifest` watcher event fires only when Infrastructure/.cache/vault_manifest.json
    // changes (watcher.rs matches that literal path), so in a NON-Citadel-shaped vault
    // nothing ever announces that the vault ROOT changed — a folder created, deleted,
    // renamed or dragged to the top level stayed invisible until a reload. Announce it
    // directly; the Citadel case now just gets a harmless second refresh.
    try { window.dispatchEvent(new CustomEvent(ROOTS_CHANGED)); } catch {}
  }, []);

  const createNote = useCallback(async (parentVp, name) => {
    const path = parentVp ? `${parentVp}/${name}.md` : `${name}.md`;
    const created = new Date().toISOString().slice(0, 10);
    const stub = `---\ntitle: ${name}\ncreated: ${created}\n---\n`;
    await api.savePage(path, stub, undefined, undefined);
    if (parentVp) revealAndRefresh(parentVp); // root notes surface via rootFiles on manifest
    regenManifest();
    navigate('/page/' + encodePagePath(path));
  }, [revealAndRefresh, regenManifest]);

  const createFolder = useCallback(async (parentVp, name) => {
    await api.createFolder(parentVp ? `${parentVp}/${name}` : name, undefined);
    if (parentVp) revealAndRefresh(parentVp); // root folders surface as sections on manifest
    regenManifest();
  }, [revealAndRefresh, regenManifest]);

  const renameNode = useCallback(async (node, newName) => {
    const parent = node.vaultPath.split('/').slice(0, -1).join('/');
    const base = node.isFolder ? newName : `${newName}.md`;
    const to = parent ? `${parent}/${base}` : base; // root folder/file → no leading slash
    if (to === node.vaultPath) return;
    await api.renamePath(node.vaultPath, to, undefined);
    if (parent) refresh(parent);
    regenManifest();
    // Follow the open page if the renamed file (or a folder containing it) moved.
    const cur = subRef.current;
    if (cur && (cur === node.vaultPath || cur.startsWith(node.vaultPath + '/'))) {
      navigate('/page/' + encodePagePath(cur.replace(node.vaultPath, to)));
    }
  }, [refresh, regenManifest]);

  // Drag-to-move: relocate a node INTO another folder, keeping its own basename.
  // Same backend primitive as renameNode — vault_rename_path is rename-OR-move — so
  // the only difference is which half of the path changes. `destVp` '' = vault root.
  // Returns nothing; the caller surfaces a failed move (name collision) as a toast.
  const movePath = useCallback(async (node, destVp) => {
    const vp = node.vaultPath;
    const parent = vp.split('/').slice(0, -1).join('/');
    if (destVp === parent) return;                             // already lives there
    if (destVp === vp || destVp.startsWith(vp + '/')) return;  // into itself / a child
    const to = destVp ? `${destVp}/${vp.split('/').pop()}` : vp.split('/').pop();
    await api.renamePath(vp, to, undefined);
    // Prune the moved subtree from expand state + cache — it re-materializes under
    // its new parent on the refresh below. (The drag collapses a grabbed folder, so
    // there is nothing open to preserve.)
    setExpanded((prev) => {
      const next = new Set([...prev].filter((k) => k !== vp && !k.startsWith(vp + '/')));
      persist(next); return next;
    });
    setCache((c) => {
      const next = {};
      for (const k of Object.keys(c)) if (k !== vp && !k.startsWith(vp + '/')) next[k] = c[k];
      return next;
    });
    if (parent) refresh(parent);
    if (destVp) refresh(destVp);
    regenManifest();
    // Follow the open page if it (or a folder containing it) moved.
    const cur = subRef.current;
    if (cur && (cur === vp || cur.startsWith(vp + '/'))) {
      navigate('/page/' + encodePagePath(cur.replace(vp, to)));
    }
  }, [refresh, regenManifest]);

  const removeNode = useCallback(async (node) => {
    const vp = node.vaultPath;
    if (node.isFolder) await api.deleteFolder(vp, undefined);
    else await api.deleteFile(vp, undefined);
    const parent = vp.split('/').slice(0, -1).join('/');
    // Prune the deleted node + any descendants from expand state + cache.
    setExpanded((prev) => {
      const next = new Set([...prev].filter((k) => k !== vp && !k.startsWith(vp + '/')));
      persist(next); return next;
    });
    setCache((c) => {
      const next = {};
      for (const k of Object.keys(c)) if (k !== vp && !k.startsWith(vp + '/')) next[k] = c[k];
      return next;
    });
    if (parent) refresh(parent);
    regenManifest();
    // If the open page was deleted (or lived inside a deleted folder), leave it.
    const cur = subRef.current;
    if (cur && (cur === vp || cur.startsWith(vp + '/'))) navigate('/vault');
  }, [refresh, regenManifest]);

  // Materialize children for every open-but-uncached folder: LS-restored open
  // state on mount + ancestors added by auto-expand below.
  useEffect(() => {
    for (const vp of expanded) {
      if (!cacheRef.current[vp]) fetchChildren(nodeFromPath(vp));
    }
  }, [expanded, fetchChildren]);

  // Fetch root-level files once on mount (empty slug → content-vault root); the
  // Rust path comes back with a leading slash ("/CLAUDE.md") so strip it.
  useEffect(() => {
    let cancelled = false;
    const load = () => api.getVaultFolder('', '').then((res) => {
      if (cancelled) return;
      setRootFiles((res?.pages || []).map((p) => {
        const vp = (p.path || '').replace(/^\/+/, '');
        return { name: p.name, title: p.title || p.name, vaultPath: vp,
          href: '/page/' + encodePagePath(vp), isFolder: false, depth: 0 };
      }));
    }).catch(() => {});
    load();
    const unsub = subscribeEvents((name) => { if (name === 'manifest') load(); });
    window.addEventListener(ROOTS_CHANGED, load);
    return () => { cancelled = true; unsub(); window.removeEventListener(ROOTS_CHANGED, load); };
  }, []);

  // Auto-expand the ancestor chain of the currently-open page (recursive
  // generalization of the old one-level defaultExpandedKey).
  const lastAuto = useRef('');
  useEffect(() => {
    if (route?.page !== 'page' || typeof route.sub !== 'string') return;
    const sub = route.sub;
    if (!(sub.startsWith('Knowledge/') || sub.startsWith('Infrastructure/'))) return;
    if (lastAuto.current === sub) return;
    lastAuto.current = sub;
    const parts = sub.replace(/\.md$/, '').split('/');
    const anc = [];
    for (let k = 1; k < parts.length; k++) anc.push(parts.slice(0, k).join('/'));
    if (!anc.length) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const a of anc) if (!next.has(a)) { next.add(a); changed = true; }
      if (!changed) return prev;
      persist(next);
      return next;
    });
  }, [route?.page, route?.sub]);

  // External changes: a manifest rebuild (incl. our own post-op regen) refetches
  // every open folder; a single `file` event refetches just the affected parent
  // if it's open. Subscribes once (reads live state via refs).
  useEffect(() => {
    const unsub = subscribeEvents((name, payload) => {
      if (name === 'manifest') {
        for (const vp of expandedRef.current) refresh(vp);
      } else if (name === 'file' && typeof payload === 'string') {
        const parent = payload.split('/').slice(0, -1).join('/');
        if (parent && cacheRef.current[parent]) refresh(parent);
      }
    });
    return () => unsub();
  }, [refresh]);

  return {
    isOpen, toggle, childrenOf, fetchChildren, refresh, rootFiles,
    createNote, createFolder, renameNode, removeNode, movePath,
    sortMode, setSortMode, expandAll, collapseAll, revealPath, loadAll,
    anyExpanded: expanded.size > 0,
  };
}

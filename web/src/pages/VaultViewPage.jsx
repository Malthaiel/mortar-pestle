// Content-vault router. The recursive VaultTree sidebar is the only vault
// navigation now — the former folder card/table views (FolderPage + Cards/Table/
// ViewEditor) were removed. Every /vault route is a redirect: bare /vault and any
// legacy folder/knowledge/infrastructure deep-link resolve to a note through
// VaultLanding; only the Infrastructure Update Queue keeps its interactive view.
// Notes themselves render at /page/<vaultPath> (PageView).

import { useEffect, useRef } from 'react';
import { api } from '../api.js';
import UpdateQueue from './infrastructure/UpdateQueue.jsx';
import { encodePagePath } from '../components/SidebarBrowser.jsx';
import { readSectionPage } from '../hooks/useSectionMemory.js';

const WRAP = { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' };

function replaceHash(newHash) {
  const base = window.location.href.split('#')[0];
  window.history.replaceState(null, '', base + '#' + newHash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// Descend a vault folder to its first note, returning the note's vaultPath. At
// each level: open the first page alphabetically; if the level has no pages,
// descend into its first subfolder. Returns null if the subtree holds no notes.
async function firstNoteUnder(slug, rel = '') {
  const res = await api.getVaultFolder(slug, rel);
  const pages = res?.pages || [];
  if (pages.length) {
    return [...pages].sort((a, b) => a.name.localeCompare(b.name))[0].path;
  }
  const subs = res?.subfolders || [];
  if (subs.length) {
    const first = [...subs].sort((a, b) => a.name.localeCompare(b.name))[0];
    return firstNoteUnder(slug, rel ? rel + '/' + first.name : first.name);
  }
  return null;
}

// Bare /vault (and any non-update-queue /vault deep-link) → restore the last
// viewed vault note (VaultTree records it in 'vault' section memory), else the
// first note under Knowledge (or, for a foreign vault, its first top folder).
// Renders nothing — it only redirects.
function VaultLanding() {
  const redirectedRef = useRef(false);
  useEffect(() => {
    if (redirectedRef.current) return;
    let cancelled = false;
    const go = (path) => {
      if (path && !cancelled && !redirectedRef.current) {
        redirectedRef.current = true;
        replaceHash('/page/' + encodePagePath(path));
      }
    };
    (async () => {
      // 1. Last-viewed vault note (a Knowledge/… or Infrastructure/… vaultPath).
      const remembered = readSectionPage('vault');
      if (remembered && (remembered.startsWith('Knowledge/') || remembered.startsWith('Infrastructure/'))) {
        go(remembered);
        return;
      }
      // 2. Fallback to the first note. Foreign vault → first top folder; else
      //    Knowledge. Best-effort: on error, render nothing (tree-only).
      try {
        const shape = await api.vaults.shape();
        if (cancelled) return;
        if (shape && !shape.citadelShaped) {
          const top = (shape.topFolders || [])[0];
          if (top) go(await firstNoteUnder(top.name, ''));
          return;
        }
      } catch {}
      try { go(await firstNoteUnder('Knowledge', '')); } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
  return null;
}

export default function VaultViewPage({ type, sub, accent }) {
  // The Infrastructure Update Queue is the one interactive vault view kept.
  if (type === 'infrastructure' && sub === 'update-queue') {
    return <div style={WRAP}><UpdateQueue accent={accent}/></div>;
  }
  // Everything else under /vault redirects to a note — the tree is the browser.
  return <VaultLanding/>;
}

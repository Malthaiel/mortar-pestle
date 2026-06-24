// Docs navigation tree, rendered in the GLOBAL left sidebar via the page-sidebar
// registry (registerPageSidebar('docs', …)). Now the shared candy tree
// (TreeSidebar), matching the vault: manifest categories are collapsible folder
// pills, entries are leaf rows, and the Releases view is a pinned top-level leaf.
// Toolbar: Sort (name + by-date, using each entry's mtime), Collapse/Expand all,
// Reveal current, Reveal in files (the App vault's Iskariel/Docs folder).

import { useEffect, useMemo, useRef } from 'react';
import { navigate } from '../../router.js';
import TreeSidebar from '../../components/vault-tree/TreeSidebar.jsx';
import { useTreeExpansion, usePersistedState } from '../../components/vault-tree/useTreeExpansion.js';
import { openInFiles } from '../../components/vault-tree/revealInFiles.js';
import { useDocsManifest } from './useDocsManifest.js';
import { writeSectionPage } from '../../hooks/useSectionMemory.js';

const SORT_MODES = [
  ['name-asc', 'Name (A → Z)'],
  ['name-desc', 'Name (Z → A)'],
  ['mtime-desc', 'Modified (new → old)'],
  ['mtime-asc', 'Modified (old → new)'],
];

function sortEntries(entries, mode) {
  const dir = mode.endsWith('-desc') ? -1 : 1;
  if (mode.startsWith('mtime')) {
    return entries.slice().sort((a, b) => {
      const av = a.mtime || 0, bv = b.mtime || 0;
      if (av === bv) return a.title.localeCompare(b.title);
      return dir * (av - bv);
    });
  }
  return entries.slice().sort((a, b) => dir * a.title.localeCompare(b.title));
}

export default function DocsNav({ route, accent }) {
  const { manifest } = useDocsManifest();
  const exp = useTreeExpansion('docs:tree:expanded', []);
  const [sortMode, setSortMode] = usePersistedState('docs:tree:sort', 'name-asc');

  const selectedPath = route.sub === 'releases'
    ? '/docs/releases'
    : route.sub && route.rest
    ? `/docs/${route.sub}/${route.rest}`
    : null;

  // Persist the last-viewed doc so returning restores it. No-ops on null.
  useEffect(() => { writeSectionPage('docs', selectedPath); }, [selectedPath]);

  // First load: open every category (the TOC was always-expanded before) unless the
  // user already has a saved expand state. Guarded so it runs once per mount.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || !manifest) return;
    didInit.current = true;
    let saved = null;
    try { saved = localStorage.getItem('docs:tree:expanded'); } catch {}
    if (!saved) exp.expandAll(manifest.categories.map((c) => 'cat:' + c.id));
  }, [manifest]);

  const nodes = useMemo(() => {
    if (!manifest) return [];
    // Pinned top-level Releases leaf (folded in from the retired standalone page).
    const releases = {
      id: '/docs/releases', label: 'Releases', isFolder: false,
      active: selectedPath === '/docs/releases',
      onActivate: () => navigate('/docs/releases'),
    };
    const cats = manifest.categories.map((cat) => ({
      id: 'cat:' + cat.id, label: cat.label, isFolder: true,
      children: sortEntries(cat.entries, sortMode).map((e) => {
        const path = `/docs/${cat.id}/${e.id}`;
        return {
          id: path, label: e.title, isFolder: false,
          active: selectedPath === path,
          onActivate: () => navigate(path),
        };
      }),
    }));
    return [releases, ...cats];
  }, [manifest, sortMode, selectedPath]);

  const controller = {
    isOpen: exp.isOpen,
    toggle: exp.toggle,
    anyExpanded: exp.anyExpanded,
    expandAll: () => exp.expandAll((manifest?.categories || []).map((c) => 'cat:' + c.id)),
    collapseAll: exp.collapseAll,
    sortMode, setSortMode, sortModes: SORT_MODES,
    canReveal: !!selectedPath,
    revealCurrent: () => {
      if (!selectedPath) return;
      if (selectedPath !== '/docs/releases' && route.sub) exp.reveal(['cat:' + route.sub]);
      setTimeout(() => {
        const el = document.querySelector('[data-current-file="true"]');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 280);
    },
  };

  const buttons = {
    new:           { show: false },
    newFolder:     { show: false },
    sort:          { show: true },
    collapse:      { show: true },
    revealCurrent: { show: true, title: 'Reveal current doc' },
    revealInFiles: { show: true, title: 'Reveal in files', onClick: () => openInFiles('Iskariel/Docs', { isFolder: true, root: 'app' }) },
  };

  if (!manifest) return null;
  return <TreeSidebar nodes={nodes} controller={controller} buttons={buttons} accent={accent}/>;
}

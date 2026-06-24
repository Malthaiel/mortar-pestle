// Library left sidebar — now the shared candy tree (TreeSidebar), matching the
// vault. The two media types are collapsible folder pills (Anime · Music), each
// holding status-count rows (LABEL · count) that route to the existing filtered
// library grids; Homepage, Total, Downloaded / Not Downloaded sit alongside the
// statuses. Counts come from the shared useAnimeStats / useMusicStats stores (the
// same aggregation the topbars now read). Both folders collapsed by default.
// Toolbar: Collapse/Expand all, Reveal current, Reveal in files (the active media
// type's folder under the Library vault).

import { useMemo } from 'react';
import { navigate } from '@host/router.js';
import TreeSidebar from '@host/components/vault-tree/TreeSidebar.jsx';
import { useTreeExpansion } from '@host/components/vault-tree/useTreeExpansion.js';
import { openInFiles } from '@host/components/vault-tree/revealInFiles.js';
import { useAnimeStats } from './useAnimeStats.js';
import { useMusicStats } from './music/useMusicStats.js';

const ANIME = '/tools/library/anime';
const MUSIC = '/tools/library/music';

// Status-count rows for each folder. status keys match the frontmatter Status
// values (and URL segments) the topbar tiles used; Homepage carries no count.
function animeRows(s) {
  return [
    { label: 'Homepage',       path: ANIME },
    { label: 'Watching',       path: `${ANIME}/library/Currently-Watching`, count: s.byStatus['Currently-Watching'] || 0 },
    { label: 'Completed',      path: `${ANIME}/library/Completed`,          count: s.byStatus['Completed'] || 0 },
    { label: 'On-Hold',        path: `${ANIME}/library/On-Hold`,            count: s.byStatus['On-Hold'] || 0 },
    { label: 'Dropped',        path: `${ANIME}/library/Dropped`,            count: s.byStatus['Dropped'] || 0 },
    { label: 'Plan',           path: `${ANIME}/library/Plan-to-Watch`,      count: s.byStatus['Plan-to-Watch'] || 0 },
    { label: 'Total',          path: `${ANIME}/library`,                    count: s.total },
    { label: 'Downloaded',     path: `${ANIME}/library/Downloaded`,         count: s.downloaded },
    { label: 'Not Downloaded', path: `${ANIME}/library/Not-Downloaded`,     count: s.total - s.downloaded },
  ];
}
function musicRows(s) {
  return [
    { label: 'Homepage',       path: MUSIC },
    { label: 'Playlists',      path: `${MUSIC}/playlists` },
    { label: 'Listening',      path: `${MUSIC}/library/Currently-Listening`, count: s.byStatus['Currently-Listening'] || 0 },
    { label: 'Listened',       path: `${MUSIC}/library/Listened`,            count: s.byStatus['Listened'] || 0 },
    { label: 'Plan',           path: `${MUSIC}/library/Plan-to-Listen`,      count: s.byStatus['Plan-to-Listen'] || 0 },
    { label: 'Dropped',        path: `${MUSIC}/library/Dropped`,             count: s.byStatus['Dropped'] || 0 },
    { label: 'Total',          path: `${MUSIC}/library`,                     count: s.total },
    { label: 'Downloaded',     path: `${MUSIC}/library/Downloaded`,          count: s.downloaded },
    { label: 'Not Downloaded', path: `${MUSIC}/library/Not-Downloaded`,      count: s.total - s.downloaded },
  ];
}

// The "· count" that rides after the label (preserves the hug-width pill style).
function Count({ value }) {
  return <span style={{ flexShrink: 0, opacity: 0.65 }}>· {value}</span>;
}

export default function LibraryNav({ route, accent }) {
  const anime = useAnimeStats();
  const music = useMusicStats();
  const exp = useTreeExpansion('library:tree:expanded', []); // both folders collapsed by default

  const currentPath = '/tools/library/' + (route?.rest || '');
  const seg = (route?.rest || '').split('/')[0];
  const loading = anime.loading || music.loading;

  const nodes = useMemo(() => {
    const toNode = (r) => ({
      id: r.path,
      label: r.label,
      isFolder: false,
      active: currentPath === r.path,
      onActivate: () => navigate(r.path),
      trailing: r.count == null ? null : <Count value={loading ? '—' : r.count}/>,
    });
    return [
      { id: 'anime', label: 'Anime', isFolder: true, children: animeRows(anime).map(toNode) },
      { id: 'music', label: 'Music', isFolder: true, children: musicRows(music).map(toNode) },
    ];
  }, [anime, music, currentPath, loading]);

  const controller = {
    isOpen: exp.isOpen,
    toggle: exp.toggle,
    anyExpanded: exp.anyExpanded,
    expandAll: () => exp.expandAll(['anime', 'music']),
    collapseAll: exp.collapseAll,
    canReveal: true,
    revealCurrent: () => {
      exp.reveal([seg === 'music' ? 'music' : 'anime']);
      setTimeout(() => {
        const el = document.querySelector('[data-current-file="true"]');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 280);
    },
  };

  const buttons = {
    new:           { show: false },
    newFolder:     { show: false },
    sort:          { show: false },
    collapse:      { show: true },
    revealCurrent: { show: true, title: 'Reveal current' },
    // Reveal the active media type's folder under the Library vault (~/.local/
    // share/.../Library/{Anime,Music}). 'library' root → library_vault_root.
    revealInFiles: { show: true, title: 'Reveal in files',
      onClick: () => openInFiles(seg === 'music' ? 'Music' : 'Anime', { isFolder: true, root: 'library' }) },
  };

  return <TreeSidebar nodes={nodes} controller={controller} buttons={buttons} accent={accent}/>;
}

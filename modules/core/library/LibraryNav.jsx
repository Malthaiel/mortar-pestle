// Library left sidebar — now the shared candy tree (TreeSidebar), matching the
// vault. The two media types are collapsible folder pills (Anime · Music), each
// holding a nested "Library" folder of status-count rows (LABEL · count) that
// route to the existing filtered library grids; Total, Downloaded / Not Downloaded
// ride inside it alongside the statuses, while Homepage stays directly under the
// media pill. Counts come from the shared useAnimeStats /
// useMusicStats stores (the same aggregation the topbars now read). All folders
// collapsed by default.
// Toolbar: Collapse/Expand all, Reveal current, Reveal in files (the active media
// type's folder under the Library vault).

import { useMemo } from 'react';
import { navigate } from '@host/router.js';
import TreeSidebar from '@host/components/vault-tree/TreeSidebar.jsx';
import { useTreeExpansion } from '@host/components/vault-tree/useTreeExpansion.js';
import { openInFiles } from '@host/components/vault-tree/revealInFiles.js';
import { useAnimeStats, useTvStats, useMovieStats } from './useAnimeStats.js';
import { useMusicStats } from './music/useMusicStats.js';

const ANIME = '/tools/library/anime';
const TV = '/tools/library/tv';
const MOVIES = '/tools/library/movies';
const MUSIC = '/tools/library/music';

// Rows that sit directly under the media pill (no count).
const animeTopRows = [{ label: 'Homepage', path: ANIME }];
// Playlists lost its row 2026-08-08: the Music library column is permanent now
// and lists playlists itself, so the tree entry was a second door to one room.
const musicTopRows = [{ label: 'Homepage', path: MUSIC }];
const tvTopRows = [{ label: 'Homepage', path: TV }];
const movieTopRows = [{ label: 'Homepage', path: MOVIES }];

// Status-count rows for each media type's nested "Library" folder. status keys
// match the frontmatter Status values (and URL segments) the topbar tiles used.
function animeRows(s) {
  return [
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
// TV keeps the anime status vocabulary — one series engine, one set of verbs.
function tvRows(s) {
  return [
    { label: 'Watching',       path: `${TV}/library/Currently-Watching`, count: s.byStatus['Currently-Watching'] || 0 },
    { label: 'Completed',      path: `${TV}/library/Completed`,          count: s.byStatus['Completed'] || 0 },
    { label: 'On-Hold',        path: `${TV}/library/On-Hold`,            count: s.byStatus['On-Hold'] || 0 },
    { label: 'Dropped',        path: `${TV}/library/Dropped`,            count: s.byStatus['Dropped'] || 0 },
    { label: 'Plan',           path: `${TV}/library/Plan-to-Watch`,      count: s.byStatus['Plan-to-Watch'] || 0 },
    { label: 'Total',          path: `${TV}/library`,                    count: s.total },
    { label: 'Downloaded',     path: `${TV}/library/Downloaded`,         count: s.downloaded },
    { label: 'Not Downloaded', path: `${TV}/library/Not-Downloaded`,     count: s.total - s.downloaded },
  ];
}
// A film is watched once: no Watching, no On-Hold — those two verbs only mean
// something for a title you are partway through across many sittings.
function movieRows(s) {
  return [
    { label: 'Completed',      path: `${MOVIES}/library/Completed`,      count: s.byStatus['Completed'] || 0 },
    { label: 'Plan',           path: `${MOVIES}/library/Plan-to-Watch`,  count: s.byStatus['Plan-to-Watch'] || 0 },
    { label: 'Dropped',        path: `${MOVIES}/library/Dropped`,        count: s.byStatus['Dropped'] || 0 },
    { label: 'Total',          path: `${MOVIES}/library`,                count: s.total },
    { label: 'Downloaded',     path: `${MOVIES}/library/Downloaded`,     count: s.downloaded },
    { label: 'Not Downloaded', path: `${MOVIES}/library/Not-Downloaded`, count: s.total - s.downloaded },
  ];
}
function musicRows(s) {
  return [
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
  const tv = useTvStats();
  const movies = useMovieStats();
  const music = useMusicStats();
  const exp = useTreeExpansion('library:tree:expanded', []); // every folder collapsed by default

  const currentPath = '/tools/library/' + (route?.rest || '');
  const seg = (route?.rest || '').split('/')[0];
  const loading = anime.loading || tv.loading || movies.loading || music.loading;

  const nodes = useMemo(() => {
    const toNode = (r) => ({
      id: r.path,
      label: r.label,
      isFolder: false,
      active: currentPath === r.path,
      onActivate: () => navigate(r.path),
      trailing: r.count == null ? null : <Count value={loading ? '—' : r.count}/>,
    });
    const libFolder = (id, rows) => ({ id, label: 'Library', isFolder: true, children: rows.map(toNode) });
    return [
      { id: 'anime', label: 'Anime', isFolder: true,
        children: [...animeTopRows.map(toNode), libFolder('anime:library', animeRows(anime))] },
      { id: 'tv', label: 'TV Shows', isFolder: true,
        children: [...tvTopRows.map(toNode), libFolder('tv:library', tvRows(tv))] },
      { id: 'movies', label: 'Movies', isFolder: true,
        children: [...movieTopRows.map(toNode), libFolder('movies:library', movieRows(movies))] },
      { id: 'music', label: 'Music', isFolder: true,
        children: [...musicTopRows.map(toNode), libFolder('music:library', musicRows(music))] },
    ];
  }, [anime, tv, movies, music, currentPath, loading]);

  const controller = {
    isOpen: exp.isOpen,
    toggle: exp.toggle,
    anyExpanded: exp.anyExpanded,
    expandAll: () => exp.expandAll(['anime', 'anime:library', 'tv', 'tv:library', 'movies', 'movies:library', 'music', 'music:library']),
    collapseAll: exp.collapseAll,
    canReveal: true,
    revealCurrent: () => {
      const media = seg === 'music' ? 'music' : seg === 'tv' ? 'tv' : seg === 'movies' ? 'movies' : 'anime';
      // Open the media pill AND its nested Library folder — the active row lives
      // inside the latter for every filtered grid.
      exp.reveal([media, `${media}:library`]);
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
      onClick: () => openInFiles(seg === 'music' ? 'Music' : seg === 'tv' ? 'TV Shows' : seg === 'movies' ? 'Movies' : 'Anime', { isFolder: true, root: 'library' }) },
  };

  return <TreeSidebar nodes={nodes} controller={controller} buttons={buttons} accent={accent}/>;
}

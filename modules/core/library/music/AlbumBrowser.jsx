// LEFT pane of the Music page — the permanent library column beside EVERY Music
// screen. Fetches the album list + playlists, exposes a Playlists / Albums /
// Both selector plus a search box and status / sort selects, and renders the
// tiles as ONE grid: under Both, playlists and albums mix, with no headings
// (user-directed 2026-09-28). Saved Tracks is pinned first.

import { useEffect, useMemo, useState } from 'react';
import { musicApi, subscribeManifest } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import CoverArtCard from './CoverArtCard.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import SearchRun from '@host/components/ui/SearchRun.jsx';
import {
  IconLayers, IconDownload, IconGlobe,
  IconNotes, IconMusic, IconLayoutGrid,
  IconCalendar, IconStarMark, IconMic, IconTag, IconTypeText, IconSort,
} from '@host/components/icons.jsx';
import { statusLabel, STATUS_ICON } from '@host/util/media-status.js';
import { Cluster, useRailOrder } from '@host/components/ui/Rail.jsx';
import { useSidebarOrder, applyOrder } from '@host/hooks/useSidebarOrder.js';
import { usePlaylists, isSavedTracks } from './PlaylistProvider.jsx';
import { PlaylistCard } from './PlaylistsPage.jsx';
import { TILE_GRID, TILE_GAP, RUN_SIZE, RUN_VARS } from './util.js';
import { encodePath } from '../paths.js';
import { navigate as go } from '@host/router.js';

// One row per sort dimension; picking a row activates it with the default
// direction, picking the active one again flips it. The active row and the
// trigger both carry the direction arrow.
// `mixes`: a playlist carries this value too (the playlist list has mtime and
// title), so under Both it sorts in among the albums; under the rest the
// playlists follow the sorted albums (user-picked 2026-09-28).
const SORT_DIMENSIONS = [
  { key: 'added',    label: 'Date Added', icon: IconCalendar, defaultDir: 'desc', mixes: true, value: a => a.mtime || 0 },
  // The typed ★ is gone with the glyph gutter — it was a stand-in for exactly
  // the icon the row now carries, and kept both would read as two stars.
  { key: 'personal', label: 'Personal',   icon: IconStarMark, defaultDir: 'desc', value: a => Number(a.personalRating) || 0 },
  { key: 'artist',   label: 'Artist',     icon: IconMic,      defaultDir: 'asc',  value: a => (a.artist || '').toLowerCase() },
  { key: 'year',     label: 'Year',       icon: IconTag,      defaultDir: 'desc', value: a => a.year || 0 },
  { key: 'title',    label: 'Title',      icon: IconTypeText, defaultDir: 'asc',  mixes: true, value: a => (a.title || '').toLowerCase() },
  // Custom carries no comparator: the tiles keep the hand-made order and the
  // grid becomes a Cluster you can drag. It is the ONLY sort under which the
  // tiles lift (user-directed 2026-09-04 - no auto-switch on drag), and it has
  // no direction, because a hand-made order has no forwards or backwards.
  { key: 'custom',   label: 'Custom',     icon: IconSort,     defaultDir: 'asc' },
];
const isCustom = (key) => key === 'custom';

const ALL_STATUS_ICON = IconLayers;

// Custom has no direction to show — onPillClick never flips one for it, and the
// stale sortDir from the previous dimension would otherwise paint an arrow that
// means nothing.
const sortArrow = (dim, sortDim, sortDir) =>
  (sortDim === dim.key && !isCustom(dim.key)) ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';

const activeSortDim = (sortDim) =>
  SORT_DIMENSIONS.find(d => d.key === sortDim) || SORT_DIMENSIONS[0];


const SORT_LS_KEY = 'tools:musicSort';
const VIEW_LS_KEY = 'tools:musicPaneView';
// The view picker is the third dropdown in the Sort | Status run (user-directed
// 2026-09-24; was its own three-chip run). Every row carries its mark, which the
// trigger wears like the other two.
const VIEW_OPTIONS = [
  { value: 'playlists', label: 'Playlists', icon: IconNotes },
  { value: 'albums',    label: 'Albums',    icon: IconMusic },
  { value: 'both',      label: 'Both',      icon: IconLayoutGrid },
];

// The downloaded/not half of the Status dropdown. An album counts as downloaded
// when it has at least one track on disk — the SAME measure useMusicStats counts
// with, read off the album, never restated as a flag of our own.
const DL_OPTIONS = [
  { value: 'dl:yes', label: 'Downloaded',     icon: IconDownload },
  { value: 'dl:no',  label: 'Not Downloaded', icon: IconGlobe },
];
const isDownloaded = (a) => (a.tracksPresent || 0) > 0;


export default function AlbumBrowser({ accent, onSelect, selectedPath }) {
  const [albums, setAlbums] = useState(null);
  const [sortDim, setSortDim] = useState(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(SORT_LS_KEY) : null;
    const dim = (saved || '').split('-')[0];
    return SORT_DIMENSIONS.find(d => d.key === dim) ? dim : 'added';
  });
  const [sortDir, setSortDir] = useState(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(SORT_LS_KEY) : null;
    const parts = (saved || '').split('-');
    const dim = SORT_DIMENSIONS.find(d => d.key === parts[0]);
    if (dim && (parts[1] === 'asc' || parts[1] === 'desc')) return parts[1];
    return (dim || SORT_DIMENSIONS[0]).defaultDir;
  });
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(null); // null = all
  // Second, INDEPENDENT pick in the same dropdown: null = both kinds shown.
  const [dlFilter, setDlFilter] = useState(null);           // null | 'dl:yes' | 'dl:no'
  const [view, setView] = useState(() => {
    try { return VIEW_OPTIONS.some(o => o.value === localStorage.getItem(VIEW_LS_KEY)) ? localStorage.getItem(VIEW_LS_KEY) : 'both'; } catch { return 'both'; }
  });
  const { playAlbumTracks } = useMusicPlayer();
  const { playlists } = usePlaylists();

  useEffect(() => {
    try { localStorage.setItem(VIEW_LS_KEY, view); } catch {}
  }, [view]);

  useEffect(() => {
    try { localStorage.setItem(SORT_LS_KEY, `${sortDim}-${sortDir}`); } catch {}
  }, [sortDim, sortDir]);

  const onPillClick = (dim) => {
    if (isCustom(dim.key)) { setSortDim(dim.key); return; }   // no direction to flip
    if (sortDim === dim.key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortDim(dim.key); setSortDir(dim.defaultDir); }
  };

  useEffect(() => {
    let cancelled = false;
    musicApi.listAlbums()
      .then((albums) => { if (!cancelled) setAlbums(albums || []); })
      .catch(() => { if (!cancelled) setAlbums([]); });
    const unsub = subscribeManifest(() => {
      musicApi.listAlbums().then((albums) => setAlbums(albums || [])).catch(() => {});
    });
    // Patch local state when AlbumDetail mutates an album (status/rating).
    const onLocal = (e) => {
      const d = e.detail || {};
      if (!d.path) return;
      setAlbums(prev => prev.map(a => a.path === d.path ? { ...a, ...d } : a));
    };
    window.addEventListener('album-updated', onLocal);
    // A finished download writes new pages directly (no manifest event fires) —
    // re-list so the new album appears without an app restart.
    const onLibraryChange = () => {
      musicApi.listAlbums().then((a) => setAlbums(a || [])).catch(() => {});
    };
    window.addEventListener('music-library-changed', onLibraryChange);
    return () => {
      cancelled = true;
      unsub();
      window.removeEventListener('album-updated', onLocal);
      window.removeEventListener('music-library-changed', onLibraryChange);
    };
  }, []);

  // Fixed listen-verb status list per Citadel music schema. Rows show even when
  // no album carries that value so the user can dial in early-state libraries.
  const statuses = ['Plan-to-Listen', 'Currently-Listening', 'Listened', 'Dropped'];

  // What each filter lets through. The search box matches playlists by title
  // and albums by title or artist; Status and Files hide albums only
  // (user-picked 2026-09-28).
  const q = query.trim().toLowerCase();
  const has = (s) => (s || '').toLowerCase().includes(q);
  const playlistShown = (p) => !q || has(p.title);
  const albumShown = (a) =>
    (!q || has(a.title) || has(a.artist)) &&
    (!statusFilter || a.status === statusFilter) &&
    (!dlFilter || isDownloaded(a) === (dlFilter === 'dl:yes'));

  const onPlay = async (album) => {
    try {
      const detail = await musicApi.readAlbum(album.path);
      playAlbumTracks(detail, 0);
    } catch {}
  };

  // Playlists and albums share ONE hand-made order in every view (user-directed
  // 2026-09-28): Playlists and Albums are that order with the other kind hidden.
  // Until the first drag writes it, it falls back to the two per-kind orders it
  // replaced, playlists first, so nothing moves on the switch.
  // ponytail: the old keys are read only as that seed; drop them once
  // music:library has been written.
  const { order: oldPlaylistOrder } = useSidebarOrder('music:playlists');
  const { order: oldAlbumOrder } = useSidebarOrder('music:albums');
  const playlistPaths = useMemo(() => new Set((playlists || []).map(p => p.path)), [playlists]);
  const isPlaylist = (x) => playlistPaths.has(x.path);
  const library = useMemo(() => [
    ...applyOrder((playlists || []).filter(p => !isSavedTracks(p)), oldPlaylistOrder),
    ...applyOrder(albums || [], oldAlbumOrder),
  ], [playlists, albums, oldPlaylistOrder, oldAlbumOrder]);
  const shown = (x) => isPlaylist(x)
    ? view !== 'albums' && playlistShown(x)
    : view !== 'playlists' && albumShown(x);
  const { ordered, onReorder } = useRailOrder(library, 'music:library', { idOf: x => x.path, show: shown });

  // The hand-made order is what shows under Custom, and always under Playlists
  // (the Sort select is inert there). Every other sort owns the order, so the
  // tiles must not lift (user-directed 2026-09-04).
  const handMade = view === 'playlists' || isCustom(sortDim);
  const dim = activeSortDim(sortDim);
  const mult = sortDir === 'desc' ? -1 : 1;
  const cmp = (a, b) => {
    const va = dim.value(a), vb = dim.value(b);
    return va < vb ? -mult : va > vb ? mult : 0;
  };
  const sorts = (x) => dim.mixes || !isPlaylist(x);
  const body = handMade ? ordered
    : [...ordered.filter(sorts).sort(cmp), ...ordered.filter(x => !sorts(x))];

  // Saved Tracks is pinned first and stays OUT of the order - the same
  // guarantee Spotify gives Liked Songs. Pinned means first and immovable, NOT
  // a grid of its own: held in a second container it could never share the
  // first row. It rides the same grid: `data-no-drag` blocks the lift, and every
  // drop slot is clamped past index 0 so nothing lands in front of it. The
  // store holds only the movable ones, hence the offset by one on the way out.
  const savedTracks = (playlists || []).find(isSavedTracks) || null;
  const pinned = view !== 'albums' && savedTracks && playlistShown(savedTracks) ? savedTracks : null;
  const tiles = pinned ? [pinned, ...body] : body;
  const onTileReorder = (from, to) => {
    // A drop before both lists land would save an order missing one kind.
    if (albums === null || !playlists?.length) return;
    if (!pinned) return onReorder(from, to);
    onReorder(from - 1, Math.max(1, to) - 1);
  };

  const inertUnlessAlbums = view === 'playlists' ? { pointerEvents: 'none' } : undefined;

  // A playlist opens in the right column — the same route the Playlists page uses.
  const openPlaylist = (path) => go('/tools/library/music/playlists/' + encodePath(path));

  const renderTile = (x) => isPlaylist(x) ? (
    <PlaylistCard key={x.path} playlist={x} accent={accent}
                  pinned={isSavedTracks(x)}
                  onOpen={() => openPlaylist(x.path)} />
  ) : (
    <CoverArtCard key={x.path} album={x} accent={accent}
                  selected={x.path === selectedPath}
                  onSelect={onSelect} onPlay={onPlay} />
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Filter bar — no hairline, run centred left and right. The painted gap
          above the run and the gap from its band to whatever comes first below
          both equal the tiles' own side margin, TILE_GAP (user-directed
          2026-09-25): the bottom reserves only the band, and the body's
          TILE_GAP padding supplies the gap under it. */}
      <div data-spacing-intent="centred-run" data-record-run style={{
        ...RUN_VARS,
        padding: `${TILE_GAP}px 18px var(--candy-depth-small)`,
        display: 'flex', justifyContent: 'safe center',
        flexShrink: 0,
      }}>
        {/* ONE fused run: Search | Sort | Status | View (user-directed
            2026-09-24; the field used to sit on its own line above the three).
            SearchRun owns the field: clicking it slides the three out through
            the row's end and the field takes the whole row (user-directed
            2026-09-24). Sort and Status stay DRAWN but inert under Playlists —
            neither means anything without albums on screen, and hiding them
            would reflow the run on every view change (user-directed
            2026-09-20). Inert, never faded: a .55 opacity erases a small candy
            button. Per part, not on the run, or View and the field would lock
            too. */}
          <SearchRun value={query} onChange={setQuery} size={RUN_SIZE}>
            {/* Picking the active dimension again flips its direction, exactly
                as the old pills did — CandySelect fires onChange on a re-pick. */}
            <CandySelect
              fuse shape="chip" accent={accent}
              style={inertUnlessAlbums}
              value={sortDim}
              options={SORT_DIMENSIONS.map(d => ({
                value: d.key,
                label: d.label + sortArrow(d, sortDim, sortDir),
                icon: d.icon,
              }))}
              onChange={(k) => onPillClick(activeSortDim(k))}
              title="Sort"
            />
            {/* ONE dropdown, TWO independent picks (user-directed 2026-09-20):
                a status AND a downloaded state. Neither download row picked =
                both kinds shown. The array `value` is what lets both rows tick
                and both marks reach the trigger. */}
            <CandySelect
              fuse shape="chip" accent={accent}
              style={inertUnlessAlbums}
              value={[statusFilter, dlFilter].filter(Boolean)}
              options={[
                { header: 'Status' },
                ...statuses.map(s => ({ value: s, label: statusLabel(s), icon: STATUS_ICON[s] })),
                { divider: true },
                { header: 'Files' },
                ...DL_OPTIONS,
              ]}
              icon={ALL_STATUS_ICON}
              placeholder="All Status"
              onChange={(v) => v.startsWith('dl:')
                ? setDlFilter(cur => cur === v ? null : v)
                : setStatusFilter(cur => cur === v ? null : v)}
              title="Filter by status and downloaded state"
            />
            <CandySelect
              fuse shape="chip" accent={accent}
              value={view}
              options={VIEW_OPTIONS}
              onChange={setView}
              title="Show playlists, albums or both"
            />
          </SearchRun>
      </div>

      {/* Body — one tile grid */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        // Edge margin equals the gap BETWEEN tiles on all four sides; the bottom
        // carries the depth band the same way the row gap does.
        padding: TILE_GAP,
        paddingBottom: `calc(${TILE_GAP}px + var(--candy-tile-depth))`,
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        {albums === null && view !== 'playlists' && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Loading</div>
        )}

        {/* Distinct copy per cause: a filtered-to-nothing list and a genuinely
            empty one look identical otherwise, which cost a debugging session. */}
        {albums !== null && tiles.length === 0 && (
          <Empty>{view === 'playlists' ? (q ? 'No playlists match.' : 'No playlists yet.')
            : view === 'albums' ? 'No albums match.' : 'Nothing matches.'}</Empty>
        )}

        {/* ONE grid in every view, no headings (user-directed 2026-09-28). One
            renderTile feeds both branches so each tile exists once. */}
        {handMade ? (
          <Cluster
            style={TILE_GRID}
            items={tiles}
            keyOf={x => x.path}
            onReorder={onTileReorder}
            renderItem={renderTile}
          />
        ) : (
          <div style={TILE_GRID}>{tiles.map(x => renderTile(x))}</div>
        )}
      </div>
    </div>
  );
}

function Empty({ children }) {
  return (
    <div style={{ color: 'var(--text-faint)', fontSize: 12, textAlign: 'center', padding: 24 }}>
      {children}
    </div>
  );
}



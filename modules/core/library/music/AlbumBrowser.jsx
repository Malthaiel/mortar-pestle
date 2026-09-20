// LEFT pane of the Music page — the permanent library column beside EVERY Music
// screen. Fetches the album list + playlists, exposes a Playlists / Albums /
// Both selector plus a search box and status / sort selects, and renders the tiles.
// Saved Tracks is pinned first among the playlists.

import { useEffect, useMemo, useState } from 'react';
import { musicApi, subscribeManifest } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import CoverArtCard from './CoverArtCard.jsx';
import { Seg } from '@host/components/ui/index.js';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import {
  IconLayers,
  IconCalendar, IconStar, IconMic, IconTag, IconTypeText, IconSort,
} from '@host/components/icons.jsx';
import { statusLabel, STATUS_ICON } from '@host/util/media-status.js';
import { Cluster, useRailOrder } from '@host/components/ui/Rail.jsx';
import { usePlaylists, isSavedTracks } from './PlaylistProvider.jsx';
import { PlaylistCard } from './PlaylistsPage.jsx';
import { TILE_GRID, TILE_GAP } from './util.js';
import { encodePath } from '../paths.js';
import { navigate as go } from '@host/router.js';

// One row per sort dimension; picking a row activates it with the default
// direction, picking the active one again flips it. The active row and the
// trigger both carry the direction arrow.
const SORT_DIMENSIONS = [
  { key: 'added',    label: 'Date Added', icon: IconCalendar, defaultDir: 'desc', value: a => a.mtime || 0 },
  // The typed ★ is gone with the glyph gutter — it was a stand-in for exactly
  // the icon the row now carries, and kept both would read as two stars.
  { key: 'personal', label: 'Personal',   icon: IconStar,     defaultDir: 'desc', value: a => Number(a.personalRating) || 0 },
  { key: 'artist',   label: 'Artist',     icon: IconMic,      defaultDir: 'asc',  value: a => (a.artist || '').toLowerCase() },
  { key: 'year',     label: 'Year',       icon: IconTag,      defaultDir: 'desc', value: a => a.year || 0 },
  { key: 'title',    label: 'Title',      icon: IconTypeText, defaultDir: 'asc',  value: a => (a.title || '').toLowerCase() },
  // Custom carries no comparator: `filtered` returns the list unsorted and the
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
const VIEW_OPTIONS = [
  { value: 'playlists', label: 'Playlists' },
  { value: 'albums', label: 'Albums' },
  { value: 'both', label: 'Both' },
];

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

  // Saved Tracks is pinned first; the rest keep the provider's order. The search
  // box filters playlists by title, the same way it filters albums.
  const visiblePlaylists = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (playlists || []).filter(p => !q || (p.title || '').toLowerCase().includes(q));
    return [...list].sort((a, b) => (isSavedTracks(b) ? 1 : 0) - (isSavedTracks(a) ? 1 : 0));
  }, [playlists, query]);

  const filtered = useMemo(() => {
    if (!albums) return [];
    const q = query.trim().toLowerCase();
    let out = albums;
    if (q) out = out.filter(a =>
      (a.title || '').toLowerCase().includes(q) ||
      (a.artist || '').toLowerCase().includes(q)
    );
    if (statusFilter) out = out.filter(a => a.status === statusFilter);
    // Custom leaves the order alone so useRailOrder below can impose the saved
    // one. Status/query still filter — one order covers every filter, and
    // applyOrder tolerates the ids a filter hides.
    if (isCustom(sortDim)) return out;
    const dim = SORT_DIMENSIONS.find(d => d.key === sortDim) || SORT_DIMENSIONS[0];
    const mult = sortDir === 'desc' ? -1 : 1;
    const cmp = (a, b) => {
      const va = dim.value(a), vb = dim.value(b);
      if (va < vb) return -1 * mult;
      if (va > vb) return  1 * mult;
      return 0;
    };
    return [...out].sort(cmp);
  }, [albums, query, statusFilter, sortDim, sortDir]);

  const onPlay = async (album) => {
    try {
      const detail = await musicApi.readAlbum(album.path);
      playAlbumTracks(detail, 0);
    } catch {}
  };

  // Saved Tracks is pinned first and stays OUT of the drag group - the same
  // guarantee Spotify gives Liked Songs. Everything behind it reorders freely.
  const savedTracks = visiblePlaylists.find(isSavedTracks) || null;
  const otherPlaylists = useMemo(
    () => visiblePlaylists.filter(p => !isSavedTracks(p)), [visiblePlaylists]);
  const { ordered: orderedPlaylists, onReorder: reorderPlaylists } =
    useRailOrder(otherPlaylists, 'music:playlists', { idOf: p => p.path });
  // Pinned means first and immovable, NOT a grid of its own — held in a second
  // container it could never share the first row, so it sat alone with three
  // empty cells beside it. It rides the same grid now: `data-no-drag` blocks
  // the lift, and every drop slot is clamped past index 0 so nothing lands in
  // front of it. The reorder store still holds only the movable ones, hence
  // the offset by one on the way out.
  const playlistItems = savedTracks ? [savedTracks, ...orderedPlaylists] : orderedPlaylists;
  const onPlaylistReorder = (from, to) => {
    if (!savedTracks) return reorderPlaylists(from, to);
    reorderPlaylists(from - 1, Math.max(1, to) - 1);
  };
  const { ordered: orderedAlbums, onReorder: reorderAlbums } =
    useRailOrder(filtered, 'music:albums', { idOf: a => a.path });

  const renderAlbum = (a, key) => (
    <CoverArtCard
      key={key}
      album={a}
      accent={accent}
      selected={a.path === selectedPath}
      onSelect={onSelect}
      onPlay={onPlay}
    />
  );

  const showAlbums = view === 'albums' || view === 'both';
  const showPlaylists = view === 'playlists' || view === 'both';

  // A playlist opens in the right column — the same route the Playlists page uses.
  const openPlaylist = (path) => go('/tools/library/music/playlists/' + encodePath(path));

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Filter bar */}
      <div style={{
        padding: '14px 18px 10px',
        display: 'flex', flexDirection: 'column', gap: 10,
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <Seg options={VIEW_OPTIONS} value={view} onChange={setView} accent={accent}/>

        <input
          type="text" value={query}
          placeholder={view === 'playlists' ? 'Search playlists' : 'Search title or artist'}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            padding: '7px 10px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
            color: 'var(--text)', fontSize: 12,
            outline: 'none',
          }}
        />

        {showAlbums && (
          <div style={{ display: 'flex', gap: 8 }}>
            <CandySelect
              value={statusFilter || ''}
              options={[
                { value: '', label: 'All Status', icon: ALL_STATUS_ICON },
                ...statuses.map(s => ({ value: s, label: statusLabel(s), icon: STATUS_ICON[s] })),
              ]}
              onChange={(v) => setStatusFilter(v || null)}
              title="Filter by status"
            />
            {/* Picking the active dimension again flips its direction, exactly
                as the old pills did — CandySelect fires onChange on a re-pick. */}
            <CandySelect
              value={sortDim}
              options={SORT_DIMENSIONS.map(d => ({
                value: d.key,
                label: d.label + sortArrow(d, sortDim, sortDir),
                icon: d.icon,
              }))}
              onChange={(k) => onPillClick(activeSortDim(k))}
              title="Sort albums"
            />
          </div>
        )}
      </div>

      {/* Body — playlist tiles and/or the album grid */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        // Edge margin equals the gap BETWEEN tiles on all four sides; the bottom
        // carries the depth band the same way the row gap does.
        padding: TILE_GAP,
        paddingBottom: `calc(${TILE_GAP}px + var(--candy-tile-depth))`,
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        {albums === null && showAlbums && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Loading</div>
        )}

        {showPlaylists && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {view === 'both' && visiblePlaylists.length > 0 && <SectionHeading>Playlists</SectionHeading>}
            {/* Distinct copy per cause: a filtered-to-nothing list and a genuinely
                empty one look identical otherwise, which cost a debugging session. */}
            {visiblePlaylists.length === 0 && (
              <Empty>{query.trim() ? 'No playlists match.' : 'No playlists yet.'}</Empty>
            )}
            <Cluster
              style={TILE_GRID}
              items={playlistItems}
              keyOf={p => p.path}
              onReorder={onPlaylistReorder}
              renderItem={p => (
                <PlaylistCard playlist={p} accent={accent}
                              pinned={isSavedTracks(p)}
                              onOpen={() => openPlaylist(p.path)} />
              )}
            />
          </div>
        )}

        {showAlbums && view === 'both' && albums && filtered.length > 0 && <SectionHeading>Albums</SectionHeading>}

        {showAlbums && (
          <>
            {albums && filtered.length === 0 && <Empty>No albums match.</Empty>}
            {/* Cluster only under the Custom sort - every other sort owns the
                order, so the tiles must not lift there (user-directed). One
                renderAlbum feeds both branches so the tile exists once. */}
            {isCustom(sortDim) ? (
              <Cluster
                style={TILE_GRID}
                items={orderedAlbums}
                keyOf={a => a.path}
                onReorder={reorderAlbums}
                renderItem={renderAlbum}
              />
            ) : (
              <div style={TILE_GRID}>
                {filtered.map(a => renderAlbum(a, a.path))}
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}

// Only shown in "Both", where the two grids need telling apart.
function SectionHeading({ children }) {
  return (
    <div style={{
      fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>{children}</div>
  );
}

function Empty({ children }) {
  return (
    <div style={{ color: 'var(--text-faint)', fontSize: 12, textAlign: 'center', padding: 24 }}>
      {children}
    </div>
  );
}



// LEFT pane of the Music page — the permanent library column beside EVERY Music
// screen. Fetches the album list + playlists, exposes a Playlists / Albums /
// Both selector plus a search box and status / sort selects, and renders the tiles.
// Saved Tracks is pinned first among the playlists.

import { useEffect, useMemo, useState } from 'react';
import { musicApi, subscribeManifest } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import CoverArtCard from './CoverArtCard.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import {
  IconLayers, IconDownload, IconGlobe,
  IconNotes, IconMusic, IconLayoutGrid,
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
// Every part of both runs leads with its mark — the two CandySelects wear the
// current option's icon for free, so these three carry one too or the line reads
// half-marked (user-directed 2026-09-20).
const VIEW_OPTIONS = [
  { value: 'playlists', label: 'Playlists', Icon: IconNotes },
  { value: 'albums',    label: 'Albums',    Icon: IconMusic },
  { value: 'both',      label: 'Both',      Icon: IconLayoutGrid },
];

// The downloaded/not half of the Status dropdown. An album counts as downloaded
// when it has at least one track on disk — the SAME measure useMusicStats counts
// with, read off the album, never restated as a flag of our own.
const DL_OPTIONS = [
  { value: 'dl:yes', label: 'Downloaded',     icon: IconDownload },
  { value: 'dl:no',  label: 'Not Downloaded', icon: IconGlobe },
];
const isDownloaded = (a) => (a.tracksPresent || 0) > 0;

// Height of every fused part, one constant for both runs (.candy-split derives
// corner, seam, overlap and part height from it — see styles.css § candy-split).
const RUN_SIZE = '27px';
// The field is the SAME height as the five buttons under it (user-directed
// 2026-09-20), so it takes RUN_SIZE too rather than a second number that could
// drift from it.

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
    if (dlFilter) out = out.filter(a => isDownloaded(a) === (dlFilter === 'dl:yes'));
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
  }, [albums, query, statusFilter, dlFilter, sortDim, sortDir]);

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
        {/* The agent chat's type box, 1-1 (user-directed 2026-09-20): the field
            IS a candy button — chip-field + .candy-face + a bare
            .chip-field-input — so it wears the same frame, band and hover flip
            as the two runs under it instead of reading as a foreign input.
            Same markup as ChatInput.jsx; --cbtn-size is the one height knob. */}
        {/* A one-part .candy-split: the run's own rule pins every child to
            --cbtn-size, which is how the five buttons below get their height —
            reusing it here means ONE number drives all six and no new CSS.
            A lone child keeps both outer ends round (the squaring rules are
            :not(:first-child) / :not(:last-child)). */}
        <span className="candy-split" style={{ '--cbtn-size': RUN_SIZE, display: 'flex' }}>
        <span className="candy-btn" data-shape="chip-field" style={{ width: '100%' }}>
          <span className="candy-face">
            <input
              className="chip-field-input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={view === 'playlists' ? 'Search playlists' : 'Search title or artist'}
            />
          </span>
        </span>
        </span>

        {/* Two fused runs on one line: Sort | Status, then the view picker.
            The first run stays DRAWN but inert under Playlists — neither knob
            means anything without albums on screen, and hiding two of the four
            would reflow the whole bar on every view change (user-directed
            2026-09-20). Inert, never faded: a .55 opacity erases a small candy
            button. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <div className="candy-split is-plain-label"
               style={{ '--cbtn-size': RUN_SIZE,
                        pointerEvents: showAlbums ? undefined : 'none' }}>
            {/* Picking the active dimension again flips its direction, exactly
                as the old pills did — CandySelect fires onChange on a re-pick. */}
            <CandySelect
              fuse shape="chip" accent={accent}
              value={sortDim}
              options={SORT_DIMENSIONS.map(d => ({
                value: d.key,
                label: d.label + sortArrow(d, sortDim, sortDir),
                icon: d.icon,
              }))}
              onChange={(k) => onPillClick(activeSortDim(k))}
              title="Sort albums"
            />
            {/* ONE dropdown, TWO independent picks (user-directed 2026-09-20):
                a status AND a downloaded state. Neither download row picked =
                both kinds shown. The array `value` is what lets both rows tick
                and both marks reach the trigger. */}
            <CandySelect
              fuse shape="chip" accent={accent}
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
          </div>

          <div className="candy-split is-plain-label" style={{ '--cbtn-size': RUN_SIZE }}>
            {VIEW_OPTIONS.map(o => (
              <button key={o.value} type="button" data-own-press
                      className={'candy-btn' + (view === o.value ? ' is-active' : '')}
                      data-shape="chip"
                      style={accent ? { '--accent': accent } : undefined}
                      onClick={() => setView(o.value)}>
                {/* .candy-face is already inline-flex with a 6px gap — a leading
                    icon needs no wrapper and no new prop. */}
                <span className="candy-face"><o.Icon size={12}/>{o.label}</span>
              </button>
            ))}
          </div>
        </div>
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
      letterSpacing: '0.08em',     }}>{children}</div>
  );
}

function Empty({ children }) {
  return (
    <div style={{ color: 'var(--text-faint)', fontSize: 12, textAlign: 'center', padding: 24 }}>
      {children}
    </div>
  );
}



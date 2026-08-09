// LEFT pane of the Music page. Fetches the album list, exposes sort / search /
// status pills / genre chips, renders a cover-art grid.

import { useEffect, useMemo, useState } from 'react';
import { musicApi, subscribeManifest } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import CoverArtCard from './CoverArtCard.jsx';
import { FilterChip as Pill, Seg } from '@host/components/ui/index.js';
import { SEARCH_TABS, useSearchTab, trackRowProps, markTrackHighlight } from './searchShared.jsx';
import ResultRow from './ResultRow.jsx';

// Single pill per sort dimension; click activates with the default direction,
// click again flips direction. Active pill renders the direction arrow.
const SORT_DIMENSIONS = [
  { key: 'added',    label: 'Date Added', defaultDir: 'desc', value: a => a.mtime || 0 },
  { key: 'personal', label: '★ Personal', defaultDir: 'desc', value: a => Number(a.personalRating) || 0 },
  { key: 'artist',   label: 'Artist',     defaultDir: 'asc',  value: a => (a.artist || '').toLowerCase() },
  { key: 'year',     label: 'Year',       defaultDir: 'desc', value: a => a.year || 0 },
  { key: 'title',    label: 'Title',      defaultDir: 'asc',  value: a => (a.title || '').toLowerCase() },
];

const SORT_LS_KEY = 'tools:musicSort';

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
  const [tab, setTab] = useSearchTab('tools:musicPaneTab');
  const [artistFilter, setArtistFilter] = useState(null); // null = all
  const [songs, setSongs] = useState(null);
  const { playAlbumTracks } = useMusicPlayer();

  useEffect(() => {
    try { localStorage.setItem(SORT_LS_KEY, `${sortDim}-${sortDir}`); } catch {}
  }, [sortDim, sortDir]);

  const onPillClick = (dim) => {
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

  // Fixed listen-verb status list per Citadel music schema. Pills render even
  // when no album carries that value so the user can dial in early-state
  // libraries.
  const statuses = ['Plan-to-Listen', 'Currently-Listening', 'Listened', 'Dropped'];

  // Local track search for the Songs tab. Library-only here — this pane is your
  // own collection, so it never reaches out to MusicBrainz.
  useEffect(() => {
    if (tab !== 'songs') { setSongs(null); return; }
    const q = query.trim();
    if (!q) { setSongs([]); return; }
    let cancelled = false;
    setSongs(null);
    const t = setTimeout(() => {
      musicApi.searchTracks(q, 60)
        .then(hits => { if (!cancelled) setSongs(hits || []); })
        .catch(() => { if (!cancelled) setSongs([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [tab, query]);

  // Owned artists with their album counts, most albums first.
  const artists = useMemo(() => {
    const counts = new Map();
    for (const a of albums || []) {
      const name = a.artist || '';
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const q = query.trim().toLowerCase();
    return [...counts.entries()]
      .filter(([name]) => !q || name.toLowerCase().includes(q))
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([name, count]) => ({ name, count }));
  }, [albums, query]);

  const filtered = useMemo(() => {
    if (!albums) return [];
    const q = query.trim().toLowerCase();
    let out = albums;
    if (q) out = out.filter(a =>
      (a.title || '').toLowerCase().includes(q) ||
      (a.artist || '').toLowerCase().includes(q)
    );
    if (artistFilter) out = out.filter(a => a.artist === artistFilter);
    if (statusFilter) out = out.filter(a => a.status === statusFilter);
    const dim = SORT_DIMENSIONS.find(d => d.key === sortDim) || SORT_DIMENSIONS[0];
    const mult = sortDir === 'desc' ? -1 : 1;
    const cmp = (a, b) => {
      const va = dim.value(a), vb = dim.value(b);
      if (va < vb) return -1 * mult;
      if (va > vb) return  1 * mult;
      return 0;
    };
    return [...out].sort(cmp);
  }, [albums, query, statusFilter, artistFilter, sortDim, sortDir]);

  const onPlay = async (album) => {
    try {
      const detail = await musicApi.readAlbum(album.path);
      playAlbumTracks(detail, 0);
    } catch {}
  };

  const showGrid = tab === 'all' || tab === 'albums';

  // A song opens its album on the right with that row highlighted. Mark first,
  // then select: AlbumDetail claims the mark as it mounts on the new album.
  const onSelectSong = (hit) => {
    markTrackHighlight(hit.albumPath, hit.n, hit.disc);
    onSelect(hit.albumPath);
  };

  // Picking an artist drops you back into the album grid, narrowed to them.
  const onSelectArtist = (name) => {
    setArtistFilter(name);
    setQuery('');
    setTab('albums');
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Filter bar */}
      <div style={{
        padding: '14px 18px 10px',
        display: 'flex', flexDirection: 'column', gap: 10,
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <Seg options={SEARCH_TABS} value={tab} onChange={setTab} accent={accent}/>

        <input
          type="text" value={query}
          placeholder={tab === 'songs' ? 'Search song titles'
                     : tab === 'artists' ? 'Search artists'
                     : 'Search title or artist'}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            padding: '7px 10px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
            color: 'var(--text)', fontSize: 12,
            outline: 'none',
          }}
        />

        {/* Status + sort are album-shaped; they'd be dead controls on the
            Songs and Artists tabs. */}
        {showGrid && (
          <>
            {artistFilter && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Pill active accent={accent} onClick={() => setArtistFilter(null)}>
                  {artistFilter} ×
                </Pill>
              </div>
            )}
            <PillRow
              options={statuses}
              value={statusFilter}
              onChange={setStatusFilter}
              accent={accent}
              allLabel="All Status"
            />
            <SortPillRow dimensions={SORT_DIMENSIONS} sortDim={sortDim} sortDir={sortDir}
                         onPillClick={onPillClick} accent={accent}/>
          </>
        )}
      </div>

      {/* Body — album grid, song rows, or artist rows */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        {albums === null && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Loading…</div>
        )}

        {showGrid && (
          <>
            {albums && filtered.length === 0 && <Empty>No albums match.</Empty>}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
              gap: 14,
            }}>
              {filtered.map(a => (
                <CoverArtCard
                  key={a.path}
                  album={a}
                  accent={accent}
                  selected={a.path === selectedPath}
                  onSelect={onSelect}
                  onPlay={onPlay}
                />
              ))}
            </div>
          </>
        )}

        {tab === 'songs' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {songs === null && <Empty>Searching…</Empty>}
            {songs && songs.length === 0 && (
              <Empty>{query.trim() ? 'No songs match.' : 'Type to search your songs.'}</Empty>
            )}
            {(songs || []).map(t => (
              <ResultRow key={`${t.albumPath}#${t.disc}.${t.n}`} {...trackRowProps(t)}
                         selected={t.albumPath === selectedPath}
                         onClick={() => onSelectSong(t)} />
            ))}
          </div>
        )}

        {tab === 'artists' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {albums && artists.length === 0 && <Empty>No artists match.</Empty>}
            {artists.map(a => (
              <ResultRow key={a.name} title={a.name}
                         right={`${a.count} album${a.count === 1 ? '' : 's'}`}
                         onClick={() => onSelectArtist(a.name)} />
            ))}
          </div>
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

function PillRow({ options, value, onChange, accent, allLabel, scroll }) {
  return (
    <div style={{
      display: 'flex', gap: 6, flexWrap: scroll ? 'nowrap' : 'wrap',
      overflowX: scroll ? 'auto' : 'visible',
      paddingBottom: scroll ? 4 : 0,
    }}>
      <Pill active={value == null} accent={accent} onClick={() => onChange(null)}>{allLabel}</Pill>
      {options.map(o => (
        <Pill key={o} active={value === o} accent={accent} onClick={() => onChange(o)}>{o}</Pill>
      ))}
    </div>
  );
}

function SortPillRow({ dimensions, sortDim, sortDir, onPillClick, accent }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {dimensions.map(dim => {
        const active = sortDim === dim.key;
        const arrow = active ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';
        return (
          <Pill key={dim.key} active={active} accent={accent} onClick={() => onPillClick(dim)}>
            {dim.label}{arrow}
          </Pill>
        );
      })}
    </div>
  );
}


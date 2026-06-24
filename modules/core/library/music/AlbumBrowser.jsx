// LEFT pane of the Music page. Fetches the album list, exposes sort / search /
// status pills / genre chips, renders a cover-art grid.

import { useEffect, useMemo, useState } from 'react';
import { musicApi, subscribeManifest } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import CoverArtCard from './CoverArtCard.jsx';
import { FilterChip as Pill } from '@host/components/ui/index.js';

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

  const filtered = useMemo(() => {
    if (!albums) return [];
    const q = query.trim().toLowerCase();
    let out = albums;
    if (q) out = out.filter(a =>
      (a.title || '').toLowerCase().includes(q) ||
      (a.artist || '').toLowerCase().includes(q)
    );
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
  }, [albums, query, statusFilter, sortDim, sortDir]);

  const onPlay = async (album) => {
    try {
      const detail = await musicApi.readAlbum(album.path);
      playAlbumTracks(detail, 0);
    } catch {}
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
        <input
          type="text" value={query} placeholder="Search title or artist"
          onChange={(e) => setQuery(e.target.value)}
          style={{
            padding: '7px 10px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
            color: 'var(--text)', fontSize: 12,
            outline: 'none',
          }}
        />

        <PillRow
          options={statuses}
          value={statusFilter}
          onChange={setStatusFilter}
          accent={accent}
          allLabel="All Status"
        />
        <SortPillRow dimensions={SORT_DIMENSIONS} sortDim={sortDim} sortDir={sortDir}
                     onPillClick={onPillClick} accent={accent}/>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        {albums === null && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Loading…</div>
        )}
        {albums && filtered.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12, textAlign: 'center', padding: 24 }}>
            No albums match.
          </div>
        )}
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
      </div>
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


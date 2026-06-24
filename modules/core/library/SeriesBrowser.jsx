// LEFT pane of /tools/library/anime. Fetches the series list, exposes search + status
// pills + genre chips, renders a poster grid.

import { useEffect, useMemo, useState } from 'react';
import { videoApi, prefetchCredits } from './api.js';
import { coverSrc, STATUS_DOT_COLOR, resolveDot } from './util.js';
import { FilterChip as Pill } from '@host/components/ui/index.js';

// Single pill per sort dimension; click activates with the default direction,
// click again flips direction. Active pill renders the direction arrow.
const SORT_DIMENSIONS = [
  { key: 'added',    label: 'Date Added', defaultDir: 'desc', value: s => s.mtime || 0 },
  { key: 'personal', label: '★ Personal', defaultDir: 'desc', value: s => Number(s.personalRating) || 0 },
  { key: 'mal',      label: '★ MAL',      defaultDir: 'desc', value: s => Number(s.onlineRating)   || 0 },
  { key: 'year',     label: 'Year',       defaultDir: 'desc', value: s => s.year || 0 },
  { key: 'title',    label: 'Title',      defaultDir: 'asc',  value: s => (s.title || '').toLowerCase() },
];

const SORT_LS_KEY = 'tools:videoSort';

export default function SeriesBrowser({ accent, onSelect, selectedPath, initialStatus = null }) {
  const [series, setSeries] = useState(null);
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
  const [statusFilter, setStatusFilter] = useState(initialStatus);

  // Follow the route: a topbar tile changing `initialStatus` re-seeds the
  // filter, while in-page pill clicks (which don't touch initialStatus) stick.
  useEffect(() => { setStatusFilter(initialStatus); }, [initialStatus]);

  useEffect(() => {
    try { localStorage.setItem(SORT_LS_KEY, `${sortDim}-${sortDir}`); } catch {}
  }, [sortDim, sortDir]);

  const onPillClick = (dim) => {
    if (sortDim === dim.key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortDim(dim.key); setSortDir(dim.defaultDir); }
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      videoApi.listSeries()
        .then((series) => { if (!cancelled) setSeries(series || []); })
        .catch(() => { if (!cancelled) setSeries([]); });
    };
    load();
    // Patch local state when SeriesDetail mutates a series (status/rating).
    const onLocal = (e) => {
      const d = e.detail || {};
      if (!d.path) return;
      setSeries(prev => (prev || []).map(s => s.path === d.path ? { ...s, ...d } : s));
    };
    // Full re-list when the library set changes (download lands, uninstall removes a card).
    window.addEventListener('series-updated', onLocal);
    window.addEventListener('video-library-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('series-updated', onLocal);
      window.removeEventListener('video-library-changed', load);
    };
  }, []);

  const filtered = useMemo(() => {
    if (!series) return [];
    const q = query.trim().toLowerCase();
    let out = series;
    if (q) out = out.filter(s => (s.title || '').toLowerCase().includes(q));
    // Ownership pseudo-statuses (topbar tiles) filter on file presence; real
    // status values filter on frontmatter Status.
    if (statusFilter === 'Downloaded') out = out.filter(s => s.hasLocalFiles);
    else if (statusFilter === 'Not-Downloaded') out = out.filter(s => !s.hasLocalFiles);
    else if (statusFilter) out = out.filter(s => s.status === statusFilter);
    const dim = SORT_DIMENSIONS.find(d => d.key === sortDim) || SORT_DIMENSIONS[0];
    const mult = sortDir === 'desc' ? -1 : 1;
    const cmp = (a, b) => {
      const va = dim.value(a), vb = dim.value(b);
      if (va < vb) return -1 * mult;
      if (va > vb) return  1 * mult;
      return 0;
    };
    return [...out].sort(cmp);
  }, [series, query, statusFilter, sortDim, sortDir]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Filter bar */}
      <div style={{
        padding: '12px 18px',
        display: 'flex', flexDirection: 'column', gap: 12,
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <input
          type="text" value={query} placeholder="Search title"
          onChange={(e) => setQuery(e.target.value)}
          className="candy-input"
          style={{
            padding: '7px 10px',
            color: 'var(--text)', fontSize: 12, outline: 'none',
          }}
        />
        <SortPillRow dimensions={SORT_DIMENSIONS} sortDim={sortDim} sortDir={sortDir}
                     onPillClick={onPillClick} accent={accent}/>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        {series === null && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Loading…</div>}
        {series && filtered.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 12, textAlign: 'center', padding: 24 }}>
            No series match.
          </div>
        )}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
          gap: 14,
        }}>
          {filtered.map(s => (
            <SeriesCard
              key={s.path}
              series={s}
              accent={accent}
              selected={s.path === selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function SeriesCard({ series, accent, selected, onSelect }) {
  const img = coverSrc(series.image);
  const total = series.episodesTotal || 0;
  // Franchise rows: server pre-rolls watchedEpisodes to an integer count.
  // Non-franchise rows: it's an integer array — count its length.
  const watched = typeof series.watchedEpisodes === 'number'
    ? series.watchedEpisodes
    : (series.watchedEpisodes || []).length;
  const progress = total > 0 ? watched / total : 0;
  const statusDot = resolveDot(STATUS_DOT_COLOR, series.status, accent);
  const activate = () => onSelect(series.path);
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  };

  return (
    <div
      onClick={activate}
      onMouseEnter={() => prefetchCredits(series.providerId)}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={'candy-btn' + (selected ? ' is-selected' : '')}
      data-shape="tile"
      style={{ '--accent': accent || 'var(--accent)' }}
    >
      <div className="candy-face" style={{ overflow: 'hidden', padding: 0 }}>
      <div style={{
        aspectRatio: '2 / 3', position: 'relative',
        background: 'var(--surface-3)',
        overflow: 'hidden',
      }}>
        {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>}
        {total > 0 && progress > 0 && (
          <div
            title={`${watched}/${total} watched`}
            style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              height: 3,
              background: `color-mix(in oklch, ${accent} 18%, transparent)`,
            }}
          >
            <div style={{
              width: `${Math.min(100, progress * 100)}%`,
              height: '100%',
              background: accent,
              transition: 'width 200ms ease',
            }}/>
          </div>
        )}
      </div>
      <div style={{ padding: '9px 10px 10px' }}>
        <div style={{
          fontSize: 12, fontWeight: 600, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{series.title}</div>
        <div style={{
          fontSize: 10, color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', marginTop: 4,
          display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
          rowGap: 4,
        }}>
          {series.status && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              color: 'var(--text-muted)',
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: statusDot || 'var(--text-faint)',
                flexShrink: 0,
              }}/>
              <span>{series.status}</span>
            </span>
          )}
          {series.year && (
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{series.year}</span>
          )}
          {total > 0 && (
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{watched}/{total}</span>
          )}
          {series.personalRating > 0 && (
            <span style={{
              color: accent, marginLeft: 'auto', fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
            }}>★{series.personalRating}</span>
          )}
        </div>
      </div>
      </div>
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


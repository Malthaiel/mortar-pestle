// Full-page see-all grid for a discovery category — reached from a homepage
// "See all" link: /tools/library/anime/browse/top, /browse/season, /browse/search/<q>.
// A type-filter bar over a paginated AnimeResultCard grid. Top / Season page
// through anime_top / anime_season_now with an explicit "Load more" button
// (no infinite scroll, per DESIGN); search shows the single Jikan page. Cards
// route to the adaptive detail page by MAL id.

import { useEffect, useMemo, useRef, useState } from 'react';
import { videoApi } from './api.js';
import { FilterChip } from '@host/components/ui/index.js';
import AnimeResultCard from './AnimeResultCard.jsx';
import useLibraryMap from './useLibraryMap.js';

const TYPES = ['TV', 'Movie', 'OVA', 'Special', 'ONA'];
const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 };

function errText(e, fallback) {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return e.code;
  try { return JSON.stringify(e); } catch { return fallback; }
}

export default function BrowseGrid({ accent, mode, query, kind, name }) {
  const [items, setItems] = useState(null);       // accumulated results (null = first load)
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);         // no further pages
  const [typeFilter, setTypeFilter] = useState(() => new Set());
  const pageRef = useRef(1);
  const reqId = useRef(0);
  const libMap = useLibraryMap();

  const fetchPage = (page, append) => {
    const myId = ++reqId.current;
    setLoading(true); setError(null);
    const fetcher = mode === 'top' ? videoApi.animeTop(page)
      : mode === 'season' ? videoApi.animeSeasonNow(page)
      : mode === 'discover' ? videoApi.animeDiscover(kind, name, page)
      : videoApi.animeSearch(query);
    Promise.resolve(fetcher)
      .then(r => {
        if (myId !== reqId.current) return;
        const batch = r || [];
        setItems(prev => (append && prev ? [...prev, ...batch] : batch));
        if (mode === 'search' || batch.length === 0) setDone(true);
      })
      .catch(e => { if (myId === reqId.current) setError(errText(e, 'Failed to load.')); })
      .finally(() => { if (myId === reqId.current) setLoading(false); });
  };

  useEffect(() => {
    pageRef.current = 1;
    setItems(null); setDone(false); setError(null); setTypeFilter(new Set());
    fetchPage(1, false);
    // fetchPage closes over the current mode/query/kind/name; re-runs on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, query, kind, name]);

  const loadMore = () => {
    if (loading || done) return;
    pageRef.current += 1;
    fetchPage(pageRef.current, true);
  };

  const toggleType = (t) => setTypeFilter(prev => {
    const n = new Set(prev);
    if (n.has(t)) n.delete(t); else n.add(t);
    return n;
  });

  const filtered = useMemo(
    () => (items || []).filter(r => typeFilter.size === 0 || (r.type && typeFilter.has(r.type))),
    [items, typeFilter],
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        padding: '12px 18px 10px', borderBottom: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0,
      }}>
        {mode === 'discover' && name && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>{name}</span>
            <span style={{
              fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
              textTransform: 'uppercase', color: 'var(--text-faint)',
            }}>{kind} · MyAnimeList</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TYPES.map(t => (
            <FilterChip key={t} active={typeFilter.has(t)} accent={accent} onClick={() => toggleType(t)}>{t}</FilterChip>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {error && <div style={{ color: '#e07b7b', fontSize: 12 }}>{error}</div>}
        {items === null && loading && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Loading…</div>}
        {items && (
          filtered.length === 0
            ? (
              <div style={{ color: 'var(--text-faint)', fontSize: 12, textAlign: 'center', padding: 24 }}>
                {items.length === 0 ? 'No results.' : 'No results match the type filter.'}
              </div>
            )
            : (
              <div style={GRID}>
                {filtered.map(r => (
                  <AnimeResultCard
                    key={r.malId}
                    result={r}
                    accent={accent}
                    inLibrary={libMap.has(r.malId)}
                    onSelect={() => { window.location.hash = '/tools/library/anime/title/' + r.malId; }}
                  />
                ))}
              </div>
            )
        )}
        {items && !done && mode !== 'search' && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 4 }}>
            <button
              onClick={loadMore}
              disabled={loading}
              className="candy-btn is-primary"
              style={{ cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1 }}
            ><span className="candy-face">{loading ? 'Loading…' : 'Load more'}</span></button>
          </div>
        )}
      </div>
    </div>
  );
}

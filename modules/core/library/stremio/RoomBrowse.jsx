// See-all grid behind each homepage row. `mode` is a Cinemeta catalog id
// ('top' | 'imdbRating' | 'year') or 'search' with a query. Cinemeta pages 100
// at a time via `skip`, so more arrives on a Load more press rather than an
// infinite scroll — the row above it is the browsing surface; this is the dump.

import { useEffect, useState } from 'react';
import { videoApi } from '../api.js';
import AnimeResultCard from '../AnimeResultCard.jsx';
import { toResultCard, toTitle } from './util.js';

const TITLES = {
  series: { top: 'Top Shows', imdbRating: 'By Rating', year: 'By Year', search: 'Search' },
  movie:  { top: 'Top Films', imdbRating: 'By Rating', year: 'By Year', search: 'Search' },
};

// Cinemeta's `year` catalog refuses to answer without a genre; Drama is its
// broadest, and the homepage row uses the same one so the grid matches it.
const YEAR_GENRE = 'Drama';

export default function RoomBrowse({ accent, kind = 'series', mode, query }) {
  const [items, setItems] = useState(null);
  const [skip, setSkip] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setItems(null); setSkip(0); setMore(true); }, [mode, query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const req = mode === 'search'
      ? videoApi.cinemetaSearch(kind, query)
      : videoApi.cinemetaCatalog(kind, mode, mode === 'year' ? YEAR_GENRE : null, skip);
    req
      .then(r => {
        if (cancelled) return;
        const page = r || [];
        setItems(prev => (skip === 0 || prev === null ? page : [...prev, ...page]));
        setMore(mode !== 'search' && page.length > 0);
      })
      .catch(() => { if (!cancelled) { setItems(prev => prev || []); setMore(false); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mode, query, skip]);

  const heading = mode === 'search' ? `Search — ${query}` : ((TITLES[kind] || TITLES.series)[mode] || 'Browse');

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 22px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>{heading}</h2>

      {items === null && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Loading</div>}
      {items && items.length === 0 && <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>No results.</div>}

      {items && items.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
          {items.map(h => (
            <AnimeResultCard key={h.imdbId} result={toResultCard(h, kind)} accent={accent} onSelect={() => toTitle(kind, h.imdbId)} />
          ))}
        </div>
      )}

      {items && items.length > 0 && more && (
        <button onClick={() => setSkip(s => s + 100)} disabled={loading} data-own-press className="candy-btn"
          style={{ alignSelf: 'center', cursor: loading ? 'default' : 'pointer' }}>
          <span className="candy-face" style={{ fontSize: 12 }}>{loading ? 'Loading' : 'Load More'}</span>
        </button>
      )}
    </div>
  );
}

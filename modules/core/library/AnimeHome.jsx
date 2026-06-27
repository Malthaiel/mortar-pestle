// Anime homepage (MyAnimeList-style). Top-to-bottom: a search bar that spans
// both your local library and the MAL catalog, then — when the query is empty —
// Continue Watching, a Your-Library shortcut, Top Anime, and This Season.
// Discovery feeds come from the existing Jikan commands (anime_top /
// anime_season_now / anime_search); Continue Watching + counts derive from the
// one listSeries fetch. Discovery cards route to the adaptive detail page by
// MAL id; library cards route by vault path.

import { useEffect, useMemo, useRef, useState } from 'react';
import { videoApi } from './api.js';
import PosterRow from './PosterRow.jsx';
import AnimeResultCard from './AnimeResultCard.jsx';
import { SeriesCard } from './SeriesBrowser.jsx';
import { buildLibraryIndex } from './useLibraryMap.js';
import { coverSrc } from './util.js';
import { encodePath } from './paths.js';

const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 };

const go = (hash) => { window.location.hash = hash; };
const toSeries = (path) => go('/tools/library/anime/' + encodePath(path));
const toTitle = (malId) => go('/tools/library/anime/title/' + malId);

function errText(e, fallback) {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return e.code;
  try { return JSON.stringify(e); } catch { return fallback; }
}

function watchedCount(s) {
  return typeof s.watchedEpisodes === 'number' ? s.watchedEpisodes : (s.watchedEpisodes || []).length;
}

export default function AnimeHome({ accent }) {
  const [series, setSeries] = useState(null);   // local library list (null = loading)
  const [top, setTop] = useState(null);
  const [season, setSeason] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = () => videoApi.listSeries()
      .then(l => { if (!cancelled) setSeries(l || []); })
      .catch(() => { if (!cancelled) setSeries([]); });
    load();
    window.addEventListener('video-library-changed', load);
    return () => { cancelled = true; window.removeEventListener('video-library-changed', load); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    videoApi.animeTop(1).then(r => { if (!cancelled) setTop(r || []); }).catch(() => { if (!cancelled) setTop([]); });
    videoApi.animeSeasonNow(1).then(r => { if (!cancelled) setSeason(r || []); }).catch(() => { if (!cancelled) setSeason([]); });
    return () => { cancelled = true; };
  }, []);

  const libIndex = useMemo(() => buildLibraryIndex(series || []), [series]);
  const inLib = (malId) => libIndex.has(malId);
  const q = query.trim();

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: '20px 22px 40px',
        display: 'flex', flexDirection: 'column', gap: 26,
      }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your library and MyAnimeList…"
          className="candy-input"
          style={{ padding: '11px 14px', fontSize: 14, color: 'var(--text)', outline: 'none', width: '100%' }}
        />

        {q ? (
          <SearchResults query={q} accent={accent} series={series} inLib={inLib} />
        ) : (
          <>
            <ContinueWatching series={series} accent={accent} />
            <DiscoverySection title="Top Anime" items={top} accent={accent} inLib={inLib} onSeeAll={() => go('/tools/library/anime/browse/top')} />
            <DiscoverySection title="This Season" items={season} accent={accent} inLib={inLib} onSeeAll={() => go('/tools/library/anime/browse/season')} />
          </>
        )}
      </div>
    </div>
  );
}

// ---- Continue Watching ----------------------------------------------------

function ContinueWatching({ series, accent }) {
  const items = useMemo(() => {
    return (series || []).filter(s => {
      const status = s.status || '';
      if (status === 'Completed' || status === 'Dropped') return false;
      const total = s.episodesTotal || 0;
      const watched = watchedCount(s);
      const complete = total > 0 && watched >= total;
      const started = watched > 0 || /watching/i.test(status);
      return started && !complete;
    }).sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 14);
  }, [series]);

  if (series === null) return <RowSkeleton title="Continue Watching" />;
  if (items.length === 0) return null;

  return (
    <PosterRow title="Continue Watching" accent={accent}>
      {items.map(s => <ContinueCard key={s.path} series={s} accent={accent} />)}
    </PosterRow>
  );
}

function ContinueCard({ series, accent }) {
  const [hover, setHover] = useState(false);
  const img = coverSrc(series.image);
  const total = series.episodesTotal || 0;
  const watched = watchedCount(series);
  const nextEp = total > 0 ? Math.min(total, watched + 1) : watched + 1;
  const progress = total > 0 ? watched / total : 0;

  const open = () => toSeries(series.path);   // clicking a card opens the detail page

  return (
    <div
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="button" tabIndex={0}
      className="candy-btn"
      data-shape="tile"
      style={{ '--accent': accent || 'var(--accent)' }}
    >
      <div className="candy-face" style={{ overflow: 'hidden', padding: 0 }}>
      <div style={{ aspectRatio: '2 / 3', position: 'relative', background: 'var(--surface-3)', overflow: 'hidden' }}>
        {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'color-mix(in oklch, black 24%, transparent)',
          opacity: hover ? 1 : 0, transition: 'opacity 120ms ease',
        }}>
          <span style={{ fontSize: 26, color: 'white' }}>▶</span>
        </div>
        {progress > 0 && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: `color-mix(in oklch, ${accent} 18%, transparent)` }}>
            <div style={{ width: `${Math.min(100, progress * 100)}%`, height: '100%', background: accent }} />
          </div>
        )}
      </div>
      <div style={{ padding: '8px 10px 10px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {series.title}
        </div>
        <div style={{ fontSize: 10, color: accent, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
          {total > 0 ? `Resume · Ep ${nextEp}` : 'Resume'}
        </div>
      </div>
      </div>
    </div>
  );
}

// ---- Discovery rows -------------------------------------------------------

function DiscoverySection({ title, items, accent, inLib, onSeeAll }) {
  if (items === null) return <RowSkeleton title={title} />;
  if (items.length === 0) return null;
  return (
    <PosterRow title={title} accent={accent} onSeeAll={onSeeAll}>
      {items.map(r => (
        <AnimeResultCard key={r.malId} result={r} accent={accent} inLibrary={inLib(r.malId)} onSelect={() => toTitle(r.malId)} />
      ))}
    </PosterRow>
  );
}

// ---- Search ---------------------------------------------------------------

function SearchResults({ query, accent, series, inLib }) {
  const [mal, setMal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  useEffect(() => {
    const myId = ++reqId.current;
    setLoading(true); setError(null);
    const t = setTimeout(async () => {
      try {
        const r = await videoApi.animeSearch(query);
        if (myId === reqId.current) setMal(r || []);
      } catch (e) {
        if (myId === reqId.current) setError(errText(e, 'Search failed.'));
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const localHits = useMemo(() => {
    const ql = query.toLowerCase();
    return (series || []).filter(s => (s.title || '').toLowerCase().includes(ql)).slice(0, 12);
  }, [series, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <GroupHeading>In your library</GroupHeading>
        {localHits.length === 0
          ? <Muted>No matches in your library.</Muted>
          : <div style={GRID}>{localHits.map(s => <SeriesCard key={s.path} series={s} accent={accent} selected={false} onSelect={toSeries} />)}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <GroupHeading>MyAnimeList</GroupHeading>
          {mal && mal.length > 0 && (
            <button
              onClick={() => go('/tools/library/anime/browse/search/' + encodeURIComponent(query))}
              data-own-press
              className="candy-btn"
              data-shape="chip"
              style={{ marginLeft: 'auto' }}
            ><span className="candy-face" style={{ fontSize: 11 }}>See all →</span></button>
          )}
        </div>
        {loading && <Muted>Searching…</Muted>}
        {!loading && error && <div style={{ color: 'var(--text)', fontSize: 12 }}>{error}</div>}
        {!loading && !error && mal && (
          mal.length === 0
            ? <Muted>No results.</Muted>
            : <div style={GRID}>{mal.map(r => <AnimeResultCard key={r.malId} result={r} accent={accent} inLibrary={inLib(r.malId)} onSelect={() => toTitle(r.malId)} />)}</div>
        )}
      </div>
    </div>
  );
}

// ---- Small primitives -----------------------------------------------------

function GroupHeading({ children }) {
  return (
    <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
      {children}
    </div>
  );
}

function Muted({ children }) {
  return <div style={{ color: 'var(--text-faint)', fontSize: 12, padding: '4px 0' }}>{children}</div>;
}

function RowSkeleton({ title }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>{title}</h3>
      <div style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: '150px', gap: 14, overflow: 'hidden' }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ aspectRatio: '2 / 3', borderRadius: 8, background: 'var(--surface-2)' }} />
        ))}
      </div>
    </section>
  );
}

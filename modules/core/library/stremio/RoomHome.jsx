// Homepage for a Stremio-backed room (TV Shows or Movies), mirroring AnimeHome's
// shape: a search bar spanning your shelf and Cinemeta, then — when the query is
// empty — Continue Watching, Upcoming Episodes, Top, By Rating and By Year.
//
// Continue Watching and Upcoming Episodes are the two rows that only mean
// something across many episodes, so the Movies room hides both (`hasEpisodes`)
// rather than drawing them empty.
//
// Discovery comes from the keyless Cinemeta catalogs; Continue Watching and the
// search's local half derive from that room's one card list. Discovery cards
// route to /title/<ttId> (Cinemeta detail + Add); shelf cards route by path.

import { useEffect, useMemo, useRef, useState } from 'react';
import { videoApi } from '../api.js';
import PosterRow from '../PosterRow.jsx';
import AnimeResultCard from '../AnimeResultCard.jsx';
import { SeriesCard } from '../SeriesBrowser.jsx';
import { coverSrc } from '../util.js';
import { encodePath } from '../paths.js';
import { room, roomHome, toResultCard, go, toTitle } from './util.js';

const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 };

const toCard = (kind, path) => go(roomHome(kind) + '/' + encodePath(path));

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

export default function RoomHome({ accent, kind = 'series' }) {
  const cfg = room(kind);
  // The shelf comes from the shared store, so the homepage, the sidebar counts
  // and the topbar all read one fetch.
  const { series } = cfg.useStats();
  const [top, setTop] = useState(null);
  const [rated, setRated] = useState(null);
  const [byYear, setByYear] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    const pull = (catalog, genre, set) => videoApi.cinemetaCatalog(kind, catalog, genre)
      .then(r => { if (!cancelled) set(r || []); })
      .catch(() => { if (!cancelled) set([]); });
    pull('top', null, setTop);
    pull('imdbRating', null, setRated);
    // Cinemeta's `year` catalog requires a genre; Drama is its broadest.
    pull('year', 'Drama', setByYear);
    return () => { cancelled = true; };
  }, []);

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
          placeholder={cfg.hasEpisodes ? "Search your shows and Cinemeta" : "Search your films and Cinemeta"}
          className="candy-input"
          style={{ padding: '11px 14px', fontSize: 14, color: 'var(--text)', outline: 'none', width: '100%' }}
        />

        {q ? (
          <SearchResults query={q} accent={accent} kind={kind} series={series} />
        ) : (
          <>
            {cfg.hasEpisodes && <ContinueWatching series={series} accent={accent} kind={kind} />}
            {cfg.hasEpisodes && <UpcomingEpisodes series={series} accent={accent} kind={kind} />}
            <DiscoverySection title={cfg.hasEpisodes ? 'Top Shows' : 'Top Films'} items={top} accent={accent} kind={kind} onSeeAll={() => go(`${roomHome(kind)}/browse/top`)} />
            <DiscoverySection title="By Rating" items={rated} accent={accent} kind={kind} onSeeAll={() => go(`${roomHome(kind)}/browse/imdbRating`)} />
            <DiscoverySection title="By Year" items={byYear} accent={accent} kind={kind} onSeeAll={() => go(`${roomHome(kind)}/browse/year`)} />
          </>
        )}
      </div>
    </div>
  );
}

// ---- Continue Watching ----------------------------------------------------

function ContinueWatching({ series, accent, kind }) {
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
      {items.map(s => <ContinueCard key={s.path} series={s} accent={accent} kind={kind} />)}
    </PosterRow>
  );
}

function ContinueCard({ series, accent, kind }) {
  const [hover, setHover] = useState(false);
  const img = coverSrc(series.image);
  const total = series.episodesTotal || 0;
  const watched = watchedCount(series);
  const nextEp = total > 0 ? Math.min(total, watched + 1) : watched + 1;
  const progress = total > 0 ? watched / total : 0;
  const open = () => toCard(kind, series.path);

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

// ---- Upcoming Episodes ----------------------------------------------------

// Cinemeta has no account, so its calendar feed is asked about the shows the
// shelf already holds. Nothing owned → no request and no row.
function UpcomingEpisodes({ series, accent, kind }) {
  const [items, setItems] = useState(null);
  const ids = useMemo(
    () => (series || []).map(s => s.imdbId).filter(Boolean),
    [series],
  );

  useEffect(() => {
    if (series === null) return;
    if (ids.length === 0) { setItems([]); return; }
    let cancelled = false;
    videoApi.cinemetaCalendar(ids)
      .then(r => { if (!cancelled) setItems(r || []); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [ids, series]);

  if (series === null) return null;
  if (items === null) return <RowSkeleton title="Upcoming Episodes" />;
  if (items.length === 0) return null;

  return (
    <PosterRow title="Upcoming Episodes" accent={accent}>
      {items.map(ep => (
        <UpcomingCard key={`${ep.imdbId}:${ep.season}:${ep.episode}`} ep={ep} accent={accent} />
      ))}
    </PosterRow>
  );
}

function UpcomingCard({ ep, accent, kind = 'series' }) {
  const img = coverSrc(ep.poster);
  const when = (ep.released || '').slice(0, 10);
  return (
    <div
      onClick={() => toTitle(kind, ep.imdbId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toTitle(kind, ep.imdbId); } }}
      role="button" tabIndex={0}
      className="candy-btn"
      data-shape="tile"
      style={{ '--accent': accent || 'var(--accent)' }}
    >
      <div className="candy-face" style={{ overflow: 'hidden', padding: 0 }}>
        <div style={{ aspectRatio: '2 / 3', background: 'var(--surface-3)', overflow: 'hidden' }}>
          {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
        </div>
        <div style={{ padding: '8px 10px 10px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ep.show}
          </div>
          <div style={{ fontSize: 10, color: accent, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
            S{ep.season} E{ep.episode} · {when}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Discovery rows -------------------------------------------------------

function DiscoverySection({ title, items, accent, kind = 'series', onSeeAll }) {
  if (items === null) return <RowSkeleton title={title} />;
  if (items.length === 0) return null;
  return (
    <PosterRow title={title} accent={accent} onSeeAll={onSeeAll}>
      {items.slice(0, 20).map(h => (
        <AnimeResultCard key={h.imdbId} result={toResultCard(h, kind)} accent={accent} onSelect={() => toTitle(kind, h.imdbId)} />
      ))}
    </PosterRow>
  );
}

// ---- Search ---------------------------------------------------------------

function SearchResults({ query, accent, kind = 'series', series }) {
  const [hits, setHits] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  useEffect(() => {
    const myId = ++reqId.current;
    setLoading(true); setError(null);
    const t = setTimeout(async () => {
      try {
        const r = await videoApi.cinemetaSearch(kind, query);
        if (myId === reqId.current) setHits(r || []);
      } catch (e) {
        if (myId === reqId.current) setError(errText(e, 'Search failed.'));
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query, kind]);

  const localHits = useMemo(() => {
    const ql = query.toLowerCase();
    return (series || []).filter(s => (s.title || '').toLowerCase().includes(ql)).slice(0, 12);
  }, [series, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <GroupHeading>On your shelf</GroupHeading>
        {localHits.length === 0
          ? <Muted>No matches on your shelf.</Muted>
          : <div style={GRID}>{localHits.map(s => (
              <SeriesCard key={s.path} series={s} accent={accent} selected={false} onSelect={(path) => toCard(kind, path)} domain={room(kind).domain} />
            ))}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <GroupHeading>Cinemeta</GroupHeading>
          {hits && hits.length > 0 && (
            <button
              onClick={() => go(`${roomHome(kind)}/browse/search/` + encodeURIComponent(query))}
              data-own-press
              className="candy-btn"
              data-shape="chip"
              style={{ marginLeft: 'auto' }}
            ><span className="candy-face" style={{ fontSize: 11 }}>See All →</span></button>
          )}
        </div>
        {loading && <Muted>Searching</Muted>}
        {!loading && error && <div style={{ color: 'var(--text)', fontSize: 12 }}>{error}</div>}
        {!loading && !error && hits && (
          hits.length === 0
            ? <Muted>No results.</Muted>
            : <div style={GRID}>{hits.map(h => (
                <AnimeResultCard key={h.imdbId} result={toResultCard(h, kind)} accent={accent} onSelect={() => toTitle(kind, h.imdbId)} />
              ))}</div>
        )}
      </div>
    </div>
  );
}

// ---- Small primitives -----------------------------------------------------

function GroupHeading({ children }) {
  return (
    <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', color: 'var(--text-faint)' }}>
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

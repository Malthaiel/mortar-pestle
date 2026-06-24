// "Viewers also liked" rail for one anime — live Jikan fetch keyed by MAL id,
// mounted on both the owned and discovery detail pages. Each tile carries its
// own cover (the /recommendations endpoint ships images) and routes through the
// adaptive /title/<id> page, which resolves to the owned or discovery view.
// Skeletons while the fetch is in flight; renders nothing once it resolves empty.

import { useEffect, useRef, useState } from 'react';
import { videoApi } from './api.js';

function initials(text) {
  const w = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return w.slice(0, 2).map(s => s[0].toUpperCase()).join('');
}

function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '0 0 6px', borderBottom: '1px solid var(--border)', marginBottom: 12,
    }}>{children}</div>
  );
}

// Fetch one Jikan endpoint for `id`; null = loading, [] = empty/failed.
function useJikan(fn, id) {
  const [data, setData] = useState(null);
  const reqId = useRef(0);
  useEffect(() => {
    if (!id) { setData([]); return; }
    const my = ++reqId.current;
    setData(null);
    Promise.resolve(fn(id))
      .then(r => { if (my === reqId.current) setData(r || []); })
      .catch(() => { if (my === reqId.current) setData([]); });
    // fn is a stable module singleton; only id drives the refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return data;
}

export default function AnimeRecommendations({ malId, accent }) {
  const id = Number(malId) || 0;
  const recs = useJikan(videoApi.animeRecommendations, id);

  if (!id) return null;
  if (recs !== null && recs.length === 0) return null;

  return (
    <section style={{ '--accent': accent || 'var(--accent)' }}>
      <SectionHeader>Recommendations</SectionHeader>
      {recs === null
        ? <RecsSkeleton />
        : (
          <div className="anime-recs-row">
            {recs.map(r => <RecCard key={r.malId} rec={r} accent={accent} />)}
          </div>
        )}
    </section>
  );
}

// Tile mirroring RelatedCard, but the cover ships with the recommendation so it
// renders immediately. Vote count sits under the title. Routes through the
// adaptive /title/<id> page (owned or discovery).
function RecCard({ rec, accent }) {
  const [failed, setFailed] = useState(false);
  const show = rec.image && !failed;
  return (
    <button
      type="button"
      onClick={() => { window.location.hash = '/tools/library/anime/title/' + rec.malId; }}
      className="candy-btn"
      data-shape="tile"
      title={`Open ${rec.title}`}
      style={{ '--accent': accent || 'var(--accent)', width: 116, flexShrink: 0, cursor: 'pointer' }}
    >
      <div className="candy-face" style={{ padding: 0, overflow: 'hidden', textAlign: 'left' }}>
        <div style={{
          aspectRatio: '2 / 3', background: 'var(--surface-3)', overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {show
            ? <img src={rec.image} alt="" loading="lazy" onError={() => setFailed(true)}
                   style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600,
                color: 'var(--text-muted)', userSelect: 'none',
              }}>{initials(rec.title)}</span>}
        </div>
        <div style={{ padding: '7px 8px 9px' }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text)', lineHeight: 1.25,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>{rec.title}</div>
          {rec.votes > 0 && (
            <div style={{
              fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
              textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 3,
            }}>{rec.votes} rec{rec.votes === 1 ? '' : 's'}</div>
          )}
        </div>
      </div>
    </button>
  );
}

// Shimmer placeholder shown while the recommendations fetch is in flight — a row
// of poster-shaped blocks matching the 116px rail tiles.
function RecsSkeleton() {
  const blocks = Array.from({ length: 6 });
  return (
    <div style={{ display: 'flex', gap: 12, overflow: 'hidden' }}>
      {blocks.map((_, i) => (
        <div key={i} style={{ width: 116, flexShrink: 0 }}>
          <div className="ftv-skeleton" style={{ width: '100%', aspectRatio: '2 / 3', borderRadius: 8 }} />
          <div className="ftv-skeleton" style={{ height: 9, marginTop: 6, borderRadius: 4, width: '82%' }} />
        </div>
      ))}
    </div>
  );
}

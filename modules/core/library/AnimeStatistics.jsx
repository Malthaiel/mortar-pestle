// Live community stats for one anime, keyed by MAL id — a score histogram (how
// MAL members rated it, 10 → 1) plus a watch-status breakdown (Watching /
// Completed / On-Hold / Dropped / Plan to Watch). Sized for the 260px detail
// rail, mounted between Information and the controls on both the owned
// (SeriesDetail) and discovery (DiscoveryDetail) pages. Fetched live from Jikan;
// nothing is persisted. Mirrors AnimeCredits.jsx (useJikan hook + SectionHeader +
// loading/empty handling). The bar tracks reuse .candy-groove / .candy-groove__fill,
// with the fill width set inline from each percentage.

import { useEffect, useRef, useState } from 'react';
import { videoApi } from './api.js';

function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '0 0 6px', borderBottom: '1px solid var(--border)', marginBottom: 12,
    }}>{children}</div>
  );
}

// Fetch one Jikan endpoint for `id`; null = loading, {} = empty/failed.
function useJikan(fn, id) {
  const [data, setData] = useState(null);
  const reqId = useRef(0);
  useEffect(() => {
    if (!id) { setData({}); return; }
    const my = ++reqId.current;
    setData(null);
    Promise.resolve(fn(id))
      .then(r => { if (my === reqId.current) setData(r || {}); })
      .catch(() => { if (my === reqId.current) setData({}); });
    // fn is a stable module singleton; only id drives the refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return data;
}

function fmtInt(n) {
  return (Number(n) || 0).toLocaleString();
}

// Compact percentage: one decimal, trimming a trailing ".0".
function fmtPct(n) {
  const v = Number(n) || 0;
  return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + '%';
}

const STATUS_ROWS = [
  { key: 'watching',     label: 'Watching',      color: 'oklch(0.74 0.13 150)' },
  { key: 'completed',    label: 'Completed',     color: 'oklch(0.7 0.14 230)' },
  { key: 'onHold',       label: 'On-Hold',       color: 'oklch(0.78 0.13 80)' },
  { key: 'dropped',      label: 'Dropped',       color: 'var(--error)' },
  { key: 'planToWatch',  label: 'Plan to Watch', color: 'var(--text-faint)' },
];

export default function AnimeStatistics({ malId, accent }) {
  const id = Number(malId) || 0;
  const stats = useJikan(videoApi.animeStatistics, id);

  if (!id) return null;

  const loading = stats === null;
  const scores = (stats && Array.isArray(stats.scores)) ? stats.scores : [];
  const statuses = (stats && stats.statuses) || {};
  const total = Number(stats && stats.total) || 0;

  // Empty / failed → render nothing rather than an empty shell.
  const hasScores = scores.some(s => (Number(s && s.votes) || 0) > 0);
  const hasStatuses = STATUS_ROWS.some(r => (Number(statuses[r.key]) || 0) > 0);
  if (!loading && !hasScores && !hasStatuses) return null;

  // Score rows render high → low (10 down to 1).
  const byScore = new Map(scores.map(s => [Number(s.score), s]));
  const scoreRows = [];
  for (let s = 10; s >= 1; s--) scoreRows.push(byScore.get(s) || { score: s, votes: 0, percentage: 0 });

  const statusMax = Math.max(1, total, ...STATUS_ROWS.map(r => Number(statuses[r.key]) || 0));

  return (
    <section>
      <SectionHeader>Statistics</SectionHeader>

      {loading
        ? <StatsSkeleton />
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {hasScores && (
              <div className="anime-stat-hist">
                {scoreRows.map(r => {
                  const votes = Number(r.votes) || 0;
                  const pct = Number(r.percentage) || 0;
                  return (
                    <div className="anime-stat-hist__row" key={r.score}>
                      <span>{r.score}</span>
                      <div className="candy-groove">
                        <div className="candy-groove__fill"
                             style={{ '--accent': accent || 'var(--accent)', width: pct + '%' }} />
                      </div>
                      <span title={`${fmtInt(votes)} votes`}>{fmtPct(pct)}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {hasStatuses && (
              <div className="anime-stat-status">
                {STATUS_ROWS.map(row => {
                  const count = Number(statuses[row.key]) || 0;
                  const fill = (count / statusMax) * 100;
                  return (
                    <div className="anime-stat-status__row" key={row.key}>
                      <span>
                        <Dot color={row.color} />
                        {row.label}
                      </span>
                      <div className="candy-groove">
                        <div className="candy-groove__fill"
                             style={{ background: row.color, width: fill + '%' }} />
                      </div>
                      <span>{fmtInt(count)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
    </section>
  );
}

function Dot({ color }) {
  return (
    <span style={{
      width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
      background: color || 'var(--accent)',
    }} />
  );
}

// Shimmer placeholder shown while the Jikan fetch is in flight — a few groove-
// height bars matching the histogram rhythm.
function StatsSkeleton() {
  const rows = Array.from({ length: 8 });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((_, i) => (
        <div key={i} className="ftv-skeleton" style={{ height: 9, borderRadius: 999, width: (95 - i * 8) + '%' }} />
      ))}
    </div>
  );
}

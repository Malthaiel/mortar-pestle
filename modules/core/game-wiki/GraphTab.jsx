// GraphTab — Graph tab of the Match View popup (Full Match Data Extraction, SF-D).
// Time-series over the stats[] frames via the inline-SVG Chart primitive. A metric
// selector (net worth / souls-min / CS / hero damage / level) and a Players↔Teams
// toggle (12 per-player lines, team-hued, vs 2 team aggregates).

import { useState } from 'react';
import { extractSeries, sideName, clock } from './matchData.js';
import Chart from './Chart.jsx';

const k = (v) => `${Math.round((Number(v) || 0) / 1000)}k`;
const int = (v) => Math.round(Number(v) || 0).toLocaleString();

const METRICS = [
  { id: 'net_worth', label: 'Net worth', fmt: k, agg: 'sum' },
  { id: 'soulsmin', label: 'Souls / min', fmt: int, agg: 'avg' },
  { id: 'cs', label: 'CS', fmt: int, agg: 'sum' },
  { id: 'damage', label: 'Hero damage', fmt: k, agg: 'sum' },
  { id: 'level', label: 'Level', fmt: int, agg: 'avg' },
];

const teamColor = (team) => (team === 0 ? 'var(--team-amber)' : 'var(--team-sapphire)');
const playerColor = (team, i, n) => {
  const hue = team === 0 ? 75 : 250;
  const l = 0.55 + (n > 1 ? (i / (n - 1)) * 0.28 : 0);
  const c = team === 0 ? 0.14 : 0.15;
  return `oklch(${l.toFixed(3)} ${c} ${hue})`;
};

const segBtn = (active) => ({
  appearance: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 600,
  padding: '5px 11px', borderRadius: 7, border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
  background: active ? 'color-mix(in oklch, var(--accent) 16%, transparent)' : 'transparent',
  color: active ? 'var(--text)' : 'var(--text-muted)',
});

function buildPlayerSeries(data, metric) {
  const counts = { 0: 0, 1: 0 };
  const totals = { 0: data.filter((s) => s.team === 0).length, 1: data.filter((s) => s.team === 1).length };
  return data.map((s) => {
    const i = counts[s.team]++;
    return { label: s.hero, color: playerColor(s.team, i, totals[s.team]), points: s.pts.map((pt) => ({ x: pt.t, y: pt[metric] || 0 })) };
  });
}

function buildTeamSeries(data, metric, agg) {
  return [0, 1].map((team) => {
    const byT = new Map();
    for (const s of data.filter((x) => x.team === team)) {
      for (const pt of s.pts) {
        const e = byT.get(pt.t) || { sum: 0, n: 0 };
        e.sum += pt[metric] || 0; e.n += 1; byT.set(pt.t, e);
      }
    }
    const points = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, e]) => ({ x: t, y: agg === 'avg' ? e.sum / e.n : e.sum }));
    return { label: sideName(team), color: teamColor(team), points };
  });
}

export default function GraphTab({ raw }) {
  const data = extractSeries(raw);
  const [metricId, setMetricId] = useState('net_worth');
  const [mode, setMode] = useState('players'); // players | teams
  const metric = METRICS.find((m) => m.id === metricId) || METRICS[0];

  const series = mode === 'teams'
    ? buildTeamSeries(data, metric.id, metric.agg)
    : buildPlayerSeries(data, metric.id);

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {METRICS.map((m) => (
            <button key={m.id} type="button" style={segBtn(m.id === metricId)} onClick={() => setMetricId(m.id)}>{m.label}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 5 }}>
          {['players', 'teams'].map((mo) => (
            <button key={mo} type="button" style={segBtn(mo === mode)} onClick={() => setMode(mo)}>{mo === 'players' ? 'Players' : 'Teams'}</button>
          ))}
        </div>
      </div>

      <Chart series={series} xFormat={clock} yFormat={metric.fmt} />
    </div>
  );
}

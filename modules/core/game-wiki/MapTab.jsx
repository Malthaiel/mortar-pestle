// MapTab — Map tab of the Match View popup (Full Match Data Extraction, SF-E).
// Three sub-views: an Objectives timeline (structures + mid-boss, with damage), a Death
// map (death positions), and a Movement heatmap (binned path density). Spatial views plot
// on a normalized square (no Deadlock map image — overlay deferred), shared bounds so the
// death map + heatmap line up.

import { useState, Fragment } from 'react';
import { extractObjectives, extractSpatial, sideName, clock } from './matchData.js';

const muted = { color: 'var(--text-muted)' };
const teamColor = (team) => (team === 0 ? 'var(--team-amber)' : 'var(--team-sapphire)');
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString();
const S = 380;
const squareStyle = { display: 'block', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-2)' };
const segBtn = (active) => ({
  appearance: 'none', cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 600,
  padding: '5px 11px', borderRadius: 7, border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
  background: active ? 'color-mix(in oklch, var(--accent) 16%, transparent)' : 'transparent',
  color: active ? 'var(--text)' : 'var(--text-muted)',
});
const caption = { fontSize: 10.5, color: 'var(--text-muted)', marginTop: 6, maxWidth: S };

const SUBS = [{ id: 'objectives', label: 'Objectives' }, { id: 'deaths', label: 'Deaths' }, { id: 'movement', label: 'Movement' }];

function ObjectivesView({ raw }) {
  const { objectives, midBoss } = extractObjectives(raw);
  const events = [
    ...objectives.filter((o) => o.destroyed != null).map((o) => ({ t: o.destroyed, kind: 's', o })),
    ...midBoss.map((b) => ({ t: b.destroyed, kind: 'm', b })),
  ].sort((a, b) => a.t - b.t);
  if (!events.length) return <div style={{ ...muted, fontSize: 13 }}>No objectives destroyed.</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: '4px 12px', fontSize: 12.5, alignItems: 'baseline' }}>
      {events.map((e, i) => (e.kind === 's' ? (
        <Fragment key={i}>
          <span style={{ fontFamily: 'var(--font-mono)', ...muted }}>{clock(e.t)}</span>
          <span style={{ color: teamColor(e.o.team), fontWeight: 600, whiteSpace: 'nowrap' }}>{e.o.side}</span>
          <span style={{ color: 'var(--text)' }}>
            {e.o.name} destroyed
            <span style={muted}>{e.o.firstDamage != null ? ` · first hit ${clock(e.o.firstDamage)}` : ''} · dmg {fmt(e.o.playerDmg)} hero / {fmt(e.o.creepDmg)} creep{e.o.spiritDmg ? ` / ${fmt(e.o.spiritDmg)} spirit` : ''}</span>
          </span>
        </Fragment>
      ) : (
        <Fragment key={i}>
          <span style={{ fontFamily: 'var(--font-mono)', ...muted }}>{clock(e.t)}</span>
          <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>Mid-boss</span>
          <span style={{ color: 'var(--text)' }}>claimed by {e.b.claimedBy}</span>
        </Fragment>
      )))}
    </div>
  );
}

function DeathsView({ spatial }) {
  const { deaths, bounds, duration } = spatial;
  if (!bounds || !deaths.length) return <div style={{ ...muted, fontSize: 13 }}>No death data.</div>;
  const nx = (x) => ((x - (bounds.cx - bounds.half)) / (2 * bounds.half)) * S;
  const ny = (y) => (1 - (y - (bounds.cy - bounds.half)) / (2 * bounds.half)) * S;
  return (
    <div>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={squareStyle}>
        {deaths.map((d, i) => (
          <circle key={i} cx={nx(d.x).toFixed(1)} cy={ny(d.y).toFixed(1)} r={4}
            fill={teamColor(d.team)} opacity={(0.3 + 0.6 * (duration ? d.t / duration : 0)).toFixed(2)}>
            <title>{`${d.hero} died at ${clock(d.t)}`}</title>
          </circle>
        ))}
      </svg>
      <div style={caption}>{deaths.length} deaths · colour = team · brighter = later in the match · normalized positions (no map image)</div>
    </div>
  );
}

function MovementView({ spatial }) {
  const { paths, bounds } = spatial;
  const [team, setTeam] = useState('all');
  if (!bounds || !paths.length) return <div style={{ ...muted, fontSize: 13 }}>No movement data.</div>;
  const G = 50, cell = S / G;
  const grid = new Array(G * G).fill(0);
  let maxc = 0;
  for (const p of paths) {
    if (team !== 'all' && String(p.team) !== team) continue;
    for (const q of p.pts) {
      const gx = Math.min(G - 1, Math.max(0, Math.floor(((q.x - (bounds.cx - bounds.half)) / (2 * bounds.half)) * G)));
      const gy = Math.min(G - 1, Math.max(0, Math.floor((1 - (q.y - (bounds.cy - bounds.half)) / (2 * bounds.half)) * G)));
      const idx = gy * G + gx; grid[idx]++; if (grid[idx] > maxc) maxc = grid[idx];
    }
  }
  const heat = team === '0' ? 'var(--team-amber)' : team === '1' ? 'var(--team-sapphire)' : 'var(--accent)';
  return (
    <div>
      <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
        {[['all', 'All'], ['0', 'Amber'], ['1', 'Sapphire']].map(([id, lbl]) => (
          <button key={id} type="button" style={segBtn(team === id)} onClick={() => setTeam(id)}>{lbl}</button>
        ))}
      </div>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={squareStyle}>
        {grid.map((c, i) => (c ? (
          <rect key={i} x={((i % G) * cell).toFixed(1)} y={(Math.floor(i / G) * cell).toFixed(1)} width={cell + 0.6} height={cell + 0.6}
            fill={heat} opacity={Math.min(0.85, 0.1 + 0.9 * Math.sqrt(c / maxc)).toFixed(2)} />
        ) : null))}
      </svg>
      <div style={caption}>position density (1 sample/sec) · {team === 'all' ? 'all players' : team === '0' ? 'Amber' : 'Sapphire'} · normalized (no map image)</div>
    </div>
  );
}

export default function MapTab({ raw }) {
  const [sub, setSub] = useState('objectives');
  // spatial extraction is the heavy one — only compute when a spatial sub-view is active
  const spatial = sub === 'objectives' ? null : extractSpatial(raw);
  return (
    <div>
      <div style={{ display: 'flex', gap: 5, marginBottom: 14 }}>
        {SUBS.map((s) => (
          <button key={s.id} type="button" style={segBtn(s.id === sub)} onClick={() => setSub(s.id)}>{s.label}</button>
        ))}
      </div>
      {sub === 'objectives' && <ObjectivesView raw={raw} />}
      {sub === 'deaths' && <DeathsView spatial={spatial} />}
      {sub === 'movement' && <MovementView spatial={spatial} />}
    </div>
  );
}

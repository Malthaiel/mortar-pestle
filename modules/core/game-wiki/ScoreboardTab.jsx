// ScoreboardTab — Scoreboard tab of the Match View popup (Full Match Data Extraction, SF-A).
// A match-meta header (match id, winner, duration, average team ranks, pauses) above the
// per-team box score. Reads the extractMatch view-model (m) for rows + extractMeta(raw) for
// the header. Degrades to a gap on any missing field (never throws).

import { extractMeta, sideName, clock } from './matchData.js';
import { rankFromBadge } from './matchAssets.js';

const muted = { color: 'var(--text-muted)' };
const th = { textAlign: 'left', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600, padding: '2px 12px 4px 0' };
const td = { fontSize: 12.5, color: 'var(--text)', padding: '4px 12px 4px 0', whiteSpace: 'nowrap' };
const numTd = { ...td, fontFamily: 'var(--font-mono)' };
const teamColor = (side) => (side === 0 ? 'var(--team-amber)' : 'var(--team-sapphire)');

function RankChip({ badge }) {
  const r = rankFromBadge(badge);
  return <span style={{ color: r.color, fontWeight: 600 }}>{r.name}</span>;
}

function SideTable({ side, rows, isWinner }) {
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: teamColor(side), marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        {sideName(side)}
        {isWinner && <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, ...muted }}>· win</span>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>
            <th style={th}>Hero</th><th style={th}>K / D / A</th><th style={th}>Souls</th>
            <th style={th}>LH / DN</th><th style={th}>Lvl</th><th style={th}>Items</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid color-mix(in oklch, var(--text) 8%, transparent)' }}>
                <td style={td}>{r.hero}</td>
                <td style={numTd}>{r.kills} / {r.deaths} / {r.assists}</td>
                <td style={numTd}>{r.netWorth.toLocaleString()}</td>
                <td style={numTd}>{r.lastHits} / {r.denies}</td>
                <td style={numTd}>{r.level}</td>
                <td style={numTd}>{r.items}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ScoreboardTab({ m, raw }) {
  const meta = extractMeta(raw);
  return (
    <div>
      {/* Match-meta header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 10px', fontSize: 14, color: 'var(--text)' }}>
        {meta.matchId != null && <span style={{ fontWeight: 700 }}>Match {meta.matchId}</span>}
        {meta.winningSide && <span style={muted}>· <span style={{ color: teamColor(meta.winningTeam), fontWeight: 600 }}>{meta.winningSide}</span> win</span>}
        {meta.durationS != null && <span style={muted}>· {clock(meta.durationS)}</span>}
      </div>
      <div style={{ marginTop: 5, fontSize: 12, ...muted, display: 'flex', flexWrap: 'wrap', gap: '2px 16px' }}>
        <span>{sideName(0)} <RankChip badge={meta.badge0} /> &nbsp;vs&nbsp; {sideName(1)} <RankChip badge={meta.badge1} /></span>
        {(meta.gameMode != null || meta.matchMode != null) && (
          <span title="deadlock-api game_mode / match_mode (enum not decoded)">mode {meta.gameMode ?? '—'} / {meta.matchMode ?? '—'}</span>
        )}
      </div>
      {meta.pauses.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11.5, ...muted }}>
          Pauses: {meta.pauses.map((p) => `${clock(p.t)} (slot ${p.slot}, ${p.dur}s)`).join('  ·  ')}
        </div>
      )}

      {/* Per-team box score */}
      {[0, 1].map((side) => (
        <SideTable key={side} side={side}
          rows={m.rows.filter((r) => r.team === side)}
          isWinner={m.winningTeam === side} />
      ))}
    </div>
  );
}

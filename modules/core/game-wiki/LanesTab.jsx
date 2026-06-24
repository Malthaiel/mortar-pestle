// LanesTab — Lanes tab of the Match View popup (Full Match Data Extraction, SF-C).
// Per-lane 2v2 matchups (grouped by assigned_lane) with combined souls + a lane lead,
// then a per-team "structures lost" summary. NOTE: the deadlock-api does not tag a
// structure with a lane, so structures are listed per team, not attributed to a lane.

import { extractLanes, extractObjectives, sideName, clock } from './matchData.js';

const muted = { color: 'var(--text-muted)' };
const teamColor = (team) => (team === 0 ? 'var(--team-amber)' : 'var(--team-sapphire)');
const souls = (n) => `${((Number(n) || 0) / 1000).toFixed(1)}k`;

function PlayerRow({ p }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '0 10px', fontSize: 12.5, padding: '2px 0', alignItems: 'baseline' }}>
      <span style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.hero}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{souls(p.netWorth)}</span>
      <span style={{ fontFamily: 'var(--font-mono)', ...muted }} title="last hits / denies">{p.lastHits}/{p.denies}</span>
      <span style={{ fontFamily: 'var(--font-mono)', ...muted }} title="K / D / A">{p.kills}/{p.deaths}/{p.assists}</span>
    </div>
  );
}

function LaneSide({ team, players, net }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: teamColor(team), marginBottom: 3 }}>
        {sideName(team)} · {souls(net)}
      </div>
      {players.map((p, i) => <PlayerRow key={i} p={p} />)}
    </div>
  );
}

function LaneCard({ lane }) {
  const lead = lane.amberNet - lane.sapphireNet;
  const leadTeam = lead === 0 ? null : (lead > 0 ? 0 : 1);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--surface-2)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Lane {lane.lane}</div>
        {leadTeam != null && (
          <div style={{ fontSize: 11.5, fontWeight: 600, color: teamColor(leadTeam) }}>{sideName(leadTeam)} +{souls(Math.abs(lead))}</div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <LaneSide team={0} players={lane.amber} net={lane.amberNet} />
        <LaneSide team={1} players={lane.sapphire} net={lane.sapphireNet} />
      </div>
    </div>
  );
}

export default function LanesTab({ raw }) {
  const lanes = extractLanes(raw);
  const { objectives } = extractObjectives(raw);
  const destroyed = objectives.filter((o) => o.destroyed != null).sort((a, b) => a.destroyed - b.destroyed);
  const byTeam = (team) => destroyed.filter((o) => o.team === team);

  if (!lanes.length) return <div style={{ ...muted, fontSize: 13 }}>No lane data in this match.</div>;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        {lanes.map((l) => <LaneCard key={l.lane} lane={l} />)}
      </div>

      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', ...muted, marginBottom: 2 }}>Structures lost</div>
        <div style={{ fontSize: 10.5, ...muted, marginBottom: 8 }}>deadlock-api doesn't tag structures with a lane — listed per team, not per lane.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {[0, 1].map((team) => (
            <div key={team}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: teamColor(team), marginBottom: 4 }}>{sideName(team)}</div>
              {byTeam(team).length ? byTeam(team).map((o, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '1px 0' }}>
                  <span style={{ color: 'var(--text)' }}>{o.name}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', ...muted }}>{clock(o.destroyed)}</span>
                </div>
              )) : <div style={{ ...muted, fontSize: 12 }}>none lost</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// matchDigest.js — deterministic match-analysis digest (Analyst pipeline, Move 8).
// Pure markdown renderer over the matchData.js extractors + the raw sidecar JSON —
// no AI, no IPC. The digest is what the report passes read instead of the ~1 MB raw
// payload. Tolerant like matchData.js: every section degrades to a loud
// "[absent in this sidecar]" gap, never a throw.

import { extractPlayers, extractLanes, extractObjectives, sideName, heroName, clock } from './matchData.js';

const gap = (what) => `_[${what} absent in this sidecar]_`;
const souls = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

// Team net-worth totals per stat-snapshot timestamp: [{t, amber, sapphire, delta}].
// Snapshots are per-player but share timestamps; bucketing by t aligns them.
export function teamCurve(raw) {
  const players = raw?.match_info?.players ?? [];
  const buckets = new Map();
  for (const p of players) {
    for (const f of (Array.isArray(p.stats) ? p.stats : [])) {
      const t = Number(f.time_stamp_s) || 0;
      const b = buckets.get(t) || { 0: 0, 1: 0 };
      b[p.team === 1 ? 1 : 0] += Number(f.net_worth) || 0;
      buckets.set(t, b);
    }
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, b]) => ({ t, amber: b[0], sapphire: b[1], delta: b[0] - b[1] }));
}

// Tempo events: snapshot-to-snapshot moves of the team souls delta larger than
// `threshold`. ponytail: fixed 3k-souls threshold; tune per feedback, not per match.
export function detectSwings(curve, threshold = 3000) {
  const swings = [];
  for (let i = 1; i < curve.length; i++) {
    const move = curve[i].delta - curve[i - 1].delta;
    if (Math.abs(move) >= threshold) {
      swings.push({ t: curve[i].t, toward: sideName(move > 0 ? 0 : 1), move: Math.abs(move) });
    }
  }
  return swings;
}

// Per-lane souls curves: [{lane, pts: [{t, delta}]}] — amber-lane minus sapphire-lane
// net worth at each shared snapshot (the laning read: who was up, when).
export function laneCurves(raw) {
  const players = raw?.match_info?.players ?? [];
  const lanes = new Map();
  for (const p of players) {
    const lane = p.assigned_lane ?? 0;
    const buckets = lanes.get(lane) || new Map();
    for (const f of (Array.isArray(p.stats) ? p.stats : [])) {
      const t = Number(f.time_stamp_s) || 0;
      const sign = p.team === 1 ? -1 : 1;
      buckets.set(t, (buckets.get(t) || 0) + sign * (Number(f.net_worth) || 0));
    }
    lanes.set(lane, buckets);
  }
  return [...lanes.entries()].sort((a, b) => a[0] - b[0]).map(([lane, buckets]) => ({
    lane,
    pts: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, delta]) => ({ t, delta })),
  }));
}

// Per-player death list with the killer resolved to a hero name.
export function deathSummaries(raw) {
  const players = raw?.match_info?.players ?? [];
  const bySlot = new Map(players.map((p) => [p.player_slot, p]));
  return players.map((p) => ({
    hero: heroName(p.hero_id), side: sideName(p.team),
    deaths: (Array.isArray(p.death_details) ? p.death_details : []).map((d) => ({
      t: Number(d.game_time_s) || 0,
      // killer_player_slot outside the 12 player slots (0 seen live) = non-player kill
      killer: bySlot.has(d.killer_player_slot) ? heroName(bySlot.get(d.killer_player_slot).hero_id) : 'the environment',
      ttk: Number(d.time_to_kill_s) || 0,
      pos: d.death_pos ? { x: Math.round(d.death_pos.x), y: Math.round(d.death_pos.y) } : null,
    })).sort((a, b) => a.t - b.t),
  }));
}

// The digest. `label` prefixes the header ("Match 1"); markdown ≤ ~15k tokens.
export function buildMatchDigest(raw, { label = '' } = {}) {
  const mi = raw?.match_info ?? {};
  const players = extractPlayers(raw);
  const out = [];

  // header
  const head = [];
  if (label) head.push(label);
  if (mi.match_id != null) head.push(`id ${mi.match_id}`);
  if (mi.winning_team != null) head.push(`**${sideName(mi.winning_team)} win**`);
  if (mi.duration_s != null) head.push(clock(mi.duration_s));
  out.push(`## Match digest${head.length ? ` — ${head.join(' · ')}` : ''}`);

  // scoreboard
  out.push('', '### Scoreboard');
  if (!players.length) out.push(gap('players'));
  for (const side of [0, 1]) {
    const rs = players.filter((p) => p.team === side);
    if (!rs.length) continue;
    out.push('', `**${sideName(side)}**${mi.winning_team === side ? ' (won)' : ''}`);
    for (const p of rs) {
      out.push(`- ${p.hero} — ${p.kills}/${p.deaths}/${p.assists} · ${souls(p.netWorth)} souls · lvl ${p.level} · ${p.lastHits} LH / ${p.denies} DN · Lane ${p.assignedLane ?? '?'}`);
    }
  }

  // lanes
  const lanes = extractLanes(raw);
  out.push('', '### Lanes');
  if (!lanes.length) out.push(gap('lane assignments'));
  for (const L of lanes) {
    const names = (arr) => arr.map((x) => x.hero).join(' + ') || '—';
    const diff = L.amberNet - L.sapphireNet;
    const verdict = diff === 0 ? 'even' : `${sideName(diff > 0 ? 0 : 1)} up ${souls(Math.abs(diff))}`;
    out.push(`- Lane ${L.lane}: ${names(L.amber)} vs ${names(L.sapphire)} — final souls ${souls(L.amberNet)} vs ${souls(L.sapphireNet)} (${verdict})`);
  }

  // souls curves (team + per lane)
  const curve = teamCurve(raw);
  out.push('', '### Souls curve (team delta, Amber − Sapphire)');
  out.push(curve.length
    ? curve.map((c) => `${clock(c.t)} ${c.delta >= 0 ? '+' : ''}${souls(c.delta)}`).join(' · ')
    : gap('stat snapshots'));
  const lc = laneCurves(raw);
  if (lc.length && curve.length) {
    out.push('', '### Souls curve per lane (Amber − Sapphire)');
    for (const L of lc) {
      out.push(`- Lane ${L.lane}: ${L.pts.map((p) => `${clock(p.t)} ${p.delta >= 0 ? '+' : ''}${souls(p.delta)}`).join(' · ')}`);
    }
  }

  // tempo swings
  const swings = detectSwings(curve);
  out.push('', '### Tempo swings (≥3,000-soul moves between snapshots)');
  out.push(...(swings.length ? swings.map((s) => `- ${clock(s.t)} — ${souls(s.move)} souls toward ${s.toward}`) : ['- none detected']));

  // item builds (shop items only, purchase order; abilities excluded)
  out.push('', '### Item builds (purchase order)');
  if (!players.length) out.push(gap('items'));
  for (const p of players) {
    const build = p.build.map((it) => `${clock(it.t)} ${it.name}${it.soldT ? ` (sold ${clock(it.soldT)})` : ''}`).join(', ');
    out.push(`- ${p.hero} (${p.side}): ${build || gap('items')}`);
  }

  // deaths
  const deaths = deathSummaries(raw);
  out.push('', '### Deaths');
  const anyDeaths = deaths.some((d) => d.deaths.length);
  if (!anyDeaths) out.push(gap('death details'));
  for (const d of deaths) {
    if (!d.deaths.length) continue;
    out.push(`- ${d.hero} (${d.side}): ${d.deaths.map((k) => `${clock(k.t)} by ${k.killer}${k.pos ? ` @ (${k.pos.x},${k.pos.y})` : ''}`).join(', ')}`);
  }

  // objective timeline + mid boss
  const { objectives, midBoss } = extractObjectives(raw);
  const destroyed = objectives.filter((o) => o.destroyed != null).sort((a, b) => a.destroyed - b.destroyed);
  out.push('', '### Objective timeline');
  if (!destroyed.length && !midBoss.length) out.push(gap('objectives'));
  for (const o of destroyed) out.push(`- ${clock(o.destroyed)} — ${o.side} lost ${o.name}`);
  for (const b of midBoss) out.push(`- ${clock(b.destroyed)} — Mid-boss claimed by ${b.claimedBy}`);

  // damage top-line (gross, from the damage matrix)
  out.push('', '### Damage focus (gross hero damage)');
  const anyDmg = players.some((p) => p.dmgDealt.some((d) => d.dmg > 0));
  if (!anyDmg) out.push(gap('damage matrix'));
  else {
    for (const p of players) {
      const top = p.dmgDealt[0], threat = p.dmgTaken[0];
      out.push(`- ${p.hero} (${p.side}): dealt most to ${top ? `${top.hero} (${souls(top.dmg)})` : '—'}, took most from ${threat ? `${threat.hero} (${souls(threat.dmg)})` : '—'}`);
    }
  }

  return out.join('\n');
}

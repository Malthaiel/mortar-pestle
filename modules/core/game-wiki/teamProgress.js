// teamProgress.js — Team Progress (Deadlock Scrim Coaching, sub-plan 12). Pure ESM (no React, no
// @host) so the aggregation + page rendering round-trip through a Node harness. Cross-scrim memory
// for a coached team: the caller walks the team's scrims, reads each scrim's .vodreport (action items
// + follow-ups) and per-match .matchdata/.commstranscript sidecars, computes a per-scrim metric
// bundle, and hands the list here. aggregateTeam folds it into the .teamprogress.<Team>.json sidecar
// shape; renderTeamPage emits the app-generated Teams/<Team>.md (issues-first, never hand-edited).
//
// Recurrence = normalized-text match of action items across scrims (user-locked 2026-07-09): same
// normalized text = same problem; a "streak" counts consecutive most-recent scrims that raised it.
// Metrics are TEAM-level — match data identifies players only by slot+hero+team (no display name), so
// per-player metric trends aren't derivable without a roster->hero map (flagged, deferred).

export const TEAMS_DIR = 'Deadlock/Coaching/Teams';

// Team name is the file stem verbatim (team names carry no '/'); a scrim's Coached Team frontmatter
// is the same string, so no slug transform is needed beyond a trim.
export const teamSlug = (team) => String(team ?? '').trim();
export const teamPagePath = (team) => `${TEAMS_DIR}/${teamSlug(team)}.md`;
export const teamSidecarPath = (team) => `${TEAMS_DIR}/.teamprogress.${teamSlug(team)}.json`;

// Normalize an action-item text for cross-scrim recurrence matching + team-name compare.
export function normIssue(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/g, '').trim();
}

// m:ss / whole-second → "M:SS" is not needed here; trends are counts. clockless.

// Per-scrim TEAM metrics from ONE match's raw deadlock-api payload + the coached side (0|1).
// All fields degrade to 0 on missing data — never throws. objDmg is a proxy (total player damage to
// the ENEMY's structures; ponytail: includes creep-assisted damage, fine for a trend). Caller sums
// these across a scrim's matches before handing the scrim to aggregateTeam.
export function matchMetrics(raw, side) {
  const mi = (raw && raw.match_info) || {};
  const players = Array.isArray(mi.players) ? mi.players : [];
  const objectives = Array.isArray(mi.objectives) ? mi.objectives : [];
  const mine = players.filter((p) => p.team === side);
  const enemy = side === 0 ? 1 : 0;
  const netAt = (s) => players.filter((p) => p.team === s).reduce((n, p) => {
    const frames = Array.isArray(p.stats) ? p.stats : [];
    return n + (Number(frames[frames.length - 1] && frames[frames.length - 1].net_worth) || 0);
  }, 0);
  return {
    deaths: mine.reduce((n, p) => n + (Number(p.deaths) || 0), 0),
    buffs: mine.reduce((n, p) => n + (Array.isArray(p.power_up_buffs) ? p.power_up_buffs.length : 0), 0),
    objDmg: objectives.filter((o) => o.team === enemy).reduce((n, o) => n + (Number(o.player_damage) || 0), 0),
    objLost: objectives.filter((o) => o.team === side && Number(o.destroyed_time_s) > 0).length,
    soulLead: netAt(side) - netAt(enemy),
    won: mi.winning_team === side ? 1 : 0,
    lost: (mi.winning_team === 0 || mi.winning_team === 1) && mi.winning_team !== side ? 1 : 0,
  };
}

// Sum a list of per-match metric bundles into one per-scrim total (soulLead averaged, counts summed).
export function sumMatchMetrics(list = []) {
  const z = { deaths: 0, buffs: 0, objDmg: 0, objLost: 0, soulLead: 0, won: 0, lost: 0 };
  if (!list.length) return z;
  const t = list.reduce((a, m) => ({
    deaths: a.deaths + (m.deaths || 0), buffs: a.buffs + (m.buffs || 0),
    objDmg: a.objDmg + (m.objDmg || 0), objLost: a.objLost + (m.objLost || 0),
    soulLead: a.soulLead + (m.soulLead || 0), won: a.won + (m.won || 0), lost: a.lost + (m.lost || 0),
  }), z);
  return { ...t, soulLead: Math.round(t.soulLead / list.length) };
}

// Fold the per-scrim list (each { date, report, metrics:{...+calloutRate,silentDeaths} }) into the
// aggregate the sidecar stores + the page renders. Input need not be sorted — sorted here by date asc.
export function aggregateTeam({ team, scrims = [] }) {
  const ordered = [...scrims].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const n = ordered.length;

  // Recurring issues: normIssue(text) -> the scrim indexes (asc) that raised it, keeping a display text.
  const issueMap = new Map(); // key -> { text, idxs:[], statuses:[], players:Set }
  ordered.forEach((s, i) => {
    for (const it of (s.report && s.report.actionItems) || []) {
      const key = normIssue(it.text);
      if (!key) continue;
      if (!issueMap.has(key)) issueMap.set(key, { text: it.text, idxs: [], statuses: [], players: new Set() });
      const e = issueMap.get(key);
      e.idxs.push(i); e.statuses.push(it.status || 'pending');
      if (it.player) e.players.add(it.player);
      e.text = it.text; // latest wording wins
    }
  });

  // A "streak" = how many consecutive most-recent scrims raised it (idx n-1, n-2, …).
  const streakOf = (idxs) => { const set = new Set(idxs); let k = 0; for (let i = n - 1; i >= 0; i--) { if (set.has(i)) k++; else break; } return k; };

  const recurring = [...issueMap.values()]
    .filter((e) => e.idxs.length >= 2)
    .map((e) => ({ text: e.text, scrims: e.idxs.length, streak: streakOf(e.idxs) }))
    .sort((a, b) => b.streak - a.streak || b.scrims - a.scrims);

  // Homework ledger: every distinct issue, latest status = status in its most recent scrim.
  const homework = [...issueMap.values()].map((e) => {
    const latest = e.statuses[e.statuses.length - 1] || 'pending';
    return { text: e.text, scrims: e.idxs.length, done: latest === 'done' };
  }).sort((a, b) => Number(a.done) - Number(b.done) || b.scrims - a.scrims);

  // Per-player cards: issues that name a player (report `player` field), + their open count.
  const playerMap = new Map();
  for (const e of issueMap.values()) {
    for (const pl of e.players) {
      if (!playerMap.has(pl)) playerMap.set(pl, []);
      playerMap.get(pl).push({ text: e.text, done: (e.statuses[e.statuses.length - 1] || 'pending') === 'done' });
    }
  }
  const players = [...playerMap.entries()].map(([name, items]) => ({
    name, items, open: items.filter((it) => !it.done).length,
  })).sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));

  // Metric trends: one row per scrim (date + the team metric bundle).
  const metricTrends = ordered.map((s) => ({ date: s.date || '', ...(s.metrics || {}) }));
  const record = ordered.reduce((r, s) => ({ won: r.won + ((s.metrics && s.metrics.won) || 0), lost: r.lost + ((s.metrics && s.metrics.lost) || 0) }), { won: 0, lost: 0 });

  return {
    team, updated: '', scrimCount: n, record,
    recurring, homework, players, metricTrends,
  };
}

// Render the aggregate to the issues-first Team page markdown. `stamp` (YYYY-MM-DD) is injected so the
// pure function stays deterministic (no Date call). The read-only wiki reader strips frontmatter, so
// the page opens with the H1 title.
export function renderTeamPage(agg, stamp = '') {
  const L = [];
  const rec = agg.record || { won: 0, lost: 0 };
  L.push(`# ${agg.team} — Team Progress`);
  L.push(`_${agg.scrimCount} scrim${agg.scrimCount === 1 ? '' : 's'} · ${rec.won}-${rec.lost} matches${stamp ? ` · updated ${stamp}` : ''}_`);
  L.push('');
  L.push('_App-generated from the team\'s scrim reports — do not edit by hand (regenerated on every report)._');

  L.push('');
  L.push('## Recurring Issues');
  if (agg.recurring.length) {
    for (const r of agg.recurring) L.push(`- ⚠ ${r.text} — ${r.streak >= 2 ? `${r.streak} scrims running` : `${r.scrims} scrims`}`);
  } else L.push('_None flagged yet (needs an issue raised in 2+ scrims)._');

  L.push('');
  L.push('## Homework');
  if (agg.homework.length) {
    for (const h of agg.homework) L.push(`- [${h.done ? 'x' : ' '}] ${h.text}${h.scrims > 1 ? ` (${h.scrims} scrims)` : ''}`);
  } else L.push('_No action items yet._');

  L.push('');
  L.push('## Players');
  if (agg.players.length) {
    for (const p of agg.players) {
      L.push(`### ${p.name}${p.open ? ` — ${p.open} open` : ''}`);
      for (const it of p.items) L.push(`- [${it.done ? 'x' : ' '}] ${it.text}`);
    }
    L.push('');
    L.push('_Per-player metric trends need a roster→hero map (match data has no player names) — deferred._');
  } else L.push('_No player-specific items yet._');

  L.push('');
  L.push('## Metric Trends');
  if (agg.metricTrends.length) {
    const rows = agg.metricTrends;
    const cols = [
      ['date', (r) => r.date || '—'],
      ['matches', (r) => `${r.won || 0}-${r.lost || 0}`],
      ['deaths', (r) => r.deaths ?? '—'],
      ['buffs', (r) => r.buffs ?? '—'],
      ['obj dmg', (r) => r.objDmg ?? '—'],
      ['struct lost', (r) => r.objLost ?? '—'],
      ['soul lead', (r) => r.soulLead ?? '—'],
      ['callouts/min', (r) => (r.calloutRate == null ? '—' : r.calloutRate)],
      ['silent deaths', (r) => (r.silentDeaths == null ? '—' : r.silentDeaths)],
      ['jumbled fights', (r) => (r.commsJumbled == null ? '—' : `${Math.round(r.commsJumbled * 100)}%`)],
      ['missed/fight', (r) => (r.commsMissed == null ? '—' : r.commsMissed)],
    ];
    L.push(`| ${cols.map((c) => c[0]).join(' | ')} |`);
    L.push(`| ${cols.map(() => '---').join(' | ')} |`);
    for (const r of rows) L.push(`| ${cols.map((c) => c[1](r)).join(' | ')} |`);
  } else L.push('_No match data yet._');

  L.push('');
  return L.join('\n');
}

// The team's currently-OPEN homework (pending issues) → priorActionItems for a fresh VOD report's
// follow-up loop (sub-plan 11's empty-tolerant slot). Reads the stored aggregate sidecar object.
export function openHomework(agg) {
  return ((agg && agg.homework) || []).filter((h) => !h.done).map((h) => ({ id: normIssue(h.text), text: h.text }));
}

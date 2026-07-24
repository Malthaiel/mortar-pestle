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

// Fold the per-scrim list into the aggregate the sidecar stores + the page renders. Each scrim entry
// is { date, report, matchReports, metrics:{...+calloutRate,silentDeaths}, folder }: `report` is the
// legacy scrim-level .vodreport (kept so pre-match-pipeline data never vanishes), `matchReports` is
// the per-match FINAL reports ([{ n, report }] — M6: matchfinal sidecars only; first reports feed
// nothing). Input need not be sorted — sorted here by date asc.
export function aggregateTeam({ team, scrims = [] }) {
  const ordered = [...scrims].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const n = ordered.length;

  // Every report a scrim contributes, with the {scrim, match} source each item will carry
  // (match: null = the legacy scrim-level report). Same-issue items across matches of one scrim
  // fold into ONE map entry listing both sources — that's the within-scrim dedupe (conservative:
  // normIssue exact match only; different wording keeps both).
  const reportsOf = (s) => [
    ...(s.report ? [{ report: s.report, match: null }] : []),
    ...((Array.isArray(s.matchReports) ? s.matchReports : []).map((mr) => ({ report: mr.report, match: mr.n ?? null }))),
  ];

  // Recurring issues: normIssue(text) -> the scrim indexes (asc) that raised it, keeping a display text.
  // `sources` tracks WHICH {scrim, match} raised each issue so openHomework can exclude a match's own
  // items when feeding it back as prior action items (else a regenerate echoes its own list as "persisting").
  const issueMap = new Map(); // key -> { text, idxs:[], statuses:[], players:Set, sources:Map }
  ordered.forEach((s, i) => {
    for (const { report, match } of reportsOf(s)) {
      for (const it of (report && report.actionItems) || []) {
        const key = normIssue(it.text);
        if (!key) continue;
        if (!issueMap.has(key)) issueMap.set(key, { text: it.text, idxs: [], statuses: [], players: new Set(), sources: new Map() });
        const e = issueMap.get(key);
        if (e.idxs[e.idxs.length - 1] !== i) e.idxs.push(i); // two matches, one scrim = one scrim index
        e.statuses.push(it.status || 'pending');
        if (it.player) e.players.add(it.player);
        if (s.folder) e.sources.set(`${s.folder}#${match ?? ''}`, { scrim: s.folder, match });
        e.text = it.text; // latest wording wins
      }
    }
  });

  // A "streak" = how many consecutive most-recent scrims raised it (idx n-1, n-2, …).
  const streakOf = (idxs) => { const set = new Set(idxs); let k = 0; for (let i = n - 1; i >= 0; i--) { if (set.has(i)) k++; else break; } return k; };

  const recurring = [...issueMap.values()]
    .filter((e) => e.idxs.length >= 2)
    .map((e) => ({ text: e.text, scrims: e.idxs.length, streak: streakOf(e.idxs) }))
    .sort((a, b) => b.streak - a.streak || b.scrims - a.scrims);

  // Homework ledger: every distinct issue, latest status = status in its most recent scrim.
  // `sources` = the {scrim, match} pairs that raised it (openHomework drops an issue whose ONLY
  // source is the match being generated — that's the self-loop guard, at match grain since M6).
  const homework = [...issueMap.values()].map((e) => {
    const latest = e.statuses[e.statuses.length - 1] || 'pending';
    return { text: e.text, scrims: e.idxs.length, done: latest === 'done', sources: [...e.sources.values()] };
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

  // Recurring lessons (VOD Report Sections): fold report section headings across scrims into a
  // taught-topics ledger — repeated headings = themes the coach keeps re-teaching. All lessons kept
  // (a one-scrim lesson is still a ledger entry), sorted most-repeated first then most-recent.
  const lessonMap = new Map(); // key -> { heading, dates:[] }
  ordered.forEach((s) => {
    const seen = new Set(); // a heading taught in two matches of one scrim = one date entry
    for (const { report } of reportsOf(s)) {
      for (const sec of (report && report.sections) || []) {
        const key = normIssue(sec.heading);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (!lessonMap.has(key)) lessonMap.set(key, { heading: sec.heading, dates: [] });
        const e = lessonMap.get(key);
        e.dates.push(s.date || '');
        e.heading = sec.heading; // latest wording wins
      }
    }
  });
  const recurringLessons = [...lessonMap.values()]
    .map((e) => ({ heading: e.heading, count: e.dates.length, dates: e.dates }))
    .sort((a, b) => b.count - a.count || String(b.dates[b.dates.length - 1]).localeCompare(String(a.dates[a.dates.length - 1])));

  // Metric trends: one row per scrim (date + the team metric bundle).
  const metricTrends = ordered.map((s) => ({ date: s.date || '', ...(s.metrics || {}) }));
  const record = ordered.reduce((r, s) => ({ won: r.won + ((s.metrics && s.metrics.won) || 0), lost: r.lost + ((s.metrics && s.metrics.lost) || 0) }), { won: 0, lost: 0 });

  return {
    team, updated: '', scrimCount: n, record,
    recurring, recurringLessons, homework, players, metricTrends,
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
  L.push('## Recurring Lessons');
  const lessons = agg.recurringLessons || [];
  if (lessons.length) {
    for (const le of lessons) {
      const last = le.dates && le.dates.length ? le.dates[le.dates.length - 1] : '';
      L.push(`- ${le.heading} — ${le.count} scrim${le.count === 1 ? '' : 's'}${last ? ` (last ${last})` : ''}`);
    }
  } else L.push('_No taught topics captured yet (sections land with each generated report)._');

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

// The team's currently-OPEN homework (pending issues) → priorActionItems for a fresh report's
// follow-up loop (sub-plan 11's empty-tolerant slot). Reads the stored aggregate sidecar object.
// `excludeScrim` (+ optional `excludeMatch`, M6) drops issues whose EVERY source is the excluded
// scope: without it, regenerating a report feeds its own action items back as "prior" → the model
// reports them as persisting follow-ups, duplicating the action list (the followUps self-loop).
// Match grain means regenerating Match 2's final still sees Match 1's items as genuine priors.
// Filtering is source-membership ONLY, never text/id equality. Sources may be old-format strings
// (pre-M6 aggregates) — normalized here; a source with match:null (a legacy scrim-level report)
// only matches a scrim-grain exclusion. Legacy entries with NO sources can't prove self-only
// membership, so they're kept unless the team has just one scrim.
export function openHomework(agg, { excludeScrim = null, excludeMatch = null } = {}) {
  const solo = (agg?.scrimCount || 0) <= 1;
  const norm = (x) => (typeof x === 'string' ? { scrim: x, match: null } : { scrim: x?.scrim, match: x?.match ?? null });
  const excluded = (x) => {
    const s = norm(x);
    if (s.scrim !== excludeScrim) return false;
    return excludeMatch == null ? true : s.match === excludeMatch;
  };
  return ((agg && agg.homework) || [])
    .filter((h) => !h.done)
    .filter((h) => {
      if (!excludeScrim) return true;
      const src = Array.isArray(h.sources) ? h.sources : null;
      if (!src || !src.length) return !solo; // no sources → self-loop-safe only when other scrims exist
      return !src.every(excluded); // every source is the excluded scope → drop
    })
    .map((h) => ({ id: normIssue(h.text), text: h.text }));
}

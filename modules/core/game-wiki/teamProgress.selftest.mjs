// Runnable check for teamProgress.js pure logic: `node teamProgress.selftest.mjs`.
// Covers recurrence/streak, homework done-state, per-player grouping, metric summing, page render,
// and openHomework — the parts that silently rot if the aggregation drifts.
import assert from 'node:assert/strict';
import { matchMetrics, sumMatchMetrics, aggregateTeam, renderTeamPage, openHomework, normIssue } from './teamProgress.js';

// normIssue: same problem, different punctuation/case/space
assert.equal(normIssue('Ward the River.'), normIssue('ward   the river'));

// matchMetrics from a minimal raw payload
const raw = { match_info: {
  winning_team: 0,
  players: [
    { team: 0, deaths: 3, power_up_buffs: [{}, {}], stats: [{ net_worth: 100 }, { net_worth: 5000 }] },
    { team: 0, deaths: 2, power_up_buffs: [], stats: [{ net_worth: 4000 }] },
    { team: 1, deaths: 6, power_up_buffs: [{}], stats: [{ net_worth: 3000 }] },
  ],
  objectives: [
    { team: 1, player_damage: 800, destroyed_time_s: 0 },   // enemy structure, took dmg
    { team: 0, player_damage: 200, destroyed_time_s: 300 },  // our structure, destroyed
  ],
} };
const mm = matchMetrics(raw, 0);
assert.equal(mm.deaths, 5);      // 3 + 2
assert.equal(mm.buffs, 2);
assert.equal(mm.objDmg, 800);    // damage to enemy (team 1) structures
assert.equal(mm.objLost, 1);     // our destroyed structure
assert.equal(mm.soulLead, 9000 - 3000); // (5000+4000) - 3000
assert.equal(mm.won, 1);
assert.equal(mm.lost, 0);

// sum across matches: soulLead averaged, rest summed
const summed = sumMatchMetrics([{ deaths: 5, soulLead: 6000, won: 1, lost: 0 }, { deaths: 4, soulLead: 2000, won: 0, lost: 1 }]);
assert.equal(summed.deaths, 9);
assert.equal(summed.soulLead, 4000);
assert.equal(summed.won, 1); assert.equal(summed.lost, 1);

// aggregateTeam: one recurring issue across 2 scrims, one one-off; a done toggle in the later scrim
const scrims = [
  { date: '2026-07-01', report: { actionItems: [
    { id: 'ward-river', text: 'Ward the river', player: 'Alex', status: 'pending' },
    { id: 'save-ult', text: 'Save ult for retreats', player: null, status: 'pending' },
  ] }, metrics: { deaths: 28, buffs: 6, objDmg: 4000, objLost: 3, soulLead: -2000, won: 1, lost: 1, calloutRate: 4.2, silentDeaths: 5 } },
  { date: '2026-07-08', report: { actionItems: [
    { id: 'ward-river', text: 'Ward river bushes', player: 'Alex', status: 'pending' },   // recurs (normalizes close-ish? no — different words)
    { id: 'save-ult', text: 'Save ult for retreats', player: null, status: 'done' },       // recurs + now done
  ] }, metrics: { deaths: 24, buffs: 8, objDmg: 5200, objLost: 2, soulLead: 1500, won: 2, lost: 0, calloutRate: 5.1, silentDeaths: 3 } },
];
const agg = aggregateTeam({ team: 'Reliquary', scrims });
assert.equal(agg.scrimCount, 2);
assert.deepEqual(agg.record, { won: 3, lost: 1 });
// 'Save ult for retreats' is identical text in both → recurring, streak 2
const saveUlt = agg.recurring.find((r) => normIssue(r.text) === normIssue('Save ult for retreats'));
assert.ok(saveUlt, 'save-ult should be recurring');
assert.equal(saveUlt.scrims, 2);
assert.equal(saveUlt.streak, 2);
// homework: save-ult latest status done → checked; ward variants are one-offs (different text) → open
const hwSave = agg.homework.find((h) => normIssue(h.text) === normIssue('Save ult for retreats'));
assert.equal(hwSave.done, true);
// players: Alex has ward items, appears with open>0
const alex = agg.players.find((p) => p.name === 'Alex');
assert.ok(alex && alex.open >= 1);
// metric trends: 2 rows, newest metrics present
assert.equal(agg.metricTrends.length, 2);
assert.equal(agg.metricTrends[1].deaths, 24);

// openHomework: pending issues only (save-ult is done → excluded)
const open = openHomework(agg);
assert.ok(!open.some((o) => normIssue(o.text) === normIssue('Save ult for retreats')));
assert.ok(open.length >= 1);

// M1 followUps self-loop guard: homework carries source scrims; openHomework({excludeScrim}) drops
// issues sourced ONLY from the excluded scrim (its own items) but keeps cross-scrim ones.
const loopScrims = [
  { date: '2026-07-01', folder: 'ScrimA', report: { actionItems: [
    { text: 'Contest mid boss', player: null, status: 'pending' },   // ScrimA only
    { text: 'Ward the river', player: 'Alex', status: 'pending' },    // also raised in ScrimB
  ] }, metrics: {} },
  { date: '2026-07-08', folder: 'ScrimB', report: { actionItems: [
    { text: 'Ward the river', player: 'Alex', status: 'pending' },    // recurs → sources [A, B]
    { text: 'Rotate on pings', player: null, status: 'pending' },     // ScrimB only
  ] }, metrics: {} },
];
const loopAgg = aggregateTeam({ team: 'Loop', scrims: loopScrims });
assert.deepEqual(loopAgg.homework.find((h) => normIssue(h.text) === normIssue('Contest mid boss')).sources, [{ scrim: 'ScrimA', match: null }]);
assert.deepEqual([...loopAgg.homework.find((h) => normIssue(h.text) === normIssue('Ward the river')).sources].map((s) => s.scrim).sort(), ['ScrimA', 'ScrimB']);
assert.equal(openHomework(loopAgg).length, 3, 'no excludeScrim → all three open issues');
const openA = openHomework(loopAgg, { excludeScrim: 'ScrimA' });
assert.ok(!openA.some((o) => normIssue(o.text) === normIssue('Contest mid boss')), 'ScrimA-only item excluded');
assert.ok(openA.some((o) => normIssue(o.text) === normIssue('Ward the river')), 'cross-scrim item kept');
assert.ok(openA.some((o) => normIssue(o.text) === normIssue('Rotate on pings')), 'other scrim solo item kept');
// legacy single-scrim sidecar (no sources key, scrimCount 1) → excludeScrim drops everything (self-loop-safe)
const soloAgg = aggregateTeam({ team: 'Solo', scrims: [{ date: '2026-07-01', folder: 'Solo1', report: { actionItems: [{ text: 'Solo item', status: 'pending' }] }, metrics: {} }] });
soloAgg.homework = soloAgg.homework.map((h) => { const { sources, ...rest } = h; return rest; }); // simulate a pre-sources sidecar
assert.equal(openHomework(soloAgg, { excludeScrim: 'Solo1' }).length, 0, 'legacy single-scrim self-loop excluded');
// old-format sidecar (string sources, pre-M6): scrim-grain exclusion still lands; match-grain
// exclusion never matches a scrim-level source (those items are a different report, not the final's own)
const strAgg = { scrimCount: 2, homework: [{ text: 'Old item', done: false, sources: ['ScrimA'] }] };
assert.equal(openHomework(strAgg, { excludeScrim: 'ScrimA' }).length, 0, 'old string sources normalize + exclude at scrim grain');
assert.equal(openHomework(strAgg, { excludeScrim: 'ScrimA', excludeMatch: 2 }).length, 1, 'a scrim-level source is not a match source');

// M6 match grain: per-match FINAL reports aggregate with {scrim, match} sources; regenerating one
// match's final must not see its own items, while a sibling match's stay genuine priors; the same
// issue across two matches of one scrim folds into ONE entry listing both sources.
const m6Scrims = [
  { date: '2026-07-10', folder: 'ScrimC', report: null, metrics: {}, matchReports: [
    { n: 1, report: { actionItems: [
      { text: 'Track ult cooldowns', player: null, status: 'pending' },
      { text: 'Buy Knockdown into Vindicta', player: 'Sam', status: 'pending' },
    ], sections: [{ heading: 'Tempo', md: 'x' }] } },
    { n: 3, report: { actionItems: [
      { text: 'Track ult cooldowns', player: null, status: 'pending' },
      { text: 'Stop face-checking bushes', player: null, status: 'pending' },
    ], sections: [{ heading: 'Tempo', md: 'y' }] } },
  ] },
];
const m6Agg = aggregateTeam({ team: 'C', scrims: m6Scrims });
const folded = m6Agg.homework.find((h) => normIssue(h.text) === normIssue('Track ult cooldowns'));
assert.deepEqual(folded.sources.map((s) => s.match).sort(), [1, 3], 'same issue across matches folds into one entry, both sources kept');
assert.equal(folded.scrims, 1, 'two matches in one scrim = one scrim occurrence, not two');
const openM3 = openHomework(m6Agg, { excludeScrim: 'ScrimC', excludeMatch: 3 });
assert.ok(!openM3.some((o) => normIssue(o.text) === normIssue('Stop face-checking bushes')), 'the regenerated match’s own item excluded');
assert.ok(openM3.some((o) => normIssue(o.text) === normIssue('Track ult cooldowns')), 'folded cross-match item kept (Match 1 source remains)');
assert.ok(openM3.some((o) => normIssue(o.text) === normIssue('Buy Knockdown into Vindicta')), 'sibling match’s item kept as a genuine prior');
// the self-loop, dead: a team whose only final is the regenerated match → zero priors
const m6Solo = aggregateTeam({ team: 'D', scrims: [{ date: '2026-07-11', folder: 'ScrimD', report: null, metrics: {}, matchReports: [
  { n: 1, report: { actionItems: [{ text: 'Solo match item', status: 'pending' }] } },
] }] });
assert.equal(openHomework(m6Solo, { excludeScrim: 'ScrimD', excludeMatch: 1 }).length, 0, 'regenerate sees none of its own items as prior');
// matchfinal sections feed recurringLessons, once per scrim even when taught in two matches
assert.deepEqual(m6Agg.recurringLessons, [{ heading: 'Tempo', count: 1, dates: ['2026-07-10'] }], 'a heading in two matches of one scrim = one date entry');

// recurringLessons (VOD Report Sections): headings folded across scrims, repeats counted, all kept
const lessonScrims = [
  { date: '2026-07-01', report: { actionItems: [], sections: [{ id: 'tempo', heading: 'Tempo', md: 'x' }] }, metrics: {} },
  { date: '2026-07-08', report: { actionItems: [], sections: [{ id: 'tempo', heading: 'Tempo', md: 'y' }, { id: 'convert', heading: 'Convert', md: 'z' }] }, metrics: {} },
];
const lagg = aggregateTeam({ team: 'Reliquary', scrims: lessonScrims });
assert.equal(lagg.recurringLessons.length, 2);
assert.deepEqual(lagg.recurringLessons[0], { heading: 'Tempo', count: 2, dates: ['2026-07-01', '2026-07-08'] });
assert.equal(lagg.recurringLessons[1].count, 1);
const lmd = renderTeamPage(lagg, '2026-07-09');
assert.ok(lmd.includes('## Recurring Lessons'));
assert.ok(lmd.includes('- Tempo — 2 scrims (last 2026-07-08)'));
// sections-less legacy reports degrade to the empty-state line
assert.ok(renderTeamPage(aggregateTeam({ team: 'X', scrims: [] }), '').includes('No taught topics captured yet'));

// renderTeamPage: issues-first order, deterministic (stamp injected), has all sections + a table
const md = renderTeamPage(agg, '2026-07-09');
assert.ok(md.startsWith('# Reliquary — Team Progress'));
assert.ok(md.indexOf('## Recurring Issues') < md.indexOf('## Players')); // issues-first
assert.ok(md.includes('## Homework') && md.includes('## Metric Trends'));
assert.ok(md.includes('| date |') && md.includes('| 2026-07-08 |'));
assert.ok(md.includes('3 scrims running') || md.includes('2 scrims running')); // streak line

console.log('teamProgress.selftest: all assertions passed');

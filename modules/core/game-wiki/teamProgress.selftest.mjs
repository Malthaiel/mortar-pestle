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

// renderTeamPage: issues-first order, deterministic (stamp injected), has all sections + a table
const md = renderTeamPage(agg, '2026-07-09');
assert.ok(md.startsWith('# Reliquary — Team Progress'));
assert.ok(md.indexOf('## Recurring Issues') < md.indexOf('## Players')); // issues-first
assert.ok(md.includes('## Homework') && md.includes('## Metric Trends'));
assert.ok(md.includes('| date |') && md.includes('| 2026-07-08 |'));
assert.ok(md.includes('3 scrims running') || md.includes('2 scrims running')); // streak line

console.log('teamProgress.selftest: all assertions passed');

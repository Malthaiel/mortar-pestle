// Runnable check for carryForward.js (no framework): `node carryForward.selftest.mjs`.
// The two things that must never break: text is copied VERBATIM (this sheet is the coach's own
// approved wording, not a summary), and the dedupe is conservative (a wrong fold silently eats a
// row, so different wording must keep both and a real fold must cite every source match).
import assert from 'node:assert/strict';
import { buildCarryForward, finalMatchNumbers, CARRY_FORWARD_FILE } from './carryForward.js';

// Only .matchfinal sidecars count, deduped and sorted — a first report or a match data blob must
// never pull a report-less match into the sheet.
assert.deepEqual(finalMatchNumbers([
  '.matchfinal.Match 3.json', 'Match 1.md', '.matchreport.Match 2.json',
  '.matchfinal.Match 1.json', '.matchdata.Match 1.json', '.matchfinal.Match 1.json',
]), [1, 3]);
assert.deepEqual(finalMatchNumbers(), [], 'no listing degrades to []');
assert.deepEqual(finalMatchNumbers(['.matchfinal.Match 0.json', '.matchfinal.Match x.json']), [], 'bad match numbers rejected');

assert.equal(CARRY_FORWARD_FILE, 'Carry-Forward.md');

// Nothing to carry -> '' so the caller never writes an empty file (M24's fork).
assert.equal(buildCarryForward([]), '');
assert.equal(buildCarryForward([{ n: 1, report: { actionItems: [], carry: [] } }]), '');
assert.equal(buildCarryForward(null), '', 'garbage input degrades');
assert.equal(buildCarryForward([{ n: 1, report: null }, { n: 2 }]), '', 'reportless entries are skipped');

const HABIT = 'Matt has not bought Counterspell since the rework — a habit dating to the item pass.';
const m1 = {
  n: 1,
  report: {
    actionItems: [
      { text: 'hold the ult for the second engage', player: 'Celeste' },
      { text: 'ward the mid-boss pit before the 20:00 window', player: null },
    ],
    carry: [
      { kind: 'habit', text: HABIT, player: 'Matt', stamp: '[27:49]' },
      { kind: 'debate', text: 'Rapid Recharge on Infernus — left unsettled.', player: null, stamp: '' },
    ],
  },
};
const m3 = {
  n: 3,
  report: {
    actionItems: [
      { text: 'Hold the ult for the second engage.', player: 'Celeste' }, // same issue, different casing/punctuation
      { text: 'hold the ult until the enemy commits', player: 'Celeste' }, // genuinely different wording
    ],
    carry: [
      { kind: 'habit', text: HABIT, player: 'Matt', stamp: '[04:12]' }, // same habit, second match
      { kind: 'plan', text: 'draft a shred item into the next comp', player: null, stamp: '[41:02]' },
    ],
  },
};

const md = buildCarryForward([m3, m1], { scrim: 'North VS Extinction (07-20-26)', date: '2026-07-24' });

// Header: names the scrim, the build date, and every source report — in match order despite the
// caller passing Match 3 first.
assert.ok(md.startsWith('Carry-forward for North VS Extinction (07-20-26), built 2026-07-24.'), 'header names scrim + date');
assert.ok(md.includes('final reports of: Match 1, Match 3.'), `sources listed in match order:\n${md}`);

// Section order is fixed: Action Items, then habits, debates, plans.
assert.deepEqual(
  [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
  ['Action Items', 'Season-Long Habits', 'Open Debates', 'Next-Scrim Plans'],
  'four sections in the locked order',
);

// Dedupe: the same action across two matches folds to ONE checkbox citing both; the differently
// worded one survives as its own row (conservative — unsure keeps both).
assert.ok(md.includes('- [ ] hold the ult for the second engage — Celeste (M1, M3)'), `folded item cites both matches:\n${md}`);
assert.ok(md.includes('- [ ] hold the ult until the enemy commits — Celeste (M3)'), 'different wording keeps its own row');
assert.equal((md.match(/^- \[ \] /gm) || []).length, 3, 'three action items survive, not four');

// Verbatim: the habit's text is copied character for character, em dash and all, and folds across
// both matches carrying BOTH stamps.
assert.ok(md.includes(HABIT), 'habit text is copied verbatim');
assert.ok(md.includes(`- ${HABIT} — Matt [27:49] M1, [04:12] M3`), `folded habit carries both stamps:\n${md}`);

// A stampless entry still gets its match tag; a plan keeps its stamp as PLAIN text (no chip token).
assert.ok(md.includes('- Rapid Recharge on Infernus — left unsettled. M1'), 'stampless entry still tagged with its match');
assert.ok(md.includes('- draft a shred item into the next comp [41:02] M3'), 'plan keeps a plain-text stamp');

// A section with nothing in it is omitted rather than emitted empty.
const onlyPlans = buildCarryForward([{ n: 2, report: { carry: [{ kind: 'plan', text: 'scrim the same comp again', stamp: '' }] } }]);
assert.deepEqual([...onlyPlans.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Next-Scrim Plans'], 'empty sections omitted');
assert.ok(!onlyPlans.includes('Action Items'));

console.log('carryForward.selftest: all assertions passed');

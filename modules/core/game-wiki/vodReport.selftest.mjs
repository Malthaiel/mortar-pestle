// Runnable check for vodReport.js pure logic (no framework): `node vodReport.selftest.mjs`.
// Covers the parts that break silently — transcript formatting, tolerant parse (fenced + noisy),
// coercion of a missing id, and checkbox reconcile across a regenerate.
import assert from 'node:assert/strict';
import { mmss, slugId, buildTranscriptBlock, parseReport, reconcileReport } from './vodReport.js';

// mmss
assert.equal(mmss(0), '0:00');
assert.equal(mmss(75), '1:15');
assert.equal(mmss(-3), '0:00');
assert.equal(mmss('abc'), '0:00');

// slugId deterministic
assert.equal(slugId('Rotate MID after first tower!'), 'rotate-mid-after-first-tower');
assert.equal(slugId(''), 'item');

// transcript block: drops empty text, stamps speaker + m:ss
const block = buildTranscriptBlock([
  { t0Ms: 0, t1Ms: 1000, text: 'ok so first fight', speaker: 'Coach' },
  { t0Ms: 90000, t1Ms: 92000, text: '  ', speaker: 'Alex' },
  { t0Ms: 125000, t1Ms: 126000, text: 'why did we dive?', speaker: 'Sam' },
]);
assert.equal(block, '[0:00] Coach: ok so first fight\n[2:05] Sam: why did we dive?');

// tolerant parse: fenced JSON with noise, missing id gets a slug, unknown status → pending
const raw = '```json\n{"tldr":"good macro","actionItems":[{"text":"ward river","count":2,"timestamps":["1:15","3:40"]}],"qa":[],"keepDoing":["early game"],"debates":[],"followUps":[]}\n```';
const rep = parseReport(raw);
assert.equal(rep.tldr, 'good macro');
assert.equal(rep.actionItems.length, 1);
assert.equal(rep.actionItems[0].id, 'ward-river'); // id derived from text
assert.equal(rep.actionItems[0].status, 'pending');
assert.deepEqual(rep.keepDoing, ['early game']);

// parse throws on no object
assert.throws(() => parseReport('no json here'), /no JSON object/);

// reconcile: a done toggle on a matching id survives a regenerate; fresh text wins
const prior = { actionItems: [{ id: 'ward-river', text: 'ward river (old wording)', status: 'done' }] };
const fresh = { tldr: 'x', actionItems: [{ id: 'ward-river', text: 'ward the river bushes', status: 'pending' }], qa: [], keepDoing: [], debates: [], followUps: [] };
const merged = reconcileReport(fresh, prior);
assert.equal(merged.actionItems[0].status, 'done');           // human toggle carried
assert.equal(merged.actionItems[0].text, 'ward the river bushes'); // fresh AI content wins
// a fresh item with no prior match stays pending
const merged2 = reconcileReport({ actionItems: [{ id: 'new-thing', text: 'new', status: 'pending' }] }, prior);
assert.equal(merged2.actionItems[0].status, 'pending');

console.log('vodReport.selftest: all assertions passed');

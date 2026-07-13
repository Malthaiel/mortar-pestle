// Runnable check for vodReport.js pure logic (no framework): `node vodReport.selftest.mjs`.
// Covers the parts that break silently — transcript formatting, tolerant parse (fenced + noisy),
// coercion of a missing id, and checkbox reconcile across a regenerate.
import assert from 'node:assert/strict';
import { mmss, slugId, buildTranscriptBlock, buildReportPrompt, parseReport, reconcileReport } from './vodReport.js';

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

// missing sections key coerces to [] (old sidecars / forgetful model)
assert.deepEqual(rep.sections, []);

// sections: id derived from heading, empty entries dropped, md + [m:ss] tokens pass through verbatim
const secRaw = JSON.stringify({
  tldr: 't',
  sections: [
    { heading: 'Gaining a Lead', md: '1. Win lane [2:05]\n2. Gank\n\n| Down | Up |\n|---|---|\n| Group | Split |' },
    { heading: '', md: '' },
  ],
  actionItems: [], qa: [], keepDoing: [], debates: [], followUps: [],
});
const secRep = parseReport(secRaw);
assert.equal(secRep.sections.length, 1);
assert.equal(secRep.sections[0].id, 'gaining-a-lead');
assert.ok(secRep.sections[0].md.includes('[2:05]'));
assert.ok(secRep.sections[0].md.includes('| Down | Up |'));

// notesBlock: included when non-empty, omitted when blank
const withNotes = buildReportPrompt({ transcriptBlock: 'T', notesBlock: '### Convert\n- take midboss' });
assert.ok(withNotes.includes('Player-written notes'));
assert.ok(withNotes.includes('take midboss'));
assert.ok(!buildReportPrompt({ transcriptBlock: 'T' }).includes('Player-written notes'));
assert.ok(!buildReportPrompt({ transcriptBlock: 'T', notesBlock: '  ' }).includes('Player-written notes'));

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

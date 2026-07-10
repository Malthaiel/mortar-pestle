// Runnable check for diarize.js pure logic (no framework): `node diarize.selftest.mjs`.
// Covers dropUnattributed — the silence-hallucination filter ("Thank you." spam from
// whisper on quiet stretches must drop; real attributed speech and legacy no-diarization
// runs must survive untouched).
import assert from 'node:assert/strict';
import { alignDiarization, dropUnattributed } from './diarize.js';

const spans = [{ t0Ms: 1000, t1Ms: 3000, clusterId: 0 }];
const segs = [
  { t0Ms: 1200, t1Ms: 2500, text: 'push mid now' }, // overlaps span → kept
  { t0Ms: 9000, t1Ms: 9500, text: 'Thank you.' },   // silence hallucination → dropped
];

const aligned = alignDiarization(segs, spans);
assert.equal(aligned[0].cluster, 0);
assert.equal(aligned[1].cluster, null);

const filtered = dropUnattributed(aligned, spans);
assert.equal(filtered.length, 1);
assert.equal(filtered[0].text, 'push mid now');

// No spans (legacy / diarization failed) → no-op, every row survives.
const legacy = alignDiarization(segs, []);
assert.equal(dropUnattributed(legacy, []).length, 2);
assert.equal(dropUnattributed(legacy, undefined).length, 2);

// Defensive shapes.
assert.deepEqual(dropUnattributed(undefined, spans), []);

console.log('diarize.selftest: PASS');

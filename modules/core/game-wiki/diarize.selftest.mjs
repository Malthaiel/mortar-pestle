// Runnable check for diarize.js pure logic (no framework): `node diarize.selftest.mjs`.
// Covers alignDiarization — attributed rows get their overlapping cluster; rows the
// diarizer missed keep cluster: null (rendered "Unknown") and are NEVER dropped: the
// engine's VAD pre-pass kills silence hallucinations at source, so an unattributed
// row is real speech the diarizer's coverage missed.
import assert from 'node:assert/strict';
import { alignDiarization, labelForCluster } from './diarize.js';

const spans = [{ t0Ms: 1000, t1Ms: 3000, clusterId: 0 }];
const segs = [
  { t0Ms: 1200, t1Ms: 2500, text: 'push mid now' }, // overlaps span → cluster 0
  { t0Ms: 9000, t1Ms: 9500, text: 'he is behind our tower' }, // diarizer hole → null, KEPT
];

const aligned = alignDiarization(segs, spans);
assert.equal(aligned.length, 2); // nothing dropped
assert.equal(aligned[0].cluster, 0);
assert.equal(aligned[1].cluster, null);
assert.equal(labelForCluster(aligned[1].cluster), 'Unknown');

// No spans (legacy / diarization failed) → every row survives with cluster: null.
const legacy = alignDiarization(segs, []);
assert.equal(legacy.length, 2);
assert.equal(legacy[0].cluster, null);

// Defensive shapes.
assert.deepEqual(alignDiarization(undefined, spans), []);

console.log('diarize.selftest: PASS');

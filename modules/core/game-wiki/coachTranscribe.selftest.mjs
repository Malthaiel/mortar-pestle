// Runnable check for coachTranscribe.js (no framework): `node coachTranscribe.selftest.mjs`.
// The assertions below ARE the method.py contract — if one fails, a real coaching run either
// miscounts its turns or silently truncates.
import assert from 'node:assert/strict';
import { clusterKey, coachTranscribe, labelCoach, stamp, summarizeSpeakers } from './coachTranscribe.js';

// method.py's own turn counter, copied verbatim from its TURN_RE.
const TURN_RE = /^\s*\d+:\d{2}\s*$/;

assert.equal(stamp(0), '0:00');
assert.equal(stamp(6000), '0:06');
assert.equal(stamp(65_000), '1:05');
// Past an hour the minutes keep counting — they do NOT wrap to 0:xx.
assert.equal(stamp(4_335_000), '72:15');

const md = coachTranscribe([
  { t0Ms: 0, t1Ms: 900, speaker: 'Speaker 1', text: 'my builds are awful' },
  { t0Ms: 6000, t1Ms: 8000, speaker: 'Speaker 2', text: '  okay, general lesson then  ' },
  { t0Ms: 9000, t1Ms: 9200, speaker: 'Speaker 1', text: '   ' }, // blank → dropped
]);

const lines = md.split('\n').filter((l) => l !== '');
assert.deepEqual(lines, [
  '0:00', 'Speaker 1', 'my builds are awful',
  '0:06', 'Speaker 2', 'okay, general lesson then',
]);
// Three lines per turn, and exactly one of them looks like a timestamp to method.py.
assert.equal(lines.length % 3, 0);
assert.equal(lines.filter((l) => TURN_RE.test(l)).length, 2);

// No segments → an empty body, not a crash and not a stray blank turn.
assert.equal(coachTranscribe([]).trim(), '');
assert.equal(coachTranscribe(null).trim(), '');

// ── the coach label — the part coach.py refuses to work without ──────────────────────────
const spoken = [
  { t0Ms: 0, cluster: 3, speaker: 'Speaker 4', text: 'okay so what you want here is a fight you can leave' },
  { t0Ms: 1000, cluster: 3, speaker: 'Speaker 4', text: 'same mistake again' },
  { t0Ms: 2000, cluster: 3, speaker: 'Speaker 4', text: 'yes' },
  { t0Ms: 3000, cluster: 0, speaker: 'Speaker 1', text: 'my builds are awful' },
  { t0Ms: 4000, cluster: null, speaker: 'Unknown', text: 'a line the diarizer missed' },
];

const rows = summarizeSpeakers(spoken);
assert.equal(rows.length, 3);
assert.equal(rows[0].key, '3');            // most talkative first
assert.equal(rows[0].count, 3);
assert.equal(rows[0].sample, 'okay so what you want here is a fight you can leave'); // not 'yes'
assert.equal(rows[2].key, 'unknown');      // the unattributed voice is offered too — it may be the coach
assert.equal(clusterKey(null), 'unknown');
assert.equal(clusterKey(0), '0');          // cluster 0 is falsy and must NOT collapse to unknown

// Several clusters can be the same person: the diarizer split ~4 people into 26 on a real run.
const named = labelCoach(spoken, new Set(['3', 'unknown']), 'Malthaiel');
assert.deepEqual(named.map((s) => s.speaker),
  ['Malthaiel', 'Malthaiel', 'Malthaiel', 'Speaker 1', 'Malthaiel']);
assert.equal(spoken[0].speaker, 'Speaker 4'); // never mutates the input

// Nothing picked → untouched. coach.py would reject this transcript, which is the caller's gate.
assert.deepEqual(labelCoach(spoken, new Set(), 'Malthaiel').map((s) => s.speaker),
  ['Speaker 4', 'Speaker 4', 'Speaker 4', 'Speaker 1', 'Unknown']);

// The label has to reach the file, since that string is what coach.py matches on.
assert.ok(coachTranscribe(named).includes('\nMalthaiel\n'));

console.log('coachTranscribe selftest OK');

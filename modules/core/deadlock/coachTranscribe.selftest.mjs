// Runnable check for coachTranscribe.js (no framework): `node coachTranscribe.selftest.mjs`.
// The assertions below ARE the method.py contract — if one fails, a real coaching run either
// miscounts its turns or silently truncates.
import assert from 'node:assert/strict';
import { coachTranscribe, stamp } from './coachTranscribe.js';
import { mergeTranscripts } from './diarize.js';

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
// The Job 3 path CoachPopup actually runs: the mic pass is all coach, the Discord pass is all
// Student, and mergeTranscripts interleaves them by time. Every speaker string below is one
// coach.py matches on, so a drift here is wrong notes rather than a failed run.
const merged = mergeTranscripts({
  micSegments: [
    { t0Ms: 0, t1Ms: 3000, text: 'okay so what you want here is a fight you can leave' },
    { t0Ms: 6000, t1Ms: 7000, text: 'same mistake again' },
  ],
  commsSegments: [
    { t0Ms: 4000, t1Ms: 5000, text: 'my builds are awful', cluster: 0 },
  ],
  micSpeaker: 'Malthaiel',
  nameMap: { 0: 'Student' },
});
assert.deepEqual(merged.map((s) => s.speaker), ['Malthaiel', 'Student', 'Malthaiel']); // time order

const mergedLines = coachTranscribe(merged).split('\n').filter((l) => l !== '');
assert.deepEqual(mergedLines, [
  '0:00', 'Malthaiel', 'okay so what you want here is a fight you can leave',
  '0:04', 'Student', 'my builds are awful',
  '0:06', 'Malthaiel', 'same mistake again',
]);
assert.equal(mergedLines.filter((l) => TURN_RE.test(l)).length, 3);

console.log('coachTranscribe selftest OK');

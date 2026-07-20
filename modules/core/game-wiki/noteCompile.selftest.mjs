// noteCompile round-trip check. Usage: node modules/core/game-wiki/noteCompile.selftest.mjs
// The contract formatTimedBullet documents — parseTimedNote(formatTimedBullet(x)) recovers x —
// silently broke past 100 minutes: clock() emits "100:05" and the old \d{1,2} minute bound in
// TIME_PREFIX_RE rejected it, so the stamp vanished on the next edit.
import assert from 'node:assert';
import { parseTimedNote, formatTimedBullet, secFromClock } from './noteCompile.js';

for (const atSec of [0, 462, 3599, 3600, 4045, 6005, 59999]) {
  const bullet = formatTimedBullet({ atSec, classification: 'Blunder', text: 'walked mid alone' });
  const back = parseTimedNote(bullet);
  assert.equal(back.atSec, atSec, `round-trip lost the stamp at ${atSec}s (bullet: ${bullet})`);
  assert.equal(back.classification, 'Blunder');
  assert.equal(back.text, 'walked mid alone');
}

// In-game clock, NOT h:mm:ss — Deadlock's HUD counts straight past 60, so notes must too.
assert.equal(formatTimedBullet({ atSec: 4045, text: 'x' }), '[67:25] x');
assert.equal(secFromClock('100:05'), 6005);
assert.equal(secFromClock('7:42'), 462);
assert.equal(secFromClock('nope'), null);
assert.equal(parseTimedNote('no stamp here').atSec, null);

console.log('noteCompile.selftest: all assertions passed');

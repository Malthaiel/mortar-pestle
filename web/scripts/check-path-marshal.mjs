// Dep-free matrix check of the three path/hash marshalling helpers:
//   • isAbsolutePath  — api.js's absFromInput guard (web/src/util/paths.js)
//   • safeDecode      — router.js's throw-proof single decode (web/src/router.js)
//   • encodePath/decodePath — Library hash-segment codec (modules/core/library/paths.js)
// Run: `npm --prefix web run check-path`.
import assert from 'node:assert/strict';
import { isAbsolutePath } from '../src/util/paths.js';
import { safeDecode } from '../src/router.js';
import { encodePath, decodePath } from '../../modules/core/library/paths.js';

let cases = 0;
const check = (fn, msg) => { assert.ok(fn, msg); cases++; };

// ── isAbsolutePath ────────────────────────────────────────────────────────
const ABSOLUTE = [
  'C:\\Users\\x\\clip.mp4',   // Windows drive-rooted, backslash (the past-bug case)
  'C:/Users/x/clip.mp4',      // Windows drive-rooted, forward slash
  'D:\\a',
  '/home/malthaiel/note.md',  // POSIX
  '\\\\server\\share\\file',  // UNC
];
const RELATIVE = [
  'Pulse/Daily Logs/2026-05-15.md',
  'album/cover.jpg',
  'file.md',
  'a\\b',                     // lone backslash, no drive → relative (not UNC)
  'C:relative.md',            // drive-relative, no separator → current behavior: relative
];
for (const p of ABSOLUTE) { assert.equal(isAbsolutePath(p), true, `absolute: ${p}`); cases++; }
for (const p of RELATIVE) { assert.equal(isAbsolutePath(p), false, `relative: ${p}`); cases++; }

// ── safeDecode ────────────────────────────────────────────────────────────
// Guards the 2026-07-25 double-decode sweep. safeDecode decodes EXACTLY ONCE and
// never throws; a stale deep-link with a bare '%' used to white-screen the app,
// and a second decode pass silently turned a literal '%41' into 'A'.
assert.equal(safeDecode('a%20b'), 'a b',       'decodes a normal escape');            cases++;
assert.equal(safeDecode('100%'), '100%',       'malformed escape falls back to raw'); cases++;
assert.equal(safeDecode('%ZZ'), '%ZZ',         'invalid hex falls back to raw');      cases++;
assert.equal(safeDecode('%2541'), '%41',       'decodes ONCE — not twice');           cases++;
assert.equal(safeDecode('plain/slash'), 'plain/slash', 'passes plain text through');  cases++;

// ── encodePath / decodePath ───────────────────────────────────────────────
// Segment-wise codec: '/' separators must survive the round trip.
for (const p of [
  'Anime/Frieren Beyond Journey\u2019s End/S01.md',
  'Music/Artist & Co/Album #2/track.opus',
  'Plain',
  'spaces in/every segment here',
  '\u65e5\u672c\u8a9e/\u30c8\u30e9\u30c3\u30af',
]) {
  assert.equal(decodePath(encodePath(p)), p, `round-trips: ${p}`);
  cases++;
}
assert.equal(encodePath('a/b c'), 'a/b%20c', "encodePath keeps '/' literal");         cases++;
assert.equal(decodePath('100%'), '100%',     'decodePath survives a malformed tail'); cases++;

// THE OVER-DECODE REGRESSION (fixed 2026-07-25). decodePath used to loop until
// the string stopped changing, so a name holding a literal percent-escape got
// decoded one pass too far and routed to a folder that does not exist:
//   'Track%20Name' → encode 'Track%2520Name' → decode 'Track%20Name' → LOOP → 'Track Name'
// These names must survive the round trip untouched. Re-introducing the loop
// fails here.
for (const p of ['Track%20Name', '100%41 Mix', 'Albums/50%25 Off/a%2Fb']) {
  assert.equal(decodePath(encodePath(p)), p, `literal escape survives: ${p}`);
  cases++;
}
// A malformed segment falls back to its own raw text without stranding the rest.
assert.equal(decodePath('good%20one/100%/last%20one'), 'good one/100%/last one',
  'one bad segment does not abort the path'); cases++;

console.log(`check-path-marshal: ${cases} cases PASS`);

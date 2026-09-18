// Node harness for vodNotes.js — run with:
//   node modules/core/deadlock/vodNotes.selftest.mjs

import assert from 'node:assert/strict';
import {
  newVodScaffold, appendNote, appendAfterNote, setVodVideo, readNotes,
  NOTES_HEADING, AFTER_HEADING,
} from './vodNotes.js';

// ── scaffold ───────────────────────────────────────────────────────────────
const scaffold = newVodScaffold('Lash 09-03-26', new Date(2026, 8, 3));
assert.ok(scaffold.startsWith('---\nType: personal-vod\n'), 'frontmatter first');
assert.ok(scaffold.includes('Created: 2026-09-03'), 'zero-padded ISO date');
assert.ok(scaffold.includes(NOTES_HEADING), 'has the Notes heading');
assert.ok(scaffold.includes('**Lash 09-03-26**'), 'names the match');

// ── the happy path ─────────────────────────────────────────────────────────
let body = scaffold;
body = appendNote(body, 754_000, 'got caught out rotating mid');
body = appendNote(body, 842_000, '  should have taken the second urn  ');
assert.ok(body.includes('- **12:34** — got caught out rotating mid'));
assert.ok(body.includes('- **14:02** — should have taken the second urn'), 'text is trimmed');

// The first bullet must not glue itself to the heading.
assert.ok(body.includes(`${NOTES_HEADING}

- **12:34**`), 'blank line survives under the heading');

const notes = readNotes(body);
assert.equal(notes.length, 2);
assert.deepEqual(notes.map((n) => n.stamp), ['12:34', '14:02'], 'oldest first');

// No blank line may creep between bullets — they must stay one list.
assert.ok(
  /- \*\*12:34\*\* — got caught out rotating mid\n- \*\*14:02\*\*/.test(body),
  'bullets stay contiguous',
);

// ── an empty hold records nothing ──────────────────────────────────────────
assert.equal(appendNote(body, 900_000, '   '), body);
assert.equal(appendNote(body, 900_000, null), body);

// ── a hand-edited file that lost the heading still keeps the note ──────────
const headless = appendNote('some prose the user typed', 61_000, 'kept anyway');
assert.ok(headless.includes(NOTES_HEADING), 'heading is recreated');
assert.ok(headless.includes('- **1:01** — kept anyway'), 'the note is never dropped');
assert.ok(headless.startsWith('some prose the user typed'), 'existing prose survives');

// ── a later section is not swallowed ───────────────────────────────────────
const withTail = `${NOTES_HEADING}\n\n- **1:00** — first\n\n## Review\n\nwatched it back\n`;
const appended = appendNote(withTail, 120_000, 'second');
assert.ok(appended.includes('- **1:00** — first\n- **2:00** — second'), 'appends inside Notes');
assert.ok(appended.includes('## Review\n\nwatched it back'), 'the trailing section survives');
assert.ok(
  appended.indexOf('- **2:00**') < appended.indexOf('## Review'),
  'the new note lands BEFORE the next heading',
);

// ── minutes uncapped, end to end ───────────────────────────────────────────
assert.ok(appendNote(scaffold, 70 * 60_000 + 4_000, 'late game').includes('**70:04**'));

// ── After Notes: untimed, and it never eats the timed list ─────────────────
assert.ok(scaffold.includes(AFTER_HEADING), 'scaffold ships both headings');
assert.ok(scaffold.indexOf(NOTES_HEADING) < scaffold.indexOf(AFTER_HEADING), 'timed list first');

let after = appendAfterNote(body, '  ward mid earlier  ');
after = appendAfterNote(after, 'ask about the third item');
assert.ok(after.includes('- ward mid earlier'), 'trimmed, no stamp');
assert.ok(/- ward mid earlier\n- ask about the third item/.test(after), 'bullets stay contiguous');
assert.equal(readNotes(after).length, 2, 'untimed notes are not counted as timed ones');
assert.equal(appendAfterNote(after, '   '), after, 'an empty box writes nothing');

// A timed note appended afterwards still lands in the TIMED section.
const mixed = appendNote(after, 180_000, 'third');
assert.ok(
  mixed.indexOf('- **3:00** — third') < mixed.indexOf(AFTER_HEADING),
  'a live note never lands in After Notes',
);

// A hand-edited file that lost the heading still keeps the note.
const headlessAfter = appendAfterNote('bare prose', 'kept anyway');
assert.ok(headlessAfter.includes(AFTER_HEADING) && headlessAfter.includes('- kept anyway'));

// ── the clip path rides in the frontmatter ─────────────────────────────────
const withVid = setVodVideo(scaffold, 'C:\\clips\\lash.mp4');
assert.ok(withVid.includes('Video: C:\\clips\\lash.mp4'), 'path is written');
assert.ok(withVid.includes('Type: personal-vod'), 'existing keys survive');
assert.ok(withVid.includes(NOTES_HEADING), 'the body survives');
const reVid = setVodVideo(withVid, 'C:\\clips\\lash-2.mp4');
assert.equal((reVid.match(/^Video:/gm) || []).length, 1, 're-record replaces, never doubles');
assert.ok(reVid.includes('Video: C:\\clips\\lash-2.mp4'));
assert.equal(setVodVideo(scaffold, ''), scaffold, 'no path = no edit');
assert.ok(setVodVideo('bare prose', 'x.mp4').startsWith('---\nVideo: x.mp4\n---'), 'frontmatter created');

console.log('vodNotes selftest: PASS');

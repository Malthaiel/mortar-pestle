// Dep-free matrix check of the asset-URL absolute-path predicate (api.js's
// absFromInput guard, extracted to util/paths.js). Run: `npm --prefix web run check-path`.
import assert from 'node:assert/strict';
import { isAbsolutePath } from '../src/util/paths.js';

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

let cases = 0;
for (const p of ABSOLUTE) { assert.equal(isAbsolutePath(p), true, `absolute: ${p}`); cases++; }
for (const p of RELATIVE) { assert.equal(isAbsolutePath(p), false, `relative: ${p}`); cases++; }

console.log(`check-path-marshal: ${cases} cases PASS`);

# Plan 024: Pure-math node checks for planner time/frame math and the api.js path predicate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md` if that file exists — unless a reviewer dispatched you and
> told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 57a6c80..HEAD -- web/src/util/time.js web/src/util/frames.js web/src/api.js web/package.json scripts/verify.mjs`
> If any in-scope file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition. (`web/scripts/check-planner-time.mjs`,
> `web/scripts/check-path-marshal.mjs`, and `web/src/util/paths.js` are new files
> — they will not exist at 57a6c80.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline-and-ci.md` (creates `scripts/verify.mjs`, the aggregate the two new checks wire into).
- **Category**: tests
- **Planned at**: commit `57a6c80`, 2026-07-03

## Why this matters

The repo's JS test idiom is a **dependency-free node check** — see
`web/scripts/check-drag-math.mjs` (exhaustive `node:assert/strict` over a pure
module, run via `npm run check-drag`). Two more pure surfaces carry *claimed
invariants with no check*:

- `web/src/util/time.js` — `daysDiff`/`addDays` are commented "UTC-based so a DST
  boundary never shifts the count", but nothing verifies it; `parseStoredTo12h`↔
  `combineTo24h` is a 12h/24h round-trip with a `24:00` end-of-day sentinel;
  `minsToHM` wraps hours at 24. And `web/src/util/frames.js` — `validateDay`
  (uniqueness / zero-duration / HH:MM), `makeUniqueId` (`-2`/`-3` suffixing),
  `copyDayToTargets` (per-day independence). **All pure, zero-import — node-
  importable as-is.**
- `web/src/api.js` — the absolute-vs-relative path classifier for asset-URL
  marshalling (`absFromInput`, ~line 79), the **site of a past Windows
  drive-letter bug** (a `C:\…` clip path wrongly joined against the vault root).

This plan adds `check-planner-time.mjs` (time + frames) and `check-path-marshal.mjs`
(the path predicate, extracted into a tiny importable util because `api.js`
imports Tauri and cannot be node-imported), and wires both into the verify
baseline. It deliberately **defers** the `frame_override` YAML round-trip (a
larger 3-function extraction — see Maintenance notes).

## Current state

Facts inlined — the executor has not seen this repo.

### The idiom to mirror (`web/scripts/check-drag-math.mjs`)

```js
import assert from 'node:assert/strict';
import { computeSlotY } from '../src/components/dragMath.js';
// … loops building cases, assert.equal(got, expected, msg) …
console.log(`check-drag-math: ${cases + 1} cases PASS`);
```

Dep-free (`node:assert` + one local module), throws → non-zero exit on failure,
prints a `… cases PASS` line on success. Run today via `npm --prefix web run check-drag`
(`web/package.json` script `"check-drag": "node scripts/check-drag-math.mjs"`).
**Extend this style — do NOT add Jest/Vitest or any dependency.**

### `web/src/util/time.js` — pure, zero imports

The file has **no** `import` statements (confirmed top-of-file). Relevant exports
(verbatim):

```js
// "00:15" -> { display: "12:15", meridiem: "AM", endOfDay: false }
// "24:00" -> { display: "12:00", meridiem: "AM", endOfDay: true  }
export function parseStoredTo12h(stored) { /* … 24:00 → endOfDay:true … */ }

// (display12 string, meridiem) -> "HH:MM" 24h string, or null if input invalid.
export function combineTo24h(display12, meridiem) {
  if (!TIME_RE_12.test(display12)) return null;
  const [hStr, mStr] = display12.split(':');
  let h = parseInt(hStr, 10);
  if (meridiem === 'AM') h = (h === 12 ? 0 : h);
  else                   h = (h === 12 ? 12 : h + 12);
  return `${pad(h)}:${mStr}`;
}

export function fmtHHMMString(timeStr, use24h) { /* "24:00" → "12:00 AM" in 12h */ }

// Calendar-day difference a − b (both "YYYY-MM-DD"). UTC-based so a DST boundary
// never shifts the count.
export function daysDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}
export function addDays(ds, n) { /* Date.UTC-based, returns "YYYY-MM-DD" */ }

// Minutes-from-midnight -> "HH:MM" (hours wrap at 24 for the calendar grid).
export function minsToHM(m) { return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; }
```

Round-trip fact: for every `"HH:MM"` with `h ∈ 0..23`, `parseStoredTo12h` returns
`{ display, meridiem, endOfDay:false }` and `combineTo24h(display, meridiem)`
returns the original `"HH:MM"`. `"24:00"` is the one non-round-tripping sentinel
(`endOfDay:true`, not part of the `h∈0..23` domain).

### `web/src/util/frames.js` — pure, zero imports

Also no `import` statements. Relevant exports (verbatim):

```js
export function slugify(s) { /* lowercase, &→and, strip non-word, spaces→- */ }

export function validateDay(list) {
  // → { [rowIdx]: [msgs] }. 'Name required' / 'Start must be HH:MM (24h)' /
  // 'Zero-duration not allowed' / `Duplicate id "…"`. Clean/empty days → {}.
}

export function copyDayToTargets(frames, srcDay, targetDays) {
  const src = (frames[srcDay] || []);
  const next = { ...frames };
  for (const d of targetDays) next[d] = src.map(b => ({ ...b })); // fresh objects
  return next;
}

export function makeUniqueId(list, name) {
  const base = slugify(name) || 'block';
  const taken = new Set((list || []).map(b => b.id));
  if (!taken.has(base)) return base;
  let n = 2; while (taken.has(`${base}-${n}`)) n++; return `${base}-${n}`;
}
```

### `web/src/api.js` — the path predicate is behind a Tauri import wall

`api.js` imports Tauri at the top (lines 6–7:
`import { listen as tauriListen } from '@tauri-apps/api/event';` /
`import { convertFileSrc } from '@tauri-apps/api/core';`), so **you cannot
`node`-import `api.js`** (the `@tauri-apps/api/*` specifiers don't resolve outside
the bundler / touch `window`). The predicate under test (api.js:74–81):

```js
function absFromInput(p, base) {
  // Already-absolute paths pass through unchanged: POSIX (`/…`), Windows
  // drive-rooted (`C:\…` / `C:/…`), and UNC (`\\server\…`). Only a relative path
  // is joined against the media root.
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) return p;
  return `${base || VAULT_ROOT_FOR_MEDIA}/${p}`;
}
```

To test the **real** predicate (not a drifting copy), extract the boolean into a
tiny pure util `web/src/util/paths.js` and re-wire `absFromInput` to call it.
This matches the file's existing pattern — `api.js` already imports sibling utils
(lines 8–10: `./util/events.js`, `./util/nutritionTotals.js`,
`./util/fitnessLog.js`).

### Wiring targets

- `web/package.json` `scripts` currently: `check-themes`, `check-drag` (+ dev/build).
- `scripts/verify.mjs` (created by plan 002) runs web checks as `steps` entries of
  the form `{ name, cmd: NPM, args: ['--prefix', 'web', 'run', '<script>'] }`.
  Plan 002's Maintenance notes require every new `web/scripts/check-*.mjs` to be
  added there.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Run time/frames check | `node web/scripts/check-planner-time.mjs` | exit 0, prints `check-planner-time: <N> cases PASS` |
| Run path check | `node web/scripts/check-path-marshal.mjs` | exit 0, prints `check-path-marshal: <N> cases PASS` |
| Via npm | `npm --prefix web run check-time` / `npm --prefix web run check-path` | exit 0 |
| Syntax-check the extracted util | `node --check web/src/util/paths.js` | exit 0, no output |
| Confirm api.js still builds | `npm --prefix web run build` | exit 0; `web/dist/` produced |
| Full aggregate | `node scripts/verify.mjs` | exit 0, `✓ verify passed` |

## Scope

**In scope** (the only files you may create/modify):
- `web/scripts/check-planner-time.mjs` — create.
- `web/scripts/check-path-marshal.mjs` — create.
- `web/src/util/paths.js` — create (the extracted `isAbsolutePath`).
- `web/src/api.js` — **minimal** edit: add `import { isAbsolutePath } from './util/paths.js';`
  and replace the inline boolean in `absFromInput` with `isAbsolutePath(p)`. No
  other change.
- `web/package.json` — add two `scripts` entries.
- `scripts/verify.mjs` — add two web-check `steps`.

**Out of scope** (do NOT touch):
- The **logic** of `time.js` / `frames.js` / `api.js` — this plan tests and (for
  the predicate) relocates existing behavior; it does not change it.
- `frame_override` parse/serialize (`parseFrameOverride` / `setFrameOverrideInContent`
  / `stripFrameOverride`, api.js ~570–659) — deferred (see Maintenance notes).
- `web/scripts/check-drag-math.mjs` / `check-theme-contrast.mjs` — reuse as-is.

## Git workflow

- Branch: `advisor/024-pure-math-js-checks` (or the repo's convention from `git branch -a`).
- Commit per logical unit; match the repo's commit style (`git log --oneline -10`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `web/scripts/check-planner-time.mjs` (no production change)

`time.js` and `frames.js` are pure zero-import modules — import them directly.
Create the file:

```js
// Dep-free node check of the planner's pure time + frame math (mirrors the
// check-drag-math.mjs idiom). Run: `npm --prefix web run check-time`.
import assert from 'node:assert/strict';
import {
  parseStoredTo12h, combineTo24h, fmtHHMMString, daysDiff, addDays, minsToHM,
} from '../src/util/time.js';
import { validateDay, makeUniqueId, copyDayToTargets } from '../src/util/frames.js';

const p2 = (n) => String(n).padStart(2, '0');
let cases = 0;

// 1. 12h ↔ 24h round-trip across every wall-clock minute 00:00–23:59.
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m++) {
    const stored = `${p2(h)}:${p2(m)}`;
    const parsed = parseStoredTo12h(stored);
    assert.equal(parsed.endOfDay, false, `${stored} is not end-of-day`);
    const back = combineTo24h(parsed.display, parsed.meridiem);
    assert.equal(back, stored, `roundtrip ${stored} → ${parsed.display} ${parsed.meridiem} → ${back}`);
    cases++;
  }
}
// The 24:00 end-of-day sentinel.
assert.deepEqual(parseStoredTo12h('24:00'), { display: '12:00', meridiem: 'AM', endOfDay: true });
assert.equal(fmtHHMMString('24:00', false), '12:00 AM');
cases += 2;

// 2. daysDiff — UTC-based, DST-immune (the claimed invariant).
assert.equal(daysDiff('2026-03-09', '2026-03-08'), 1, 'spring-forward boundary');   // US DST start
assert.equal(daysDiff('2026-11-02', '2026-11-01'), 1, 'fall-back boundary');        // US DST end
assert.equal(daysDiff('2026-03-08', '2026-03-09'), -1, 'sign flips');
assert.equal(daysDiff('2026-05-01', '2026-05-01'), 0, 'same day');
assert.equal(daysDiff('2026-01-01', '2025-01-01'), 365, 'non-leap year span');
assert.equal(daysDiff('2025-01-01', '2024-01-01'), 366, 'leap year span (2024)');
cases += 6;

// 3. addDays — UTC, rolls over months/years/leap; inverse of daysDiff.
assert.equal(addDays('2026-03-08', 1), '2026-03-09', 'across spring-forward');
assert.equal(addDays('2026-12-31', 1), '2027-01-01', 'year rollover');
assert.equal(addDays('2026-03-01', -1), '2026-02-28', 'month underflow');
assert.equal(addDays('2024-02-28', 1), '2024-02-29', 'leap day');
for (const [ds, n] of [['2026-06-15', 10], ['2026-01-01', -400]]) {
  assert.equal(daysDiff(addDays(ds, n), ds), n, `addDays/daysDiff inverse ${ds}+${n}`);
}
cases += 6;

// 4. minsToHM — hours wrap at 24.
assert.equal(minsToHM(0), '00:00');
assert.equal(minsToHM(90), '01:30');
assert.equal(minsToHM(1439), '23:59');
assert.equal(minsToHM(1440), '00:00', 'wraps at 24h');
assert.equal(minsToHM(1500), '01:00', 'wraps past 24h');
cases += 5;

// 5. validateDay.
assert.equal(Object.keys(validateDay([{ name: 'Wake', start: '07:00', end: '08:00' }])).length, 0, 'clean day');
assert.equal(Object.keys(validateDay([])).length, 0, 'empty day allowed');
{
  const errs = validateDay([{ name: '', start: '25:99', end: '07:00' }]);
  assert.ok(errs[0].includes('Name required'), 'missing name');
  assert.ok(errs[0].some((e) => e.startsWith('Start must be HH:MM')), 'bad start');
}
assert.ok(validateDay([{ name: 'X', start: '09:00', end: '09:00' }])[0].includes('Zero-duration not allowed'), 'zero duration');
{
  const errs = validateDay([
    { name: 'Focus', start: '09:00', end: '10:00' },
    { name: 'Focus', start: '10:00', end: '11:00' }, // same slug → dup id in the day
  ]);
  assert.ok(errs[1].some((e) => e.startsWith('Duplicate id')), 'duplicate id within a day');
}
cases += 6;

// 6. makeUniqueId — slug, then -2/-3 suffixing; empty name → "block".
assert.equal(makeUniqueId([], 'Deep Work'), 'deep-work');
assert.equal(makeUniqueId([{ id: 'deep-work' }], 'Deep Work'), 'deep-work-2');
assert.equal(makeUniqueId([{ id: 'deep-work' }, { id: 'deep-work-2' }], 'Deep Work'), 'deep-work-3');
assert.equal(makeUniqueId([], ''), 'block');
cases += 4;

// 7. copyDayToTargets — targets are independent deep-ish copies.
{
  const frames = { mon: [{ id: 'a', name: 'A', start: '07:00', end: '08:00' }] };
  const next = copyDayToTargets(frames, 'mon', ['tue', 'wed']);
  assert.equal(next.tue[0].name, 'A');
  assert.equal(next.wed[0].name, 'A');
  next.tue[0].name = 'MUTATED';
  assert.equal(next.wed[0].name, 'A', 'wed unaffected by tue mutation');
  assert.equal(frames.mon[0].name, 'A', 'source unaffected');
}
cases += 3;

console.log(`check-planner-time: ${cases} cases PASS`);
```

**Verify**: `node web/scripts/check-planner-time.mjs` → exit 0, prints
`check-planner-time: <N> cases PASS` (N ≈ 1470). If any assert throws, the
`time.js`/`frames.js` behavior differs from the excerpts — see STOP conditions.

### Step 2: Extract `isAbsolutePath` + add `check-path-marshal.mjs`

**2a.** Create `web/src/util/paths.js`:

```js
// Absolute-path predicate for asset-URL marshalling. True when `p` must NOT be
// joined against a media root: POSIX (`/…`), Windows drive-rooted (`C:\…` /
// `C:/…`), or UNC (`\\server\…`). The drive-letter branch is the site of a past
// Windows bug (a `C:\…` clip path wrongly joined against the vault root). Pure +
// node-importable — the testable extraction of api.js's absFromInput guard.
export function isAbsolutePath(p) {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}
```

**2b.** In `web/src/api.js`, add the import near the other `./util/*` imports
(after line 10):

```js
import { isAbsolutePath } from './util/paths.js';
```

and replace the inline boolean in `absFromInput` (line 79) so the body reads:

```js
function absFromInput(p, base) {
  // POSIX / Windows drive-rooted / UNC absolute paths pass through unchanged.
  if (isAbsolutePath(p)) return p;
  return `${base || VAULT_ROOT_FOR_MEDIA}/${p}`;
}
```

Do not change anything else in `api.js`.

**2c.** Create `web/scripts/check-path-marshal.mjs`:

```js
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
```

**Verify**:
- `node --check web/src/util/paths.js` → exit 0.
- `node web/scripts/check-path-marshal.mjs` → exit 0, prints `check-path-marshal: 10 cases PASS`.
- `npm --prefix web run build` → exit 0 (api.js still compiles with the new import).

### Step 3: Wire both checks into `web/package.json` and `scripts/verify.mjs`

**3a.** Add to `web/package.json` `scripts` (keep existing entries):

```json
"check-time": "node scripts/check-planner-time.mjs",
"check-path": "node scripts/check-path-marshal.mjs"
```

**3b.** In `scripts/verify.mjs`, add two entries to the `steps` array, next to the
existing `check-themes` / `check-drag` steps (use the same `NPM`/`--prefix web`
shape already in the file):

```js
  { name: 'web: planner time/frame math', cmd: NPM, args: ['--prefix', 'web', 'run', 'check-time'] },
  { name: 'web: path marshalling',        cmd: NPM, args: ['--prefix', 'web', 'run', 'check-path'] },
```

**Verify**:
- `npm --prefix web run check-time` → exit 0; `npm --prefix web run check-path` → exit 0.
- `node scripts/verify.mjs` → exit 0, `✓ verify passed`, output shows both new
  web-check steps passing.

## Test plan

- New `web/scripts/check-planner-time.mjs`: ~1470 assertions — the exhaustive 12h↔24h
  round-trip + `24:00` sentinel, DST-boundary `daysDiff`/`addDays` (the claimed
  UTC invariant), `minsToHM` wrap-at-24, `validateDay` (name/time/zero-duration/
  duplicate-id), `makeUniqueId` suffixing, `copyDayToTargets` independence.
- New `web/scripts/check-path-marshal.mjs`: 10-case matrix over the extracted
  `isAbsolutePath` (Windows `C:\`/`C:/`, UNC, POSIX, and relative incl. the
  drive-relative + lone-backslash edges).
- Structural pattern mirrored: `web/scripts/check-drag-math.mjs`.
- Verification: both scripts exit 0; `node scripts/verify.mjs` → `✓ verify passed`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node web/scripts/check-planner-time.mjs` exits 0 and prints `check-planner-time: … cases PASS`.
- [ ] `node web/scripts/check-path-marshal.mjs` exits 0 and prints `check-path-marshal: 10 cases PASS`.
- [ ] `web/src/util/paths.js` exists and exports `isAbsolutePath`; `node --check web/src/util/paths.js` → exit 0.
- [ ] `web/src/api.js` imports `isAbsolutePath` and `absFromInput` calls it (`grep -n "isAbsolutePath" web/src/api.js` → 2 matches); `npm --prefix web run build` → exit 0.
- [ ] `web/package.json` has `check-time` and `check-path` scripts.
- [ ] `scripts/verify.mjs` runs both new checks; `node scripts/verify.mjs` exits 0.
- [ ] No files outside the in-scope list modified (`git status`).
- [ ] `plans/README.md` status row updated (only if that index exists).

## STOP conditions

Stop and report back (do not improvise) if:

- An assertion in `check-planner-time.mjs` fails — the `time.js`/`frames.js`
  behavior differs from the "Current state" excerpts (drift, or a real bug). Do
  NOT edit `time.js`/`frames.js` to make it pass (out of scope) and do NOT weaken
  the assertion; report the observed vs expected value.
- `web/src/util/time.js` or `web/src/util/frames.js` turns out to contain an
  `import` of a Tauri/DOM module (so it can't be node-imported) — this contradicts
  the recon; report it rather than stubbing the import.
- `npm --prefix web run build` fails after the `api.js` edit — the extraction
  broke a consumer or the import path is wrong; report the build error (do not
  leave `api.js` half-edited).
- `scripts/verify.mjs` does not exist yet — plan 002 has not run. Complete Steps
  1–2 and the package.json half of Step 3, verify the two checks standalone, and
  report that the `verify.mjs` wiring is blocked on plan 002.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this after it lands:

- **Deferred: the `frame_override` YAML round-trip.** `parseFrameOverride` /
  `setFrameOverrideInContent` / `stripFrameOverride` (api.js ~570–659) are pure
  string transforms but live behind the same Tauri-import wall, and testing them
  means extracting **three** functions (~90 lines) into a new
  `web/src/util/frameOverride.js` and re-wiring every `api.js` consumer —
  larger + riskier than the one-line `isAbsolutePath` move, so it is out of this
  S-effort plan. Follow-up: extract them, add `web/scripts/check-frame-override.mjs`
  asserting `parseFrameOverride(setFrameOverrideInContent(content, map))` recovers
  `map` for both the `{ start, end }` and `{ deleted: true }` forms (and the
  empty-map removal path), and wire it into `verify.mjs`.
- **Every new pure check must join `verify.mjs`** (plan 002's rule) — a check that
  nothing runs is dead.
- **What a reviewer should scrutinize**: that the `api.js` diff is exactly the
  import + the `isAbsolutePath(p)` swap (behavior-preserving), and that
  `check-path-marshal.mjs` encodes *current* behavior for the `C:relative.md` /
  `a\\b` edges (they classify as relative today; if that is ever deemed a bug, the
  fix updates both the predicate and this expectation together).

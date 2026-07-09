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

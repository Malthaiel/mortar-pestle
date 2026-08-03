// Dep-free node check of the availability-push busy math (mirrors the
// check-planner-time.mjs idiom). Run: `npm --prefix web run check-busy`.
import assert from 'node:assert/strict';
import { computeBusyRanges, OPEN_EVENT_MINS } from '../src/util/busyRanges.js';

let cases = 0;

// Local wall-clock "YYYY-MM-DDTHH:MM" → the ISO string computeBusyRanges emits.
const iso = (ds, hhmm) => {
  const [y, mo, d] = ds.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(y, mo - 1, d, h, m).toISOString();
};
const seg = (start, end) => ({ start, end });
const ev = (o) => ({ title: 'x', start: null, end: null, time12: null, ...o });

// 1. Empty in, empty out.
assert.deepEqual(computeBusyRanges({}), []);
assert.deepEqual(computeBusyRanges({ perDay: { '2026-08-03': [] }, upcoming: [] }), []);
cases += 2;

// 2. A single frame segment converts to one absolute range.
{
  const r = computeBusyRanges({ perDay: { '2026-08-03': [seg('09:00', '17:00')] } });
  assert.deepEqual(r, [{ start_ts: iso('2026-08-03', '09:00'), end_ts: iso('2026-08-03', '17:00') }]);
  cases++;
}

// 3. The '24:00' end-of-day sentinel lands on the next local midnight, not 00:00 same day.
{
  const r = computeBusyRanges({ perDay: { '2026-08-03': [seg('22:00', '24:00')] } });
  assert.equal(r.length, 1);
  assert.equal(r[0].end_ts, iso('2026-08-04', '00:00'));
  cases++;
}

// 4. Overlapping AND touching ranges merge; disjoint ones do not.
{
  const r = computeBusyRanges({
    perDay: { '2026-08-03': [seg('09:00', '11:00'), seg('10:00', '12:00'), seg('12:00', '13:00'), seg('15:00', '16:00')] },
  });
  assert.deepEqual(r, [
    { start_ts: iso('2026-08-03', '09:00'), end_ts: iso('2026-08-03', '13:00') },
    { start_ts: iso('2026-08-03', '15:00'), end_ts: iso('2026-08-03', '16:00') },
  ]);
  cases++;
}

// 5. A frame and an event on the same day merge into one span.
{
  const r = computeBusyRanges({
    perDay: { '2026-08-03': [seg('09:00', '12:00')] },
    upcoming: [{ ds: '2026-08-03', events: [ev({ start: '11:30', end: '13:00' })] }],
  });
  assert.deepEqual(r, [{ start_ts: iso('2026-08-03', '09:00'), end_ts: iso('2026-08-03', '13:00') }]);
  cases++;
}

// 6. An event with no end blocks OPEN_EVENT_MINS.
{
  const r = computeBusyRanges({ upcoming: [{ ds: '2026-08-03', events: [ev({ start: '14:00' })] }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].start_ts, iso('2026-08-03', '14:00'));
  assert.equal(r[0].end_ts, iso('2026-08-03', `${14 + OPEN_EVENT_MINS / 60}:00`));
  cases++;
}

// 7. An event whose end is before its start (crosses midnight) blocks to end of day
//    rather than being dropped or inverted.
{
  const r = computeBusyRanges({ upcoming: [{ ds: '2026-08-03', events: [ev({ start: '23:00', end: '01:00' })] }] });
  assert.deepEqual(r, [{ start_ts: iso('2026-08-03', '23:00'), end_ts: iso('2026-08-04', '00:00') }]);
  cases++;
}

// 8. All-day events block the whole local day.
{
  const r = computeBusyRanges({ upcoming: [{ ds: '2026-08-03', events: [ev({ time12: 'All day' })] }] });
  assert.deepEqual(r, [{ start_ts: iso('2026-08-03', '00:00'), end_ts: iso('2026-08-04', '00:00') }]);
  cases++;
}

// 9. Junk is skipped, never emitted as a bad range: titleless bullets, unparseable
//    times, zero-length segments, and bad date keys.
{
  const r = computeBusyRanges({
    perDay: { '2026-08-03': [seg('10:00', '10:00'), seg('bad', '11:00')], 'not-a-date': [seg('09:00', '10:00')] },
    upcoming: [{ ds: '2026-08-03', events: [ev({ title: '', start: '09:00', end: '10:00' }), ev({ start: 'nope' })] }],
  });
  assert.deepEqual(r, []);
  cases++;
}

// 10. Output is sorted by start and never overlaps — the invariant the site's slot
//     generator relies on.
{
  const r = computeBusyRanges({
    perDay: {
      '2026-08-05': [seg('09:00', '10:00')],
      '2026-08-03': [seg('13:00', '14:00'), seg('09:00', '10:00')],
      '2026-08-04': [seg('23:00', '24:00')],
    },
    upcoming: [{ ds: '2026-08-04', events: [ev({ start: '00:00', end: '02:00' })] }],
  });
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i - 1].start_ts < r[i].start_ts, 'sorted by start');
    assert.ok(r[i - 1].end_ts <= r[i].start_ts, 'no overlap');
  }
  assert.equal(r.length, 5);
  cases++;
}

// 11. No output range ever carries a label — the whole point of the table.
{
  const r = computeBusyRanges({
    perDay: { '2026-08-03': [{ start: '09:00', end: '10:00', task: 'Deep work', meta: { frameId: 'a' } }] },
    upcoming: [{ ds: '2026-08-03', events: [ev({ title: 'Dentist', start: '15:00', end: '16:00', note: 'bring card' })] }],
  });
  for (const range of r) {
    assert.deepEqual(Object.keys(range).sort(), ['end_ts', 'start_ts'], 'times only, no leaked label');
  }
  cases++;
}

console.log(`✓ busy-range math: ${cases} checks passed`);

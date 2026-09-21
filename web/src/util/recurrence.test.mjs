// node --test web/src/util/recurrence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occursOn, describeRule } from './recurrence.js';

const on = (item, ds) => occursOn(item, ds);

test('no rule never occurs — weekday items stay on the weekday path', () => {
  assert.equal(on({ id: 'x', name: 'X' }, '2026-09-20'), false);
});

test('from gates the start', () => {
  const r = { freq: 'daily', from: '2026-09-20' };
  assert.equal(on(r, '2026-09-19'), false);
  assert.equal(on(r, '2026-09-20'), true);
});

test('daily every 3 days lands on the anchor rhythm', () => {
  const r = { freq: 'daily', interval: 3, from: '2026-09-20' };
  assert.deepEqual(
    ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'].map(d => on(r, d)),
    [true, false, false, true],
  );
});

test('weekly fires only on its weekday', () => {
  const r = { freq: 'weekly', weekday: 'sun', from: '2026-09-20' };
  assert.equal(on(r, '2026-09-20'), true);   // Sunday
  assert.equal(on(r, '2026-09-21'), false);  // Monday
  assert.equal(on(r, '2026-09-27'), true);   // next Sunday
});

test('every 2 weeks skips the odd week', () => {
  const r = { freq: 'weekly', interval: 2, weekday: 'sun', from: '2026-09-20' };
  assert.deepEqual(
    ['2026-09-20', '2026-09-27', '2026-10-04'].map(d => on(r, d)),
    [true, false, true],
  );
});

test('monthly by date, and the 31st clamps in a short month', () => {
  const r = { freq: 'monthly', monthday: 31, from: '2026-01-31' };
  assert.equal(on(r, '2026-01-31'), true);
  assert.equal(on(r, '2026-02-28'), true);   // clamped, not skipped
  assert.equal(on(r, '2026-02-27'), false);
  assert.equal(on(r, '2026-04-30'), true);
});

test('monthly on the 3rd Friday, and on the last Friday', () => {
  const third = { freq: 'monthlyNth', weekday: 'fri', nth: 3 };
  assert.equal(on(third, '2026-09-18'), true);
  assert.equal(on(third, '2026-09-25'), false);

  const last = { freq: 'monthlyNth', weekday: 'fri', nth: -1 };
  assert.equal(on(last, '2026-09-25'), true);
  assert.equal(on(last, '2026-09-18'), false);
});

test('yearly matches month and day only', () => {
  const r = { freq: 'yearly', month: 9, monthday: 20, from: '2026-09-20' };
  assert.equal(on(r, '2026-09-20'), true);
  assert.equal(on(r, '2027-09-20'), true);
  assert.equal(on(r, '2027-09-21'), false);
});

test('every 2 years skips the odd year', () => {
  const r = { freq: 'yearly', interval: 2, month: 9, monthday: 20, from: '2026-09-20' };
  assert.deepEqual(
    ['2026-09-20', '2027-09-20', '2028-09-20'].map(d => on(r, d)),
    [true, false, true],
  );
});

test('leap day clamps to the 28th in a common year', () => {
  const r = { freq: 'yearly', month: 2, monthday: 29, from: '2024-02-29' };
  assert.equal(on(r, '2024-02-29'), true);
  assert.equal(on(r, '2026-02-28'), true);
});

test('labels read as sentences', () => {
  assert.equal(describeRule({}), 'Does not repeat');
  assert.equal(describeRule({ freq: 'daily' }), 'Daily');
  assert.equal(describeRule({ freq: 'weekly', weekday: 'tue' }), 'Weekly on Tuesday');
  assert.equal(describeRule({ freq: 'weekly', interval: 2, weekday: 'tue' }), 'Every 2 weeks on Tuesday');
  assert.equal(describeRule({ freq: 'monthly', monthday: 3 }), 'Monthly on the 3rd');
  assert.equal(describeRule({ freq: 'monthlyNth', nth: -1, weekday: 'fri' }), 'Monthly on the last Friday');
  assert.equal(describeRule({ freq: 'yearly', month: 9, monthday: 20 }), 'Yearly on September 20');
});

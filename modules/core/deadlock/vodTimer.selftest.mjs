// Node harness for vodTimer.js — run with:
//   node modules/core/deadlock/vodTimer.selftest.mjs
//
// The point of the anchor design is that elapsed survives a webview reload, so
// the reload case is tested by throwing the module's in-memory nothing away and
// re-reading the SAME store, exactly as a Shift+C reload does.

import assert from 'node:assert/strict';

// Map-backed localStorage stub, installed BEFORE the module is imported so its
// `store()` sees it.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
};

const { start, anchor, end, elapsedMs, fmt, isArmed, read } = await import('./vodTimer.js');

// Deterministic clock. A REAL epoch value, not a small counter: the module
// refuses a stamp from before 2020 (the engine reports 0 while idle), so a toy
// clock would see every anchor rejected.
let now = 1_800_000_000_000;
const realNow = Date.now;
Date.now = () => now;

try {
  // ── fmt: minutes uncapped ────────────────────────────────────────────────
  assert.equal(fmt(0), '0:00');
  assert.equal(fmt(9_000), '0:09');
  assert.equal(fmt(754_000), '12:34');
  assert.equal(fmt(70 * 60_000 + 4_000), '70:04', 'minutes must not wrap at 60');
  assert.equal(fmt(-5), '0:00');

  // ── idle ────────────────────────────────────────────────────────────────
  assert.equal(isArmed(), false);
  assert.equal(elapsedMs(), 0);
  start('', now); // no target = no-op
  assert.equal(isArmed(), false);

  // ── start anchors on the RECORDER's instant, not on now ──────────────────
  const TARGET = 'Coaching/Personal VODs/Lash 09-03-26';
  start(TARGET, now - 5_000); // engine says it began 5 s ago
  assert.equal(isArmed(), true);
  assert.equal(read().target, TARGET);
  assert.equal(elapsedMs(), 5_000, 'elapsed counts from the engine start, not the arm');
  now += 30_000;
  assert.equal(elapsedMs(), 35_000);

  // A second start must NOT wipe the match (stray F6 in-game).
  start('Coaching/Personal VODs/Something Else', now);
  assert.equal(read().target, TARGET, 'a second start must not re-target');
  assert.equal(elapsedMs(), 35_000, 'a second start must not reset the clock');

  // ── reload survival: the store is the only state ─────────────────────────
  const fresh = await import(`./vodTimer.js?reload=${now}`);
  now += 5_000;
  assert.equal(fresh.elapsedMs(), 40_000, 'elapsed must survive a webview reload');
  assert.equal(fresh.read().target, TARGET);

  // ── a missing engine stamp degrades to now rather than to NaN ────────────
  end();
  start(TARGET); // no startedMs
  assert.equal(elapsedMs(), 0);
  now += 3_000;
  assert.equal(elapsedMs(), 3_000);

  // The engine reports 0 while idle and for a beat after start_clip (state
  // `starting`) — anchoring on it would read 57 years, so both the arm and the
  // re-anchor must refuse it.
  end();
  start(TARGET, 0);
  assert.equal(elapsedMs(), 0, 'a zero stamp must not anchor at the epoch');
  anchor(0);
  assert.equal(elapsedMs(), 0, 'a zero re-anchor is ignored');
  const trueStart = now - 12_000;
  anchor(trueStart);
  assert.equal(elapsedMs(), 12_000, 'the real stamp lands when it arrives');
  anchor(trueStart);
  assert.equal(elapsedMs(), 12_000, 're-anchoring on the same stamp is a no-op');

  // An anchor with nothing armed changes nothing.
  end();
  anchor(now - 9_000);
  assert.equal(isArmed(), false);
  assert.equal(elapsedMs(), 0);

  // ── a corrupt blob degrades to idle rather than throwing ─────────────────
  mem.set('vod-timer', '{not json');
  assert.equal(isArmed(), false);
  assert.equal(elapsedMs(), 0);

  // ── end disarms ─────────────────────────────────────────────────────────
  start(TARGET, now);
  now += 1_000;
  end();
  assert.equal(isArmed(), false);
  assert.equal(elapsedMs(), 0);
  assert.equal(read().target, null);

  console.log('vodTimer selftest: PASS');
} finally {
  Date.now = realNow;
}

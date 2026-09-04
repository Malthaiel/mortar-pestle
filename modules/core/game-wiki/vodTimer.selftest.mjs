// Node harness for vodTimer.js — run with:
//   node modules/core/game-wiki/vodTimer.selftest.mjs
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

const { start, pauseResume, end, elapsedMs, fmt, isArmed, read } = await import('./vodTimer.js');

// Deterministic clock.
let now = 1_000_000;
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
  start(''); // no target = no-op
  assert.equal(isArmed(), false);

  // ── start + run ─────────────────────────────────────────────────────────
  const TARGET = 'Deadlock/Coaching/Personal VODs/Lash 09-03-26';
  start(TARGET);
  assert.equal(isArmed(), true);
  assert.equal(read().target, TARGET);
  now += 30_000;
  assert.equal(elapsedMs(), 30_000);

  // A second start must NOT wipe the match (stray F6 in-game).
  start('Deadlock/Coaching/Personal VODs/Something Else');
  assert.equal(read().target, TARGET, 'a second start must not re-target');
  assert.equal(elapsedMs(), 30_000, 'a second start must not reset the clock');

  // ── pause banks, and time passing while paused is NOT counted ────────────
  pauseResume();
  assert.equal(read().running, false);
  now += 60_000;
  assert.equal(elapsedMs(), 30_000, 'paused time must not accrue');

  // ── resume keeps the banked time ────────────────────────────────────────
  pauseResume();
  assert.equal(read().running, true);
  now += 10_000;
  assert.equal(elapsedMs(), 40_000);

  // ── reload survival: the store is the only state ─────────────────────────
  const fresh = await import(`./vodTimer.js?reload=${Date.now()}`);
  now += 5_000;
  assert.equal(fresh.elapsedMs(), 45_000, 'elapsed must survive a webview reload');
  assert.equal(fresh.read().target, TARGET);

  // ── a corrupt blob degrades to idle rather than throwing ─────────────────
  mem.set('vod-timer', '{not json');
  assert.equal(isArmed(), false);
  assert.equal(elapsedMs(), 0);

  // ── end disarms ─────────────────────────────────────────────────────────
  start(TARGET);
  now += 1_000;
  end();
  assert.equal(isArmed(), false);
  assert.equal(elapsedMs(), 0);
  assert.equal(read().target, null);

  console.log('vodTimer selftest: PASS');
} finally {
  Date.now = realNow;
}

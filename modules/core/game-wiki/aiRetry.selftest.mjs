// node modules/core/game-wiki/aiRetry.selftest.mjs
// The rule under test: parse failure buys ONE reprompt; a transport failure buys none.
import assert from 'node:assert/strict';
import { parseOrRetry } from './aiRetry.js';

const json = (raw) => JSON.parse(raw);

// clean first response → one call, no reprompt
let calls = [];
const ok = await parseOrRetry(async (p) => { calls.push(p); return '{"a":1}'; }, 'U', json, 'HINT');
assert.deepEqual(ok, { a: 1 });
assert.equal(calls.length, 1);

// unparseable first response → exactly one reprompt, carrying the hint
calls = [];
const retried = await parseOrRetry(async (p) => { calls.push(p); return calls.length === 1 ? 'garbage' : '{"a":2}'; }, 'U', json, 'HINT');
assert.deepEqual(retried, { a: 2 });
assert.equal(calls.length, 2);
assert.ok(calls[1].startsWith('U\n\nYour previous response failed to parse'));
assert.ok(calls[1].endsWith('HINT'));

// unparseable twice → throws, and does NOT call a third time
calls = [];
await assert.rejects(parseOrRetry(async (p) => { calls.push(p); return 'garbage'; }, 'U', json, 'HINT'));
assert.equal(calls.length, 2);

// THE REGRESSION: a transport failure (CLI timeout kill) must NOT be reprompted.
// The old code retried it, resending an even longer prompt into the same wall — double-billed,
// double-killed, nothing saved.
calls = [];
await assert.rejects(
  parseOrRetry(async (p) => { calls.push(p); throw new Error('claude timed out after 1200s (killed)'); }, 'U', json, 'HINT'),
  /timed out/,
);
assert.equal(calls.length, 1, 'transport failure must not be retried');

// a transport failure on the RETRY leg also stops there (no third call)
calls = [];
await assert.rejects(parseOrRetry(async (p) => {
  calls.push(p);
  if (calls.length === 1) return 'garbage';
  throw new Error('claude timed out after 1200s (killed)');
}, 'U', json, 'HINT'), /timed out/);
assert.equal(calls.length, 2);

// onRaw sees every raw emission BEFORE parsing, so a double parse failure is still recoverable
const seen = [];
await assert.rejects(parseOrRetry(async () => 'garbage', 'U', json, 'HINT', (r) => seen.push(r)));
assert.deepEqual(seen, ['garbage', 'garbage']);

// onRaw is best-effort: a failed save never breaks the run
const survived = await parseOrRetry(async () => '{"a":3}', 'U', json, 'HINT', () => { throw new Error('disk full'); });
assert.deepEqual(survived, { a: 3 });

console.log('aiRetry.selftest: all assertions passed');

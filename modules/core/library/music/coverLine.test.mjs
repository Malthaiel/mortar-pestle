// node --test modules/core/library/music/coverLine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askCover } from './coverLine.js';

test('covers share a trip, cap at 6 in flight, and a left ask is never sent', async () => {
  const sent = [];
  const finish = {};
  const send = a => new Promise(r => { sent.push(a.mbid); finish[a.mbid] = r; });
  const ask = (mbid, signal) => askCover(send, { kind: 'release-group', mbid, size: 250, image: null }, signal);
  const tick = () => new Promise(r => setTimeout(r));

  const first = ask('a');
  ['b', 'c', 'd', 'e', 'f'].forEach(m => ask(m));
  const repeat = ask('a'); // same cover: rides the same trip
  const leave = new AbortController();
  const left = ask('g', leave.signal);
  ask('h');
  assert.deepEqual(sent, ['a', 'b', 'c', 'd', 'e', 'f']);

  leave.abort();
  await assert.rejects(left, { name: 'AbortError' });
  finish.a('/covers/a.jpg');
  assert.equal(await first, '/covers/a.jpg');
  assert.equal(await repeat, '/covers/a.jpg');
  await tick();
  assert.deepEqual(sent, ['a', 'b', 'c', 'd', 'e', 'f', 'h']); // g skipped, h took a's slot
});

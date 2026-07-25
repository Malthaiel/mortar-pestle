// Selftest for composeStreamUrl (SP5 SF4). Guards the two things that fail
// SILENTLY in the muxer: the per-protocol key names and the SRT ms->us scale.
import assert from 'node:assert/strict';
import { composeStreamUrl } from './streamUrl.js';

const BASE = 'srt://127.0.0.1:8890?streamid=publish:gate';

// No address yet -> nothing to hand the engine.
assert.equal(composeStreamUrl('SRT', '', 200, 'pw'), '');
assert.equal(composeStreamUrl('SRT', '   ', 200, 'pw'), '');

// Bare address survives untouched when nothing is tuned.
assert.equal(composeStreamUrl('SRT', BASE, '', ''), BASE);
assert.equal(composeStreamUrl('RIST', 'rist://127.0.0.1:5000', '', ''), 'rist://127.0.0.1:5000');

// SRT latency is MICROseconds: 200 ms typed must leave as 200000.
assert.equal(composeStreamUrl('SRT', BASE, 200, ''), `${BASE}&latency=200000`);
// RIST buffer_size is MILLIseconds: 200 ms typed stays 200.
assert.equal(composeStreamUrl('RIST', 'rist://h:5000', 200, ''), 'rist://h:5000?buffer_size=200');

// Separator picks itself off the base.
assert.ok(composeStreamUrl('SRT', 'srt://h:9000', 100, '').startsWith('srt://h:9000?latency='));

// Passwords: different key per protocol, and RIST needs `encryption` or the
// secret does nothing at all.
assert.equal(composeStreamUrl('SRT', 'srt://h:9000', '', 'hunter2'), 'srt://h:9000?passphrase=hunter2');
assert.equal(
  composeStreamUrl('RIST', 'rist://h:5000', '', 'hunter2'),
  'rist://h:5000?secret=hunter2&encryption=128',
);

// Reserved characters must not break the query.
assert.equal(
  composeStreamUrl('SRT', 'srt://h:9000', '', 'a&b=c d'),
  'srt://h:9000?passphrase=a%26b%3Dc%20d',
);

// Junk / zero / negative delays are dropped rather than emitted as garbage.
for (const bad of ['', '   ', 'abc', 0, -5, null, undefined]) {
  assert.equal(composeStreamUrl('SRT', 'srt://h:9000', bad, ''), 'srt://h:9000', `delay ${bad}`);
}

// Both tunables together, in order.
assert.equal(
  composeStreamUrl('SRT', BASE, 300, 'pw'),
  `${BASE}&latency=300000&passphrase=pw`,
);

console.log('streamUrl.selftest: all assertions passed');

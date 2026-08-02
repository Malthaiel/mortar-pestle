// Runnable check for coachRecord.js (no framework): `node coachRecord.selftest.mjs`.
// The op ORDER is the contract — `set_output_settings` is refused by the engine once a
// recording is live, and `start_record` snapshots the track masks, so anything that
// runs after it silently does nothing.
import assert from 'node:assert/strict';
import { TRACKS, pickScene, pickWindowValue, findSourceByType, startCoachingRecord } from './coachRecord.js';

const SCENES = [
  { name: 'Main', sources: [{ id: 'monitor_capture', name: 'Display' }] },
  { name: 'Scrim \u2013 Game', sources: [{ id: 'game_capture', name: 'Game' }] },
];

// ── scene pick ───────────────────────────────────────────────────────────────
// The real collection's name carries an en dash; matching must not depend on it.
assert.equal(pickScene({ scenes: SCENES }), 'Scrim \u2013 Game');
assert.equal(pickScene({ scenes: [SCENES[0]], current_scene: 'Main' }), 'Main');
assert.equal(pickScene(null), null);

// ── window pick ──────────────────────────────────────────────────────────────
const PROPS = [
  { name: 'priority', items: [] },
  {
    name: 'window',
    items: [
      { name: 'Deadlock', value: 'Deadlock:UnrealWindow:deadlock.exe' },
      { name: 'Discord', value: '#general - Discord:Chrome_WidgetWin_1:Discord.exe' },
    ],
  },
];
assert.equal(pickWindowValue(PROPS), '#general - Discord:Chrome_WidgetWin_1:Discord.exe');
assert.equal(pickWindowValue([PROPS[0]]), null);
assert.equal(pickWindowValue(null), null);
// A window merely NAMED Discord is not Discord — only the exe tail counts.
assert.equal(pickWindowValue([{ name: 'window', items: [{ name: 'Discord', value: 'Discord - Chrome:x:chrome.exe' }] }]), null);

// ── source lookup, including inside a group ──────────────────────────────────
assert.equal(findSourceByType({ scenes: SCENES }, 'wasapi_process_output_capture'), null);
assert.deepEqual(
  findSourceByType({
    scenes: [{ name: 'Main', sources: [{ id: 'group', name: 'Audio', is_group: true, children: [{ id: 'wasapi_process_output_capture', name: 'Discord' }] }] }],
  }, 'wasapi_process_output_capture'),
  { scene: 'Main', name: 'Discord' },
);

// ── the full start, first time (no Discord catcher yet) ──────────────────────
function recorder(replies = {}) {
  const calls = [];
  const request = async (op, args) => {
    calls.push([op, args]);
    if (op === 'create_source') return { item: 7, name: 'Discord' };
    if (op === 'get_properties') return { props: PROPS };
    if (op === 'start_record') return { path: 'C:\\Videos\\Mortar & Pestle\\Scrim 1 Match 4.mp4' };
    return replies[op] ?? {};
  };
  return { calls, request };
}

const first = recorder();
const path = await startCoachingRecord(first.request, { snapshot: { scenes: SCENES }, stem: 'Scrim 1 Match 4' });
assert.equal(path, 'C:\\Videos\\Mortar & Pestle\\Scrim 1 Match 4.mp4');
assert.deepEqual(first.calls.map(([op]) => op), [
  'set_current_scene', 'create_source', 'get_properties', 'set_source_settings',
  'set_tracks', 'set_tracks', 'set_tracks', 'set_output_settings', 'start_record',
]);

// The pinned layout, verified as bit masks — mic 1, desktop 2, comms 4 (track 3).
const masks = first.calls.filter(([op]) => op === 'set_tracks').map(([, a]) => [a.source, a.mask]);
assert.deepEqual(masks, [['Mic/Aux', 1], ['Desktop Audio', 2], ['Discord', 4]]);
// All three tracks enabled in the recording itself, or two of them never reach disk.
const patch = first.calls.find(([op]) => op === 'set_output_settings')[1];
assert.equal(patch.patch.SimpleOutput.RecTracks, '7');
assert.equal(TRACKS.mic, 1);
assert.equal(TRACKS.comms, 3);

// ── second time: the catcher is already in the recorded scene, nothing is made ─
const again = recorder();
await startCoachingRecord(again.request, {
  snapshot: {
    scenes: [SCENES[0], { name: 'Scrim – Game', sources: [...SCENES[1].sources, { id: 'wasapi_process_output_capture', name: 'Discord' }] }],
  },
  stem: 'Scrim 1 Match 5',
});
assert.equal(again.calls.filter(([op]) => op === 'create_source').length, 0);
assert.equal(again.calls.filter(([op]) => op === 'add_existing').length, 0);
assert.equal(again.calls.filter(([op]) => op === 'set_tracks').length, 3);

// ── the catcher exists but sits in ANOTHER scene ─────────────────────────────
// A source only sounds while its own scene is showing, so it must be pulled into the
// scene being recorded — otherwise track 3 records an hour of silence.
const strayed = recorder();
await startCoachingRecord(strayed.request, {
  snapshot: { scenes: [{ name: 'Main', sources: [{ id: 'wasapi_process_output_capture', name: 'Discord' }] }, SCENES[1]] },
  stem: 'Scrim 1 Match 6',
});
assert.equal(strayed.calls.filter(([op]) => op === 'create_source').length, 0);
assert.deepEqual(
  strayed.calls.find(([op]) => op === 'add_existing')[1],
  { scene: 'Scrim – Game', source_name: 'Discord' },
);

// ── Discord not running: no recording starts, and no half-aimed source is left ─
const closed = { calls: [], request: null };
closed.request = async (op, args) => {
  closed.calls.push([op, args]);
  if (op === 'create_source') return { item: 7, name: 'Discord' };
  if (op === 'get_properties') return { props: [{ name: 'window', items: [] }] };
  return {};
};
await assert.rejects(
  () => startCoachingRecord(closed.request, { snapshot: { scenes: SCENES }, stem: 'x' }),
  /Discord does not look like it is running/,
);
assert.deepEqual(closed.calls.map(([op]) => op), ['set_current_scene', 'create_source', 'get_properties', 'remove_source']);

console.log('coachRecord.selftest.mjs OK');

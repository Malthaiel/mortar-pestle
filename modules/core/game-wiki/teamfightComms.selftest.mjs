// teamfightComms.selftest.mjs — Node harness for the pure Teamfight Comms Review logic
// (sub-plan 13). Run: `node teamfightComms.selftest.mjs`. No framework — assert + a demo run.
// Covers moment clustering, comms windowing (offset), jumble scoring, verdict parse/merge, summarize.

import assert from 'node:assert/strict';
import {
  detectMoments, momentComms, jumbleScore, buildFights,
  parseVerdicts, coerceVerdicts, summarize, buildTeamfightPrompt,
} from './teamfightComms.js';

// ── detectMoments: clusters >= 2 deaths within the window, drops isolated picks ──
{
  const deaths = [
    { team: 0, hero: 'Haze', t: 100 },     // fight A
    { team: 1, hero: 'Seven', t: 108 },    // fight A (within 15s)
    { team: 0, hero: 'Vindicta', t: 112 }, // fight A
    { team: 1, hero: 'Abrams', t: 400 },   // isolated pick — dropped (only 1)
    { team: 0, hero: 'Ivy', t: 600 },      // fight B
    { team: 0, hero: 'Kelvin', t: 605 },   // fight B
  ];
  const m = detectMoments(deaths, { windowS: 15, minDeaths: 2, padS: 4 });
  assert.equal(m.length, 2, 'two teamfights (isolated pick dropped)');
  assert.equal(m[0].tStart, 96, 'fight A padded start (100 - 4)');
  assert.equal(m[0].tEnd, 116, 'fight A padded end (112 + 4)');
  assert.equal(m[0].deaths.length, 3, 'fight A has 3 deaths');
  assert.equal(m[1].deaths.length, 2, 'fight B has 2 deaths');
}

// tStart never negative
assert.equal(detectMoments([{ team: 0, hero: 'X', t: 1 }, { team: 0, hero: 'Y', t: 3 }])[0].tStart, 0, 'clamped at 0');
// empty / junk → []
assert.deepEqual(detectMoments(null), [], 'null → []');
assert.deepEqual(detectMoments([{ team: 0, hero: 'X', t: 5 }]), [], 'single death → no fight');

// ── momentComms: recording-clock segments windowed via offset, ordered ──
{
  const moment = { tStart: 96, tEnd: 116 };  // game seconds
  const offsetS = 30;                          // recording = game + 30s
  const segments = [
    { t0Ms: 125000, t1Ms: 127000, text: 'they are pushing mid', speaker: 'Alex' }, // game 95 → in
    { t0Ms: 140000, t1Ms: 142000, text: 'back back', speaker: 'Sam' },             // game 110 → in
    { t0Ms: 300000, t1Ms: 301000, text: 'late chatter', speaker: 'Alex' },         // game 270 → out
    { t0Ms: 130000, t1Ms: 131000, text: '   ', speaker: 'Sam' },                   // blank → dropped
  ];
  const calls = momentComms(moment, segments, offsetS);
  assert.equal(calls.length, 2, 'two in-window non-blank calls');
  assert.equal(calls[0].text, 'they are pushing mid', 'ordered by time');
  assert.equal(calls[0].atGame, 95, 'atGame = t0Ms/1000 - offset');
}

// ── jumbleScore: overlap of 3+ concurrent → Jumbled ──
{
  // three calls all overlapping 90..92s → each overlaps 2 others → all concurrent
  const calls = [
    { t0Ms: 90000, t1Ms: 92000, speaker: 'A' },
    { t0Ms: 90500, t1Ms: 92500, speaker: 'B' },
    { t0Ms: 91000, t1Ms: 93000, speaker: 'C' },
  ];
  const j = jumbleScore(calls, { spanS: 20 });
  assert.equal(j.overlap, 3, 'all 3 concurrent');
  assert.equal(j.speakers, 3, '3 distinct speakers');
  assert.equal(j.label, 'Jumbled', 'overlap ⇒ Jumbled');
}
{
  const clear = jumbleScore([{ t0Ms: 1000, t1Ms: 2000, speaker: 'A' }, { t0Ms: 9000, t1Ms: 10000, speaker: 'B' }], { spanS: 20 });
  assert.equal(clear.label, 'Clear', 'sparse, no overlap ⇒ Clear');
  assert.equal(jumbleScore([], { spanS: 10 }).label, 'Clear', 'no calls ⇒ Clear');
}

// ── buildFights: ties it together, marks coached deaths via side ──
{
  const deaths = [{ team: 0, hero: 'Haze', t: 100 }, { team: 1, hero: 'Seven', t: 108 }];
  const segments = [{ t0Ms: 100000, t1Ms: 101000, text: 'go go', speaker: 'Alex' }]; // game 100 (offset 0)
  const fights = buildFights(deaths, segments, { side: 0, offsetS: 0 });
  assert.equal(fights.length, 1, 'one fight');
  assert.equal(fights[0].id, 'tf-96', 'id from padded start');
  assert.equal(fights[0].deaths[0].ours, true, 'team 0 death is ours (side 0)');
  assert.equal(fights[0].deaths[1].ours, false, 'team 1 death is enemy');
  assert.equal(fights[0].calls.length, 1, 'the in-window call attached');
}

// ── parseVerdicts / coerceVerdicts: merge Claude output, drop bad indices, keep neutral calls ──
{
  const fights = [{
    id: 'tf-96', tStart: 96, tEnd: 116,
    deaths: [], jumble: { label: 'Busy' },
    calls: [
      { t0Ms: 1, t1Ms: 2, atGame: 95, speaker: 'Alex', text: 'push mid' },
      { t0Ms: 3, t1Ms: 4, atGame: 100, speaker: 'Sam', text: 'go' },
    ],
  }];
  const modelText = '```json\n' + JSON.stringify({
    fights: [{
      id: 'tf-96',
      calls: [
        { i: 0, verdict: 'good', note: 'clear target' },
        { i: 1, verdict: 'wrong', note: 'went into a lost fight' },
        { i: 9, verdict: 'good', note: 'bogus index — dropped' },
        { i: 0, verdict: 'nonsense' }, // bad verdict — ignored, keeps the good one? no: same index re-set only on valid
      ],
      missed: [{ what: 'no flank call', shouldSay: 'watch left' }, { what: '', shouldSay: '' }],
    }, { id: 'ghost', calls: [{ i: 0, verdict: 'good' }] }], // unknown fight — dropped
  }) + '\n```';
  const merged = parseVerdicts(modelText, fights);
  assert.equal(merged.length, 1, 'still one fight (ghost dropped)');
  assert.equal(merged[0].calls[0].verdict, 'good', 'call 0 good');
  assert.equal(merged[0].calls[1].verdict, 'wrong', 'call 1 wrong');
  assert.equal(merged[0].missed.length, 1, 'blank missed entry filtered');
  assert.equal(merged[0].missed[0].shouldSay, 'watch left', 'missed shouldSay kept');
}

// parseVerdicts throws on non-JSON (so the caller reprompts once)
assert.throws(() => parseVerdicts('no json here', []), /no JSON object/, 'throws on garbage');

// a call the model never judged stays neutral
{
  const fights = [{ id: 'tf-1', tStart: 1, tEnd: 5, deaths: [], jumble: {}, calls: [{ atGame: 1, speaker: 'A', text: 'x', t0Ms: 0, t1Ms: 1 }] }];
  const merged = coerceVerdicts({ fights: [{ id: 'tf-1', calls: [], missed: [] }] }, fights);
  assert.equal(merged[0].calls[0].verdict, null, 'unjudged call ⇒ neutral');
}

// ── summarize: raw counts + shares for the sub-plan 12 feed ──
{
  const fights = [
    { jumble: { label: 'Jumbled' }, missed: [{ what: 'a' }, { what: 'b' }] },
    { jumble: { label: 'Clear' }, missed: [] },
    { jumble: { label: 'Jumbled' }, missed: [{ what: 'c' }] },
    { jumble: { label: 'Busy' }, missed: [] },
  ];
  const s = summarize(fights);
  assert.equal(s.fights, 4);
  assert.equal(s.jumbled, 2);
  assert.equal(s.missed, 3);
  assert.equal(s.jumbledShare, 0.5, '2/4 jumbled');
  assert.equal(s.missedPerFight, 0.75, '3/4 missed per fight');
  const z = summarize([]);
  assert.equal(z.jumbledShare, null, 'no fights ⇒ null share');
}

// buildTeamfightPrompt is a string that names the ids + indices (smoke)
{
  const fights = buildFights([{ team: 0, hero: 'Haze', t: 100 }, { team: 0, hero: 'Ivy', t: 106 }],
    [{ t0Ms: 101000, t1Ms: 102000, text: 'go', speaker: 'Alex' }], { side: 0 });
  const p = buildTeamfightPrompt(fights, { coachedTeam: 'Reliquary', roster: ['Alex'] });
  assert.ok(p.includes('tf-96'), 'prompt names the fight id');
  assert.ok(p.includes('[0] Alex'), 'prompt indexes the call');
}

console.log('teamfightComms.selftest: all assertions passed');

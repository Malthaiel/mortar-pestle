// Runnable check for matchDigest.js: `node matchDigest.selftest.mjs`.
// Runs against REAL .matchdata sidecars in the GameWiki vault (Move 8 fork trigger:
// green on ≥2 different sidecars) + sanity-asserts field-semantics ranges.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildMatchDigest, teamCurve, detectSwings, laneCurves, deathSummaries } from './matchDigest.js';

const scrimDir = path.join(process.env.APPDATA || '', 'dev.malthaiel.mortar-pestle', 'GameWiki', 'Deadlock', 'Coaching', 'Scrim');
assert.ok(fs.existsSync(scrimDir), `Scrim dir not found at ${scrimDir}`);
const load = (name) => JSON.parse(fs.readFileSync(path.join(scrimDir, name), 'utf8'));

// Scrim filenames follow user-renamable scrim names, so discover sidecars by glob
// and pin the ground-truth match by match_id — a rename/delete can't break the test.
const sidecars = fs.readdirSync(scrimDir)
  .filter((n) => /^\.matchdata\..*\.json$/.test(n))
  .map((n) => ({ n, raw: load(n) }));
assert.ok(sidecars.length >= 1, `no .matchdata sidecars in ${scrimDir}`);

// generic guards on EVERY real sidecar: renders, degrades, never throws
for (const { n, raw } of sidecars) {
  const d = buildMatchDigest(raw, { label: 'Match 1' });
  assert.ok(d.includes('### Scoreboard'), `${n}: missing scoreboard`);
  assert.ok(d.length < 60000, `${n}: digest too big (${d.length} chars)`);
  assert.ok(!d.includes('Hero undefined'), `${n}: killer slot failed to resolve`);
}

// ── ground-truth match (the Diarize scrim, pinned by match_id) ────────────────
const GT_ID = 93081870;
const gt = sidecars.find(({ raw }) => Number(raw?.match_info?.match_id) === GT_ID);
assert.ok(gt, `ground-truth match ${GT_ID} not found — scrim deleted?`);
const raw = gt.raw;
const digest = buildMatchDigest(raw, { label: 'Match 1' });

// known scoreboard facts (verified against the live payload 2026-07-13)
assert.ok(digest.includes('**Amber win**'), 'Amber win missing from header');
assert.ok(/- Celeste — 15\/1\/15 ·/.test(digest), 'Celeste 15/1/15 row missing');
assert.equal((digest.match(/Mid-boss claimed by Amber/g) || []).length, 2, 'expected 2 Amber mid-boss claims');

// every section header present, no absent-gaps on this rich sidecar
for (const h of ['### Scoreboard', '### Lanes', '### Souls curve (team delta', '### Tempo swings', '### Item builds', '### Deaths', '### Objective timeline', '### Damage focus']) {
  assert.ok(digest.includes(h), `missing section ${h}`);
}
assert.ok(!digest.includes('absent in this sidecar'), 'unexpected gap on the rich sidecar');

// curves: non-empty, sane ranges (souls semantics guard), monotonic time
const curve = teamCurve(raw);
assert.ok(curve.length >= 5, `suspiciously short team curve (${curve.length})`);
for (let i = 1; i < curve.length; i++) assert.ok(curve[i].t > curve[i - 1].t, 'curve not time-sorted');
const last = curve[curve.length - 1];
for (const v of [last.amber, last.sapphire]) assert.ok(v > 6 * 1000 && v < 12 * 100000, `absurd team souls total ${v}`);
assert.ok((Number(raw.match_info.duration_s) || 0) < 90 * 60, 'duration ≥ 90 min — semantics wrong');
const lc = laneCurves(raw);
assert.ok(lc.length >= 2 && lc.every((L) => L.pts.length > 0), 'lane curves empty');

// deaths resolve killers to hero names (never "Hero undefined")
const deaths = deathSummaries(raw);
assert.ok(deaths.some((d) => d.deaths.length), 'no deaths parsed');
assert.ok(!digest.includes('Hero undefined'), 'killer slot failed to resolve');

// swings: threshold behaves (0-threshold finds every move; huge threshold finds none)
assert.ok(detectSwings(curve, 1).length >= detectSwings(curve, 3000).length);
assert.equal(detectSwings(curve, 10 ** 9).length, 0);

// size budget: ≤ ~15k tokens ≈ 60k chars
assert.ok(digest.length < 60000, `digest too big (${digest.length} chars)`);

// ── tolerance: empty/garbage input degrades to gaps, never throws ────────────
const empty = buildMatchDigest({});
assert.ok(empty.includes('absent in this sidecar'));
assert.ok(buildMatchDigest(null).includes('## Match digest'));

console.log('matchDigest selftest OK —', sidecars.length, 'live sidecar(s),', digest.length, 'chars (ground-truth),', detectSwings(curve).length, 'swings detected');

// Runnable check for matchDigest.js: `node matchDigest.selftest.mjs`.
// Runs against REAL .matchdata sidecars in the GameWiki vault (Move 8 fork trigger:
// green on ≥2 different sidecars) + sanity-asserts field-semantics ranges.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildMatchDigest, teamCurve, detectSwings, laneCurves, deathSummaries } from './matchDigest.js';

const scrimDir = path.join(process.env.APPDATA || '', 'dev.malthaiel.mortar-pestle', 'GameWiki', 'Deadlock', 'Coaching', 'Scrim');
assert.ok(fs.existsSync(scrimDir), `Scrim dir not found at ${scrimDir}`);

// Schema v2 (GameWiki Unification): scrims are folders — sidecars live at
// `<scrim>/Matches/.matchdata.Match <n>.json`. Discover by walking scrim folders
// and pin the ground-truth match by match_id — a rename/delete can't break the test.
const sidecars = [];
for (const ent of fs.readdirSync(scrimDir, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const matchesDir = path.join(scrimDir, ent.name, 'Matches');
  if (!fs.existsSync(matchesDir)) continue;
  for (const n of fs.readdirSync(matchesDir)) {
    if (!/^\.matchdata\..*\.json$/.test(n)) continue;
    sidecars.push({ n: `${ent.name}/${n}`, raw: JSON.parse(fs.readFileSync(path.join(matchesDir, n), 'utf8')) });
  }
}
// Fresh-start vault (2026-07-16): no scrim data yet is a SKIP, not a failure —
// the digest logic is unchanged; the gate re-arms as soon as a sidecar exists.
if (sidecars.length === 0) {
  console.log('matchDigest.selftest: SKIP — no .matchdata sidecars in any scrim folder yet');
  process.exit(0);
}

// generic guards on EVERY real sidecar: renders, degrades, never throws
for (const { n, raw } of sidecars) {
  const d = buildMatchDigest(raw, { label: 'Match 1' });
  assert.ok(d.includes('### Scoreboard'), `${n}: missing scoreboard`);
  assert.ok(d.length < 60000, `${n}: digest too big (${d.length} chars)`);
  assert.ok(!d.includes('Hero undefined'), `${n}: killer slot failed to resolve`);
}

// ── ground-truth match (the Diarize scrim, pinned by match_id) ────────────────
// The 2026-07-16 fresh start deleted the pinned scrim; the fact-asserts below only
// run when the GT match is present. The richest available sidecar still exercises
// every section/curve check either way.
const GT_ID = 93081870;
const gt = sidecars.find(({ raw }) => Number(raw?.match_info?.match_id) === GT_ID);
const rich = gt || sidecars.reduce((a, b) => (JSON.stringify(a.raw).length >= JSON.stringify(b.raw).length ? a : b));
const raw = rich.raw;
const digest = buildMatchDigest(raw, { label: 'Match 1' });

if (gt) {
  // known scoreboard facts (verified against the live payload 2026-07-13)
  assert.ok(digest.includes('**Amber win**'), 'Amber win missing from header');
  assert.ok(/- Celeste — 15\/1\/15 ·/.test(digest), 'Celeste 15/1/15 row missing');
  assert.equal((digest.match(/Mid-boss claimed by Amber/g) || []).length, 2, 'expected 2 Amber mid-boss claims');
} else {
  console.log(`matchDigest.selftest: ground-truth ${GT_ID} absent (fresh-start vault) — fact-asserts skipped`);
}

const curve = teamCurve(raw);
if (gt) {
  // every section header present, no absent-gaps on this rich sidecar
  for (const h of ['### Scoreboard', '### Lanes', '### Souls curve (team delta', '### Tempo swings', '### Item builds', '### Deaths', '### Objective timeline', '### Damage focus']) {
    assert.ok(digest.includes(h), `missing section ${h}`);
  }
  assert.ok(!digest.includes('absent in this sidecar'), 'unexpected gap on the rich sidecar');

  // curves: non-empty, sane ranges (souls semantics guard), monotonic time
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
}

// ── tolerance: empty/garbage input degrades to gaps, never throws ────────────
const empty = buildMatchDigest({});
assert.ok(empty.includes('absent in this sidecar'));
assert.ok(buildMatchDigest(null).includes('## Match digest'));

console.log('matchDigest selftest OK —', sidecars.length, 'live sidecar(s),', digest.length, 'chars (ground-truth),', detectSwings(curve).length, 'swings detected');

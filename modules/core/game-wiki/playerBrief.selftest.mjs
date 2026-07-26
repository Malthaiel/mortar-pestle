// Runnable check for playerBrief.js (no framework): `node playerBrief.selftest.mjs`.
// Covers the logic that fails SILENTLY — a check that never fires reads exactly like a clean run.
// The emoji assertion gets a novel emoji as well as the three that were removed, because a
// blacklist of the three we already fixed is the §1.7 failure repeated.
import assert from 'node:assert/strict';
import {
  BRIEF_SYSTEM, parseBrief, scanLines, briefSections, cardLines, checkTemplate, checkProse,
  splitBriefSentences, parseMachineBlock, checkCoverage, briefToFinal, FIXED_STRINGS,
} from './playerBrief.js';
import { reconcileReport } from './vodReport.js';

// A minimal well-formed brief. Every fixed string present, second person throughout, a fenced card,
// a blockquote, and a machine block whose ledger and items both resolve.
const FENCE = '```';
const OK = `# Nova — Coaching Notes, session with Malthaiel

**Hero pool locked for now: Ivy · Dynamo**
**Read order:** §0 → §1 → your hero section → §3 (sideline card). Everything else is reference.

---

## §0 — THE WHOLE SESSION IN 2 LINES

1. **Play slow.** Crosshair placement beats speed every time you contest a duel.
2. **Never ult without a target.** You are a global and the ult is your only reach.

---

## §1 — MINDSET

### 1.1 Rule Zero — play ranked the way you play scrims
- You said: **one build in scrims, another in ranked.** Stop doing this.
- **Why:** every game on the other build is a rep of a habit you will never use.
- **Action:** one build identity per hero, and you run it in every mode.

---

## §2 — AIM

### 2.1 The fix — one rule
> **Play slow. Aim like a robot.**

You slow down, you look at the crosshair, and you drag it onto the target. Your accuracy
climbs the moment you stop flicking for the highlight.

---

## §3 — SIDELINE CARD
*Put this on your second monitor. Glance at it between deaths.*

${FENCE}
─────────────────────────────────────────────
BEFORE QUEUE
□ Same build as scrims.

ALL HEROES
□ Aim slow. Never flick.
─────────────────────────────────────────────
${FENCE}

---

## §4 — SELF-TEST (cover the answers)

1. What single change improves your aim most? → *Slow down; placement over speed.*

---

## §5 — WHAT'S STILL OPEN

| Item | Status |
|---|---|
| **Kelvin** | **Shelved.** You already have two heroes to polish. |

---

### Closing frame
You do not need new mechanics. You need to pay attention. This is polish.

<!-- brief-meta v1
player: Nova
coach: Malthaiel
pool: Ivy, Dynamo
items: same-build-as-scrims=pending; aim-slow-never-flick=pending
ledger: L1 12:03r 1-mindset; L2 18:27r 2-aim; L3 33:39r unplaced
-->`;

// ── the prompt itself ────────────────────────────────────────────────────────
// The texture example is the largest lever on output style; shipping it without the conversion
// teaches back the exact marks the no-emoji decision removed.
assert.ok(!/\p{Extended_Pictographic}/u.test(BRIEF_SYSTEM), 'no emoji may survive anywhere in the system prompt');
assert.ok(BRIEF_SYSTEM.includes('**KEEP** — **Sprint Boots early.**'), 'texture verdict marks converted');
assert.ok(BRIEF_SYSTEM.includes('TEXTURE REFERENCE'), 'texture carries its do-not-copy header');
assert.ok(!/\boff[- ]meta\b/i.test(BRIEF_SYSTEM.split('=== HEURISTICS')[0].split('TEXTURE REFERENCE')[1] || ''),
  'the texture example must not itself breach the fancy-word rule it teaches');

// ── parseBrief ───────────────────────────────────────────────────────────────
assert.equal(parseBrief('# Title\n\nbody'), '# Title\n\nbody');
assert.equal(parseBrief(`${FENCE}markdown\n# Title\n\nbody\n${FENCE}`), '# Title\n\nbody', 'strips a wrapping fence');
assert.throws(() => parseBrief('   '), /empty/, 'an empty emission is a parse failure worth retrying');
assert.throws(() => parseBrief('{"sections":[]}'), /heading/, 'JSON output is a parse failure, not a document');

// ── structure ────────────────────────────────────────────────────────────────
const secs = briefSections(OK);
assert.deepEqual(secs.map((s) => s.heading), [
  '§0 — THE WHOLE SESSION IN 2 LINES', '§1 — MINDSET', '§2 — AIM', '§3 — SIDELINE CARD',
  '§4 — SELF-TEST (cover the answers)', "§5 — WHAT'S STILL OPEN",
]);
assert.ok(secs[0].id && !secs[0].id.includes(' '), 'section ids are slugs');
assert.deepEqual(cardLines(OK), ['Same build as scrims.', 'Aim slow. Never flick.']);
assert.deepEqual(cardLines(OK.replace(/□ [^\n]*\n/g, '')), [], 'a card with no lines reads as empty, not as a parse error');
// The machine block is never document content — a `##` inside it must not become a section.
assert.equal(briefSections(`${OK}\n<!-- brief-meta v1\n## Not A Section\n-->`).length, secs.length);

// ── checkTemplate ────────────────────────────────────────────────────────────
assert.deepEqual(checkTemplate(OK), [], 'the good fixture is clean');
for (const s of FIXED_STRINGS) {
  // replaceAll, not replace: the card is bounded by TWO ─ rules, so dropping one leaves the check
  // satisfied by the other and the assertion would pass for the wrong reason.
  const missing = checkTemplate(OK.replaceAll(s, 'XX'));
  assert.ok(missing.some((f) => f.includes(JSON.stringify(s))), `dropping ${s} must flag`);
}
// The three that were removed AND one that never existed — the property is "no emoji", not "not
// these three". A novel mark slipping into the slot they vacated is the failure being guarded.
for (const e of ['✅', '⚠️', '❌', '🟢', '✔']) {
  const flags = checkTemplate(OK.replace('□ Same build as scrims.', `□ ${e} Same build as scrims.`));
  assert.ok(flags.some((f) => f.startsWith('[template] emoji')), `emoji ${JSON.stringify(e)} must flag`);
}
// Structural typography is NOT emoji and must survive: box rules, checkbox, hero separator, arrow,
// section sign, degree, ellipsis, en/em dash.
assert.deepEqual(checkTemplate(OK.replace('You need to pay attention.', 'Sensitivity ~180° is fine … see §1 → §2.')), [],
  'structural characters must never read as emoji');
// The machine block is exempt — it is not reader-facing.
assert.deepEqual(checkTemplate(OK.replace('player: Nova', 'player: Nova ✅')), []);

// ── checkProse v3 ────────────────────────────────────────────────────────────
const kinds = (md) => checkProse(md).join('\n');
assert.ok(!/\[style\]/.test(kinds(OK)), `the good fixture is clean, got:\n${kinds(OK)}`);

const flagFires = (find, repl, needle) => {
  const md = OK.replace(find, repl);
  assert.notEqual(md, OK, `fixture drifted, not found: ${find}`);
  assert.ok(kinds(md).includes(needle), `expected ${needle}, got:\n${kinds(md)}`);
};
// distance — inverts the old report's `pov` flag: third person about the reader is now the defect.
flagFires('You said:', 'The player said:', 'third-person reference');
flagFires('You said:', 'Speaker 3 said:', 'third-person reference');
// voiceless — a section body that has drifted back to labelled fact.
flagFires(
  'You slow down, you look at the crosshair, and you drag it onto the target. Your accuracy\nclimbs the moment you stop flicking for the highlight.',
  'Stated answer on whether the crosshair gets watched: not really, and not remembered. The read on\nthat: the knowledge is there and the attention is not, across every duel contested so far.',
  'no second person anywhere',
);
// narration — the session is the source, not the subject.
flagFires('**Why:** every game', '**Why:** the coach then explained that every game', 'narrates the session');
// label — the bare-label failure, mechanically: a short bold with nothing after it, or with nothing
// but another label after it (the §1.4 `- **Coaching:** - **Current habit:** …` shape).
flagFires('- **Action:** one build identity per hero, and you run it in every mode.', '- **Coaching:**', 'bare bolded label');
flagFires('- **Action:** one build identity per hero, and you run it in every mode.',
  '- **Coaching:** - **Current habit, raised unprompted:** see above.', 'bare bolded label');
// §0 is a numbered list, and "a topic label is not a line" is the rule it exists to enforce — the
// bullet prefix must accept `1.` or the compression layer goes unchecked entirely.
flagFires('1. **Play slow.** Crosshair placement beats speed every time you contest a duel.',
  '1. **Cube usage.**', 'bare bolded label');
// A colon lead carrying real content is the rule WORKING. The spec's own skeleton ships
// `- **Why:** <mechanism>` and `- **Action:** <one imperative>`; flagging those checks the
// document against a rule it was written to follow.
assert.ok(!kinds(OK).includes('bare bolded label'), 'a colon lead with real content after it is clean');
// fancy — regex, so a phrasing variant the substring list missed still fires.
flagFires('one build identity per hero', 'a build that is very off meta', 'fancy wording');
flagFires('one build identity per hero', 'a build whose value accumulates', 'fancy wording');
// length + passive.
flagFires('**Action:** one build identity per hero, and you run it in every mode.',
  `**Action:** ${'you keep one single build identity per hero and then you run that exact same build in every mode you queue for '.repeat(2)}so it sticks.`,
  'over 35 words');
flagFires('You said:', 'You were reminded:', 'passive voice');
// A bolded lead running on into its sentence is the rule WORKING — it must not flag.
assert.ok(!kinds(OK.replace('- **Action:** one', "- **You don't tilt.** You treat the game as leisure. One")).includes('bare bolded label'));
// Blockquotes and the card's fenced block are exempt by design.
assert.ok(!kinds(OK.replace('> **Play slow. Aim like a robot.**', '> **The player was told to play slow.**')).includes('[style]'));

// ── splitBriefSentences ──────────────────────────────────────────────────────
const long = OK.replace('**Why:** every game on the other build is a rep of a habit you will never use.',
  '**Why:** every single game you play on the other build is one more rep of a habit that you are never going to use competitively: the cost lands later and it lands all at once.');
const split = splitBriefSentences(long);
assert.equal(split.n, 1, 'the over-long sentence is split at its colon');
assert.ok(split.text.includes('The cost lands later'), 'the right half is re-capitalised');
// Nothing outside prose may be rewritten.
assert.equal(splitBriefSentences(OK).n, 0);
assert.equal(splitBriefSentences(OK).text, OK, 'a clean document round-trips byte for byte');
const machineBefore = OK.slice(OK.indexOf('<!-- brief-meta'));
assert.ok(split.text.endsWith(machineBefore), 'the machine block is never touched');
assert.ok(split.text.includes('□ Aim slow. Never flick.'), "the card's fenced block is never touched");

// ── the machine block ────────────────────────────────────────────────────────
const meta = parseMachineBlock(OK);
assert.equal(meta.present, true);
assert.equal(meta.player, 'Nova');
assert.equal(meta.coach, 'Malthaiel');
assert.deepEqual(meta.pool, ['Ivy', 'Dynamo']);
assert.deepEqual(meta.items.map((i) => i.slug), ['same-build-as-scrims', 'aim-slow-never-flick']);
assert.ok(meta.items.every((i) => i.status === 'pending'));
assert.equal(meta.ledger.length, 3);
assert.deepEqual(meta.ledger[0], { id: 'L1', stamp: '12:03r', section: '1-mindset' });
assert.equal(parseMachineBlock('# no block here').present, false);

// ── checkCoverage ────────────────────────────────────────────────────────────
const cov = checkCoverage(OK);
assert.ok(cov[0].includes('3 points, 2 placed, 1 unplaced'), `got: ${cov[0]}`);
assert.ok(cov.some((f) => f.includes('could not place')), 'an unplaced point must be surfaced, not buried');
// A ledger entry naming a section that does not exist means a point went somewhere unverifiable.
assert.ok(checkCoverage(OK.replace('L2 18:27r 2-aim', 'L2 18:27r 9-nowhere'))
  .some((f) => f.includes('does not exist')));
// An items slug with no card line means the card lost a behaviour the model meant to put there.
assert.ok(checkCoverage(OK.replace('□ Aim slow. Never flick.', '□ Something else entirely.'))
  .some((f) => f.includes('no card line')));
assert.deepEqual(checkCoverage('# no block'), ['[coverage] no machine block — coverage cannot be checked']);

// ── the shadow report ────────────────────────────────────────────────────────
// Everything downstream (Carry-Forward, Team Progress, homework carry-over, the report view, the
// tree's section sub-nav) reads only these three keys. If this projection breaks, they all go dark
// with no error anywhere.
const fresh = briefToFinal(OK, { warnings: ['[style] example'], generated: '2026-07-26', model: 'opus-5' });
assert.equal(fresh.schemaVersion, 2);
assert.equal(fresh.sections.length, 6);
assert.equal(fresh.sections[1].heading, '§1 — MINDSET');
assert.ok(fresh.sections[1].md.includes('Rule Zero'), 'section bodies carry their content');
assert.deepEqual(fresh.actionItems.map((a) => a.text), ['Same build as scrims.', 'Aim slow. Never flick.']);
assert.ok(fresh.actionItems.every((a) => a.status === 'pending' && a.id));
assert.deepEqual(fresh.carry, []);
assert.deepEqual(fresh.meta.warnings, ['[style] example']);
assert.equal(fresh.generated, '2026-07-26');
assert.equal(fresh.model, 'opus-5');

// The human's done/pending toggles survive a regenerate — the existing reconcileReport does this by
// action-item id, and briefToFinal mints ids with the same slugId, so no second reconciler exists.
const prior = briefToFinal(OK);
prior.actionItems[0].status = 'done';
const carried = reconcileReport(briefToFinal(OK), prior);
assert.equal(carried.actionItems[0].status, 'done', 'a ticked card line stays ticked across a regenerate');
assert.equal(carried.actionItems[1].status, 'pending');
// A renamed card line loses its tick. Accepted tradeoff, same as the existing pipeline — asserted
// so it stays a decision rather than becoming a surprise.
const renamed = reconcileReport(briefToFinal(OK.replace('□ Same build as scrims.', '□ Same build as scrims, always.')), prior);
assert.equal(renamed.actionItems[0].status, 'pending');

console.log('playerBrief selftest: PASS');

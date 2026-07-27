// Runnable check for playerBrief.js (no framework): `node playerBrief.selftest.mjs`.
// Covers the logic that fails SILENTLY — a check that never fires reads exactly like a clean run.
//
// Retargeted 2026-07-26 to `deadlock-coaching-notes-session-01.md`: the fixture is a miniature of
// that document's shape (§0 how-to + notation key → §1 Ten Laws → PARTs → card → self-test table →
// appendices), and the emoji assertion now proves the FOUR allowed marks pass while a novel one
// still fails. A blacklist of the marks we happen to have seen is the failure that keeps repeating.
import assert from 'node:assert/strict';
import {
  BRIEF_SYSTEM, parseBrief, briefSections, cardLines, checkTemplate, checkProse, checkDevices,
  splitBriefSentences, parseMachineBlock, checkCoverage, briefToFinal, buildBriefPrompt,
  lexiconOnly, FIXED_STRINGS, DEVICE_BANDS,
} from './playerBrief.js';
import { reconcileReport } from './vodReport.js';

// A minimal well-formed brief. Every fixed string present, second person throughout, the card in a
// fenced block, a deferred-work note, and a machine block whose ledger and items both resolve.
const FENCE = '```';
const OK = `# Deadlock Coaching Notes — Session 02

**Coach:** Malthaiel (Eternus 6) · **Format:** scrim-level review · **Runtime:** ~56 min
**Your focus heroes going forward:** Ivy · Dynamo — *nothing else for now.*

---

## §0 — How to use this document

Read top to bottom **once**. Then you only ever need three things again:

| If you want… | Go to |
|---|---|
| The whole session compressed | **§1 — The Ten Laws** |
| The thing you keep open on monitor 2 | **§4 — Side-Monitor Card** |
| To prove to yourself you absorbed it | **§5 — Self-Test** |

Notation used throughout:
- **→** means "therefore / do this"
- **⚠** = a trap you specifically fall into
- **#** = a hard number worth memorizing
- *Italics* = coach's exact framing, preserved because the phrasing is the point

---

## §1 — The Ten Laws (the entire session, compressed)

1. **Play slow.** Crosshair placement beats speed every time you contest a duel.
2. **Never ult without a passenger.** You have #21 seconds of flight, so you can afford to wait.

---

# PART I — MINDSET & RANK

## §2.1 Play ranked the way you play scrims
- You said: **one build in scrims, another in ranked.** Stop doing this.
- **Why:** every game on the other build is a rep of a habit you will never use.
- **Action:** one build identity per hero, and you run it in every mode.

---

# PART II — MECHANICS

## §3.1 Aim
> *"Play slow. Aim like a robot."*

You slow down, you look at the crosshair, and you drag it onto the target. Your accuracy
climbs the moment you stop flicking for the highlight.

⚠ **The trap:** you chase the highlight flick and lose the duel you already had.

---

# PART III — WHAT NOT TO DO YET

Revisiting these early is how you lose the next two months.

| Item | Ruling |
|---|---|
| **A 4th hero** | ❌ You already have two. |
| **Trade-value theory** | ⏸ Deferred to a future session. |

---

# PART IV — THE APPLICATION SYSTEM

## §4 — Side-Monitor Card

**The method:** keep this open on your second screen and glance at it between deaths.

---

${FENCE}
┌─ CURRENT FOCUS ────────────────────────────────┐

  EVERY GAME
  □ Same build as scrims.

  AIM
  □ Aim slow. Never flick.

└────────────────────────────────────────────────┘
${FENCE}

*Coach is separately producing his own condensed actionable list.*

---

## §5 — Self-Test

Cover the right column.

| Q | A |
|---|---|
| What single change improves your aim most? | Slow down; placement over speed. |

---

# APPENDIX B — Your intake list → where it's answered

Everything you raised, mapped. Nothing was dropped.

| You said | Answered in |
|---|---|
| "My aim is trash" | §3.1 |

<!-- brief-meta v2
player: Nova
coach: Malthaiel
pool: Ivy, Dynamo
deferred: yes
items: same-build-as-scrims=pending; aim-slow-never-flick=pending
ledger: L1 12:03r 2-1-play-ranked-the-way-you-play-scrims; L2 18:27r 3-1-aim; L3 33:39r unplaced
-->`;

// ── the prompt itself ────────────────────────────────────────────────────────
// The four allowed marks are NAMED in the prompt (they are part of the notation the model must
// emit), so a blanket no-emoji assertion on BRIEF_SYSTEM is wrong now. The property is "no marks
// beyond the four".
assert.ok(!/\p{Extended_Pictographic}/u.test(BRIEF_SYSTEM.replace(/[⚠✅❌⏸]️?/gu, '')),
  'no pictograph beyond the four allowed marks may appear in the system prompt');
for (const mark of ['⚠', '✅', '❌', '⏸']) {
  assert.ok(BRIEF_SYSTEM.includes(mark), `the prompt must teach the ${mark} mark it expects back`);
}
// The reasoning chain is the point of this rewrite — the five method steps and the ten techniques
// are what the browser chat actually did, and dropping any of them silently reverts the retarget.
for (const step of ['STEP 1 —', 'STEP 2 —', 'STEP 3 —', 'STEP 4 —', 'STEP 5 —']) {
  assert.ok(BRIEF_SYSTEM.includes(step), `the method must carry ${step}`);
}
assert.ok(BRIEF_SYSTEM.includes('REPAIR THE DIARIZATION'), 'speaker-label repair is a method step, not a footnote');
assert.ok(BRIEF_SYSTEM.includes('SEPARATE THE RULING FROM ITS RATIONALE'), 'the ruling/rationale split is the layering mechanism');
assert.ok(BRIEF_SYSTEM.includes('COVERAGE AUDIT'), 'the coverage appendix is what makes "nothing lost" checkable');
// No texture example: the browser chat had none, and the target was written from the very session
// the app is tested on, so pasting it lets the model copy the answers.
assert.ok(!BRIEF_SYSTEM.includes('TEXTURE REFERENCE'), 'the texture example is deliberately gone');
assert.ok(!/Rescue Beam|Trophy Collector|Yamato/.test(BRIEF_SYSTEM),
  'no content from the target session may appear in the prompt');
// Every band the code checks must be stated in the prompt, verbatim and with the same numbers, or
// the rule is unenforced prose on one side and an unexplained warning on the other.
// Quotes are stripped from both sides: the prompt writes the marks as `"→" 28-44` for readability.
const unquoted = BRIEF_SYSTEM.replace(/"/g, '');
for (const [name, , lo, hi] of DEVICE_BANDS) {
  const bare = name.replace(/"/g, '');
  assert.ok(unquoted.includes(`${bare} ${lo}-${hi}`), `band "${name}" must state ${lo}-${hi} in the prompt`);
}

// ── buildBriefPrompt ─────────────────────────────────────────────────────────
// The brief takes the transcript and the name list and NOTHING else. A regression here reopens
// every route by which a coaching point the coach never voiced enters the document.
const up = buildBriefPrompt({ transcriptBlock: '[0:00] Malthaiel: play slow', lexiconBlock: '- Ivy', sessionNumber: 3 });
assert.ok(up.includes('Session number: 03.'), 'the session number is zero-padded for the title');
assert.ok(up.includes('CANONICAL NAMES'), 'the name list is passed for spelling');
assert.ok(up.includes('[0:00] Malthaiel: play slow'));
assert.ok(!/ANALYST BRAIN|Coached team|tagged in-game notes/.test(up), 'no other input may reach the brief');
assert.ok(!buildBriefPrompt({ transcriptBlock: 'x' }).includes('CANONICAL NAMES'), 'an absent name list adds no empty header');

assert.equal(lexiconOnly('=== ANALYST CHARTER ===\nblah\n\n=== LEXICON ===\n- Ivy\n- Dynamo\n\n=== PATCH DIGEST ===\nx'),
  '- Ivy\n- Dynamo', 'the lexicon is sliced out without its neighbours');
assert.equal(lexiconOnly('no blocks here'), '');

// ── parseBrief ───────────────────────────────────────────────────────────────
assert.equal(parseBrief('# Title\n\nbody'), '# Title\n\nbody');
assert.equal(parseBrief(`${FENCE}markdown\n# Title\n\nbody\n${FENCE}`), '# Title\n\nbody', 'strips a wrapping fence');
assert.throws(() => parseBrief('   '), /empty/, 'an empty emission is a parse failure worth retrying');
assert.throws(() => parseBrief('{"sections":[]}'), /heading/, 'JSON output is a parse failure, not a document');

// ── structure ────────────────────────────────────────────────────────────────
// Both "#" and "##" are sections now: the PARTs that own text (what-not-to-do) and the appendices
// carry ledger points, and leaving them out made those entries dangle. The title is not a section,
// and a PART that only introduces its children owns no text and is dropped.
const secs = briefSections(OK);
assert.deepEqual(secs.map((s) => s.heading), [
  '§0 — How to use this document',
  '§1 — The Ten Laws (the entire session, compressed)',
  '§2.1 Play ranked the way you play scrims',
  '§3.1 Aim',
  'PART III — WHAT NOT TO DO YET',
  '§4 — Side-Monitor Card',
  '§5 — Self-Test',
  "APPENDIX B — Your intake list → where it's answered",
]);
assert.ok(!secs.some((s) => s.heading.startsWith('Deadlock Coaching Notes')), 'the title is not a section');
assert.ok(!secs.some((s) => s.heading === 'PART I — MINDSET & RANK'), 'a PART that owns no text is dropped');
assert.ok(secs[0].id && !secs[0].id.includes(' '), 'section ids are slugs');
assert.deepEqual(cardLines(OK), ['Same build as scrims.', 'Aim slow. Never flick.']);
assert.deepEqual(cardLines(OK.replace(/□ [^\n]*\n/g, '')), [], 'a card with no lines reads as empty, not as a parse error');
// The machine block is never document content — a `##` inside it must not become a section.
assert.equal(briefSections(`${OK}\n<!-- brief-meta v2\n## Not A Section\nbody\n-->`).length, secs.length);

// ── checkTemplate ────────────────────────────────────────────────────────────
assert.deepEqual(checkTemplate(OK), [], `the good fixture is clean, got: ${checkTemplate(OK).join(' | ')}`);
for (const s of FIXED_STRINGS) {
  // replaceAll, not replace: several fixed strings appear twice (the card is bounded by two rules,
  // and §0's nav table repeats the card and self-test headings), so dropping one leaves the check
  // satisfied by the other and the assertion would pass for the wrong reason.
  const missing = checkTemplate(OK.replaceAll(s, 'XX'));
  assert.ok(missing.some((f) => f.includes(JSON.stringify(s))), `dropping ${s} must flag`);
}
// The four marks are load-bearing and must PASS; anything else must fail. This is the pair that
// keeps the allowance from widening into "any emoji".
for (const mark of ['⚠', '✅', '❌', '⏸']) {
  assert.deepEqual(checkTemplate(OK.replace('| **A 4th hero** | ❌', `| **A 4th hero** | ${mark}`)), [],
    `the allowed mark ${mark} must pass`);
}
for (const e of ['🟢', '✔', '🔥', '⭐']) {
  const flags = checkTemplate(OK.replace('□ Same build as scrims.', `□ ${e} Same build as scrims.`));
  assert.ok(flags.some((f) => f.startsWith('[template] emoji')), `emoji ${JSON.stringify(e)} must flag`);
}
// Structural typography is NOT emoji and must survive: box rules, checkbox, hero separator, arrow,
// section sign, degree, ellipsis, en/em dash.
assert.deepEqual(checkTemplate(OK.replace('Cover the right column.', 'Sensitivity ~180° is fine … see §1 → §2 – §3.')), [],
  'structural characters must never read as emoji');
// The machine block is exempt — it is not reader-facing.
assert.deepEqual(checkTemplate(OK.replace('player: Nova', 'player: Nova 🟢')), []);
// The deferred-work line lost its heading in this rewrite, so an absent line and a session that
// deferred nothing are identical in the markdown. Only the machine block can tell them apart, and
// this is the regression watch-point that survived four billed runs.
assert.ok(checkTemplate(OK.replace('*Coach is separately producing his own condensed actionable list.*\n\n', ''))
  .some((f) => f.includes('no italic line follows the card')), 'a dropped deferred-work note must flag');
assert.deepEqual(checkTemplate(OK
  .replace('deferred: yes', 'deferred: no')
  .replace('*Coach is separately producing his own condensed actionable list.*\n\n', '')), [],
'a session that deferred nothing needs no note');

// ── checkProse ───────────────────────────────────────────────────────────────
const kinds = (md) => checkProse(md).join('\n');
assert.ok(!/\[style\]/.test(kinds(OK)), `the good fixture is clean, got:\n${kinds(OK)}`);

const flagFires = (find, repl, needle) => {
  const md = OK.replace(find, repl);
  assert.notEqual(md, OK, `fixture drifted, not found: ${find}`);
  assert.ok(kinds(md).includes(needle), `expected ${needle}, got:\n${kinds(md)}`);
};
// distance — third person about the reader is the defect this document exists to invert.
flagFires('You said:', 'The player said:', 'third-person reference');
flagFires('You said:', 'Speaker 3 said:', 'third-person reference');
// voiceless — a section body that has drifted back to labelled fact.
// The whole section body has to go voiceless — the ⚠ line carries a "you" of its own, and leaving
// it in made this assertion pass for the wrong reason.
flagFires(
  'You slow down, you look at the crosshair, and you drag it onto the target. Your accuracy\nclimbs the moment you stop flicking for the highlight.\n\n⚠ **The trap:** you chase the highlight flick and lose the duel you already had.',
  'Stated answer on whether the crosshair gets watched: not really, and not remembered. The read on\nthat: the knowledge is there and the attention is not, across every duel contested so far.',
  'no second person anywhere',
);
// A reference TABLE is legitimately voiceless — account history, a glossary. Flagging it would train
// the model to bolt "you" onto a lookup table.
assert.ok(!kinds(`${OK}\n\n## §6 Account context\n\n| | |\n|---|---|\n| Peak | Ascendant 2 |\n| Now | Archon 4 |\n| Games | ~50 lifetime, fourth most played |\n`)
  .includes('no second person'), 'a mostly-table section is exempt from the voice check');
// narration — the play-by-play of the conversation, not the naming of the coach.
flagFires('**Why:** every game', '**Why:** the coach then explained that every game', 'narrates the conversation');
// Naming the coach is the rule WORKING: authorship changes what a claim is worth, and the target
// document does this constantly.
assert.ok(!kinds(OK.replace('**Action:** one build', "**Coach's reaction:** this is the win condition, and one build"))
  .includes('narrates the conversation'), 'naming the coach is not narration');
// label — a short bold with nothing after it, or with nothing but another label after it.
flagFires('- **Action:** one build identity per hero, and you run it in every mode.', '- **Coaching:**', 'bare bolded label');
flagFires('- **Action:** one build identity per hero, and you run it in every mode.',
  '- **Coaching:** - **Current habit, raised unprompted:** see above.', 'bare bolded label');
// The Laws are a numbered list, and "a topic label is not a line" is the rule §1 exists to enforce —
// the bullet prefix must accept `1.` or the compression layer goes unchecked entirely.
flagFires('1. **Play slow.** Crosshair placement beats speed every time you contest a duel.',
  '1. **Cube usage.**', 'bare bolded label');
// A ⚠-prefixed bolded lead is the template's own shape and must not read as a bare label.
assert.ok(!kinds(OK).includes('bare bolded label'), 'a colon lead with real content after it is clean');
// fancy — regex, so a phrasing variant a substring list would miss still fires.
flagFires('one build identity per hero', 'a build whose value accumulates', 'fancy wording');
// The three words the target document uses were REMOVED from the list: a checker that fights the
// reference document is noise, and noise is how a warning list stops being read.
for (const ok of ['a build that is very off meta', 'a build that synergizes with your position',
  'a rule infinitely more important than speed']) {
  assert.ok(!kinds(OK.replace('one build identity per hero', ok)).includes('fancy wording'),
    `"${ok}" appears in the target document and must not flag`);
}
// length + passive.
flagFires('**Action:** one build identity per hero, and you run it in every mode.',
  `**Action:** ${'you keep one single build identity per hero and then you run that exact same build in every mode you queue for '.repeat(2)}so it sticks.`,
  'over 35 words');
flagFires('You said:', 'You were reminded:', 'passive voice');
// A bolded lead running on into its sentence is the rule WORKING — it must not flag.
assert.ok(!kinds(OK.replace('- **Action:** one', "- **You don't tilt.** You treat the game as leisure. One")).includes('bare bolded label'));
// Blockquotes and the fenced card are exempt by design.
assert.ok(!kinds(OK.replace('> *"Play slow. Aim like a robot."*', '> **The player was told to play slow.**')).includes('[style]'));

// ── checkDevices ─────────────────────────────────────────────────────────────
// The fixture is a miniature, so it is legitimately under every band — the assertion is that the
// check FIRES and names the band, not that a two-section document hits a full document's density.
const dev = checkDevices(OK);
assert.ok(dev.length, 'a miniature document must come back under band, not clean');
assert.ok(dev.every((f) => /^\[density\] .+ \d+, band \d+-\d+ —/.test(f)), `band flags name their band, got:\n${dev.join('\n')}`);
assert.ok(dev.some((f) => f.startsWith('[density] →')), 'the arrow band is checked');
// Over-band must fire too: a floor-only check licenses turning every joint into an arrow.
assert.ok(checkDevices(`${OK}\n${'→ '.repeat(60)}`).some((f) => f.includes('stopped marking anything')),
  'a device past its band is decoration and must flag');
// The machine block is not reader-facing and must not count toward density.
assert.deepEqual(checkDevices(OK), checkDevices(OK.replace('ledger: L1', 'ledger: → → → → → L1')));

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
assert.equal(meta.deferred, true);
assert.equal(parseMachineBlock(OK.replace('deferred: yes', 'deferred: no')).deferred, false);
assert.equal(parseMachineBlock(OK.replace('deferred: yes\n', '')).deferred, false, 'an absent field is not deferred');
assert.deepEqual(meta.items.map((i) => i.slug), ['same-build-as-scrims', 'aim-slow-never-flick']);
assert.ok(meta.items.every((i) => i.status === 'pending'));
assert.equal(meta.ledger.length, 3);
assert.deepEqual(meta.ledger[0], { id: 'L1', stamp: '12:03r', section: '2-1-play-ranked-the-way-you-play-scrims' });
assert.equal(parseMachineBlock('# no block here').present, false);

// ── checkCoverage ────────────────────────────────────────────────────────────
const cov = checkCoverage(OK);
assert.ok(cov[0].includes('3 points, 2 placed, 1 unplaced'), `got: ${cov[0]}`);
assert.ok(cov.some((f) => f.includes('could not place')), 'an unplaced point must be surfaced, not buried');
// A ledger entry naming a section that does not exist means a point went somewhere unverifiable.
assert.ok(checkCoverage(OK.replace('L2 18:27r 3-1-aim', 'L2 18:27r 9-nowhere'))
  .some((f) => f.includes('does not exist')));
// A PART or appendix that owns text is a valid ledger target — the whole reason briefSections took
// "#" headings on. Without this, every point landing in the appendices reads as dangling.
assert.ok(!checkCoverage(OK.replace('L2 18:27r 3-1-aim', `L2 18:27r ${briefSections(OK).find((s) => s.heading.startsWith('APPENDIX B')).id}`))
  .some((f) => f.includes('does not exist')), 'an appendix is a placeable section');
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
assert.equal(fresh.sections.length, secs.length);
assert.equal(fresh.sections[2].heading, '§2.1 Play ranked the way you play scrims');
assert.ok(fresh.sections[2].md.includes('one build in scrims'), 'section bodies carry their content');
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

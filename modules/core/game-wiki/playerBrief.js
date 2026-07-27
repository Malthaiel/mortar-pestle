// Player Brief — what the "Generate Player Brief" button produces (replaces Process 2's JSON output).
//
// The document a coached player reads once and keeps: second person, layered for retrieval, with a
// side-monitor card for the second screen. The old analyst report was aimed at the wrong reader —
// its no-TL;DR / no-point-of-view / say-it-once rules are correct for a RECORD and fatal for a
// STUDY DOCUMENT.
//
// TARGET OF RECORD (2026-07-26, second retarget): `deadlock-coaching-notes-session-01.md` at the
// Citadel root — a Claude browser chat's output for the Arndew 07-24-26 session, produced from the
// raw segments and NOTHING else. `Infrastructure/Reference/Player Brief Reasoning Chain.txt` is that
// same chat's account of how it got there, and THE METHOD block below is that account transcribed
// into instructions. The previous target, `deadlock-coaching-notes.md`, is superseded — it is a
// flat §0–§10 document and four runs of tuning against it are now measurement history only.
//
// NO TEXTURE REFERENCE. Earlier versions pasted the target document whole as a style example. The
// browser chat had no example, so keeping one is an unfaithful reproduction — and the target was
// written from the very session the app is tested on, so pasting it lets the model copy the answers
// instead of doing the work. The METHOD, TEMPLATE and TYPOGRAPHY blocks carry the shape instead.
//
// The model emits MARKDOWN, not JSON. Markdown authored inside JSON strings is measurably stiffer —
// the model fills fields instead of writing a document, so it cannot feel where a table beats prose
// or where a short sentence should land.
//
// The old `.matchfinal.Match N.json` still gets written, but as a PROJECTION of the brief
// (briefToFinal) rather than a competing artifact — no second billed call. That keeps the
// Carry-Forward export, Team Progress and cross-session homework carry-over fed with zero changes
// to their code; they only ever read `sections`, `actionItems` and `carry`.
import { parseOrRetry } from './aiRetry.js';
import {
  buildTranscriptBlock, slugId, coerceReport, splitProseText, REPORT_SCHEMA_VERSION,
} from './vodReport.js';

export { buildTranscriptBlock };

// ── the system prompt ────────────────────────────────────────────────────────
export const PLAYER_BRIEF_SYSTEM_PROMPT = `You write the study document a coached Deadlock player keeps after a coaching session. You are given a
review transcript (speaker-labeled, timestamped [m:ss]) and a canonical name list. That is the whole
input. The document is built from the session and nothing else.

THE READER IS THE PLAYER WHO WAS COACHED — not the coach, not an analyst. They read it once, properly,
and then only ever return to the compressed layers.

THE STANDARD: the player reads this once and never needs the recording again. It should be absorbable
enough that someone handed it an hour before the exam that decides everything passes that exam. Use
real note-taking structure, not a summary. Cut the fluff; pure information only.

OUTPUT: the finished markdown document and nothing else. No JSON, no wrapping code fence, no preamble,
no closing commentary. Follow the TEMPLATE and TYPOGRAPHY blocks exactly.

=== THE ONE HARD RULE ===
Report ONLY what the coach said or showed. Never add a tip, reason, example, number or coaching point
the coach did not voice — even when correct, even when it would obviously help, even when the material
begs for it. You organize, compress, order and sharpen the session. You never extend it.
Second person and a confident instructional voice make an invented point read exactly like a taught
one, and there is no provenance tag on the page to protect the reader. Unsure whether the coach said
it → it does not go in.
The canonical name list is grounding ONLY: correct spelling of heroes, items and abilities. Never
surface a fact from it as its own point.

=== THE METHOD — WORK THESE FIVE STEPS IN ORDER, BEFORE AND WHILE YOU WRITE ===

STEP 1 — FIX THE AUDIENCE, THEN NAME THE FAILURE MODE.
The reader is the player, and they read once. That single constraint drives everything: no "we
discussed", no session narration that leans on remembering the conversation, no point that needs
context you are not putting on the page. Every point is rewritten as a standalone imperative that
survives without the recording.
The failure you are designing against is NOT "the notes are incomplete". It is "the notes are complete
but unusable". An hour of transcript flattened into bullets is a wall. The architecture below solves
RETRIEVAL, not just storage. Build it to be re-entered, not re-read.

STEP 2 — EXHAUSTIVE EXTRACTION PASS BEFORE ANY WRITING.
Go through the transcript end to end and catalogue every distinct claim into these eight buckets,
without organizing yet:
  1. THE PLAYER'S SELF-DIAGNOSIS — every complaint they walked in with, in their own words
  2. THE COACH'S RULINGS — every do and every don't
  3. THE COACH'S REASONING for those rulings
  4. HARD NUMBERS — durations, costs, thresholds, counts, timings
  5. NAMED ENTITIES — people, published builds, guides, sources
  6. ANECDOTES that carry a transferable principle
  7. DEFERRALS — anything explicitly shelved, parked, or pushed to a later session
  8. META-INSTRUCTIONS — habits the coach asked the player to adopt about practising itself
CRITICALLY, SEPARATE THE RULING FROM ITS RATIONALE. Rulings go in the compressed layers (§1, the card,
the self-test). Rationale goes in the body. That separation is the entire reason one document can be
read at three different depths, and skipping it is what produces a wall.
A point voiced ONCE, in one sentence, never repeated, counts exactly as much as one argued for ten
minutes — the single-mention point is the one most likely to be lost, and losing a voiced point is a
DEFECT, not an acceptable limit of recall. Prose economy decides how a point is written, never whether
it is kept. Every item in your catalogue lands somewhere in the document.

STEP 3 — REPAIR THE DIARIZATION BEFORE YOU TRUST A SINGLE LABEL.
The speaker labels are machine-generated and wrong. Automatic diarization FRAGMENTS ONE PERSON across
several labels: "Speaker 1", "Speaker 2", "Speaker 3", "Speaker 4", "Speaker 6" are very often all the
same human. Verify by content continuity — if Speaker 1 opens a complaint and Speaker 2
continues the same sentence structure and the same complaint, they are one person.
There are normally exactly TWO people in the room: the COACH (the voice answering questions, giving
rulings and directing the review — usually the only label carrying a real name) and the PLAYER
(everyone else). Collapse every player label into a single "you".
Without this repair the notes read as a group session and the second-person voice collapses. Do it
first; every other step depends on knowing who said what.

STEP 4 — APPLY THESE TEN STRUCTURAL TECHNIQUES. Each has a job. None is decoration.
 1. PROGRESSIVE DISCLOSURE, THREE LAYERS — §1 The Ten Laws, then the body, then the side-monitor card.
    Encoding requires depth; retrieval requires compression. Serving both from one document requires
    LAYERING, never a compromise between them.
 2. NUMBERED ATOMIC LAWS in §1. They give every later section a referent: "This is Law 2 applied"
    costs five words instead of re-explaining the whole idea. Cross-reference them by number in the
    body wherever a section is an instance of one.
 3. CONDITIONAL AND PROCEDURAL FRAMING — "if X → do Y" tables and numbered procedures. Declarative
    knowledge does not transfer under pressure; conditional knowledge does. Turning "there are three
    builds for this hero" into a lookup table is the single highest-value transformation available to
    you. Do it everywhere a branch exists.
 4. A CORNELL-DERIVED CUE COLUMN — the self-test, question left, answer right. Active recall beats
    re-reading by a wide margin. THIS is what makes "read once" literally true: the test replaces the
    re-read.
 5. ELABORATIVE INTERROGATION — every ruling carries its why. Rules without reasons decay in days.
    Rules with reasons generalize to situations the session never covered.
 6. SYMPTOM-TO-CAUSE LINKING, marked ⚠. Where several of the player's separate complaints resolve to
    ONE underlying fix, say so at each of them. Collapsing three problems into one thing to practise
    is worth more than three separate fixes, and the reader cannot see the link on their own.
 7. AN ISOLATED NUMBER APPENDIX. Numbers are the highest-value, lowest-density content in a
    transcript. They deserve extraction into a table of their own.
 8. A COVERAGE AUDIT TABLE. "Nothing was lost" has to be VERIFIABLE, not asserted. Every complaint the
    player walked in with maps to the section that answers it, so the reader can check the work.
 9. EXPLICIT NEGATIVE SPACE — a section for what NOT to do yet. It is as actionable as what to do, and
    it is the first thing dropped when someone summarizes.
10. SELECTIVE VERBATIM PRESERVATION. Keep the coach's exact words ONLY where the phrasing IS the
    payload — a coined phrase, an insult that lands, a rule stated memorably. Paraphrase kills
    memorability there. Everywhere else, paraphrase; a document of quotes is a transcript.

STEP 5 — MAKE THESE JUDGMENT CALLS THE SAME WAY EVERY TIME.
- ELEVATE THE CARD TO A FIRST-CLASS ARTIFACT. Where the coach identifies APPLICATION, not knowledge,
  as the real bottleneck, a document that only adds knowledge has missed the point. The card is a
  copy-pasteable block for exactly that reason, and it gets its own PART.
- KEEP MINDSET MATERIAL AT FULL WEIGHT. It is easy to cut as "soft". It is load-bearing: the rank
  paradox and the bad-teammate law are prerequisites for the macro advice landing at all. If a third
  of the session was psychological, a third of the body is psychological.
- KEEP TRANSCRIPTION AMBIGUITIES INTACT RATHER THAN SILENTLY CORRECTING THEM. Where a name or term is
  garbled, render your best reading and do NOT assert game mechanics beyond what the coach said. Where
  you are unsure, attribute it to him rather than stating it as fact.
- RECORD THE PLAYER'S OWN STATED LOGIC, even where the coach did not critique it. It becomes the
  baseline they audit themselves against next session.
- ORDER THE HERO SECTIONS BY DEPTH OF COVERAGE, DESCENDING — never transcript order. The reader
  front-loads the densest material while still fresh.

=== VOICE ===
Address the player as "you". Direct, plain, second person.
- Instructions are imperative: "<Do this.>" "<Give that up.>" "<Never do X — do Y instead.>"
- Diagnoses are second person: "You don't check whether <the item> is actually stacking."
- Never "the player", "he", "his", or a role descriptor as a stand-in for the reader. If you do not
  know their name, that costs nothing — "you" needs no name.
- THE COACH IS NAMED AS AN AUTHORITY, NOT AS A NARRATOR. "Coach: same as his." "Coach's reaction: this
  is the win condition." "Coach ground to the top rank specifically to get noticed by teams." All
  correct — authorship changes what the claim is worth. What is banned is narrating the MECHANICS of the
  conversation: not "the coach then explained", not "he asked for one build per hero", not "later in
  the session". State the lesson; cite the coach where the credential is the point.
- ATTRIBUTE TO THE PLAYER when the player raised it — a self-diagnosis, a proposal, a correct read they
  reached unprompted. "Your own words, and they are the correct diagnosis" tells them which instincts
  to trust, which is worth more than the same point delivered as instruction.

=== SECTION ORDER ===
By what the player must fix first, never by session chronology. The PARTS run:
  MINDSET & RANK      — the frame everything else sits inside. First whenever the session taught it,
                        because the hero advice means something different inside it.
  MACRO               — map, trades, closing games. Before the heroes: it applies to all of them.
  HERO PLAYBOOKS      — one section per hero in the pool, ordered by depth of coverage, descending.
  MECHANICS           — aim, movement, execution.
  WHAT NOT TO DO YET  — the negative space.
  THE APPLICATION SYSTEM — the card, then the self-test.
Then the appendices. A PART with no material is OMITTED entirely and the rest renumber; never invent
one to fill the shape.

=== HOW A SECTION IS BUILT ===
- A rule ALWAYS carries its mechanism. "<Don't do X>" is forgotten under pressure; "<doing X is what
  the enemy team is playing for>" survives, because the reader can regenerate the rule from the reason. Never state an instruction whose "why" the coach gave and you dropped.
- Any diagnosed habit is a THREE-PART correction, in order: what you do now → what it costs → the
  replacement rule. All three from the session. A diagnosis with no replacement rule is half a lesson.
- Conditional material becomes a TABLE: first column the states, second what to do. Never prose out a
  branch the reader must re-derive mid-game.
- NEVER compress a taught framework. Every step the coach laid out, in order, complete.
- A live worked example — a build walked item by item, a positioning example, a draft read — is
  reproduced in full, tabled where it fits a table. Label it "**Worked example**" where it stands alone.
- ⚠ MARKS THE TRAP. Use it at three places and nowhere else: a habit the player specifically falls
  into, a complaint of theirs that this section resolves ("⚠ **This resolves your stated problem** —"),
  and a leak that shows up somewhere they did not expect it. Never as a general warning.
- No inline timestamps. The player is not clicking anything. Stamps live in the machine block.

=== §1 — THE TEN LAWS ===
EXACTLY TEN numbered lines, before any PART. The whole session compressed. Ordered by what matters
most, NOT by when it came up. Assume this is the only part ever re-read.

SHAPE — every line is TWO parts and the split is not optional:
  N. **<The rule, bolded, as a complete imperative or claim.>** <The mechanism, cost or number that
     makes it stick — unbolded.>
The reader must be able to read ONLY the bold across all ten lines and come away with the session. The
unbolded half is what makes the bold half survive Monday. A line with no bold is a failure; so is a
line that is entirely bold. A topic label is a failure too — "<Topic>" is not a line, "<If you are
doing X, the enemy already won that fight>" is.
Where a hero owns the line, name the hero in it: "**<HERO>'s default position is <where>, <doing what>,
ready to <move>.**"
ONE LINE PER THEME. A rule and its corollaries share a line; two different findings never do.

DIAGNOSTIC, NOT A CAP: in the target document the bolded lead runs about 10 words and the unbolded
half about 9. Lines range 5–14 words of lead and 6–18 of tail. Vary them deliberately — ten lines all
sitting at the same length scan as a wall however good each one is. NO WORD CAP: a line runs as long as
its mechanism needs and not one word longer, and no mechanism is ever deleted to move a number.

TEN IS THE COUNT, NOT A CEILING TO APPROACH. If you have eleven candidates, the weakest RELEGATES to
the section that owns it — never weld it onto a neighbour, which doubles that line's unbolded half and
is the classic failure of this section. If you have nine, a theme you demoted was actually a law.
Nothing appears here that appears nowhere else.

=== THE SIDE-MONITOR CARD ===
Not a homework list at the bottom — the thing that goes on the second monitor and is read mid-game.
It gets a short prose preamble (the method, why it works, the coach's own use of it) and then the
block itself.
- Imperative, first person or bare: "<ITEM>. Always." "<That ability> is NOT for me." Never "Ensure
  <ITEM> is purchased."
- Under a second to read, each line.
- Grouped, CAPS labels, blank line between groups: a queue/every-game group, one group per broad skill
  the session taught, one per hero, and a closing group.
- Carries no explanation. The sections explain.
- One line per behavior; merge near-identical asks. Around 19 lines across all groups.
- Every line is something the coach actually told this player to do.
- Tell the reader to keep it short and rotate items off as they become automatic.
- If the session asked for a focus list, note sheet, or anything of the kind: THIS IS THAT ARTIFACT.
  Produce it. Never write a line saying it has not been produced yet.
- IF THE COACH DEFERRED WORK OR OWES THE PLAYER SOMETHING, it is one italic line immediately after the
  card block, in brackets-free prose: "*Coach is separately producing (a) …, and (b) …*". One line, no
  heading, no table. If he deferred nothing and owes nothing, the card block ends the PART.

=== THE SELF-TEST ===
A two-column table, question left, answer right, headed "| Q | A |". Retrieval, not review: the answer
RESTATES, never re-explains.
- Open with one line telling the reader to cover the right column, and that answering all of them
  means never re-reading the document.
- ONE ROW PER THING THAT CHANGES A DECISION MID-GAME: a rule they must apply, a named counter, a
  threshold that gates a choice, a number worth knowing cold. About 40 rows for a full session — a
  table row costs a second to read, which is why 40 works here and would not work as numbered prose.
- MERGE CLUSTERED NUMBERS into one row. "<HERO> ult: three numbers?" carries all three, never three rows.
- NEVER QUIZ THEM ON THEMSELVES. "How many games do you have on this hero" tests nothing they will use.
- One correct answer each. Nothing open-ended.
- Order follows document order.

=== WHAT NOT TO DO YET ===
Its own PART, near the end. One line of framing, then a two-column table: the thing, and the ruling.
- Everything the coach explicitly deprioritized, shelved, or pushed to a later session.
- A shelved hero goes here with the coach's reason — never stranded, never merely absent.
- Use ❌ for a hard no and ⏸ for something deferred rather than rejected.
- Close the PART with the coach's overall read on the player, as blockquotes, then one bolded line
  naming the real bottleneck the card exists to fix.

=== THE APPENDICES ===
- APPENDIX A — Numbers. A two-column table: the number in bold, what it means. Every hard number in
  the document. Omit the appendix only if the session produced none.
- APPENDIX B — the coverage audit, always present. Two columns: what the player said, and where it is
  answered. One row per complaint, question or worry they raised, quoted short in their own words,
  pointing at the section by number. Open with one line stating that nothing was dropped. THIS IS THE
  PROOF THE DOCUMENT IS COMPLETE — build it from bucket 1 of your extraction pass, and if a row has
  nowhere to point, you left something out. Go back and place it.
- APPENDIX C — Glossary of names dropped. Two columns: the name, what it is. Every person, published
  build, guide or piece of jargon the session mentioned in passing. Omit if the session named none.

=== REPETITION IS THE DESIGN ===
A point may appear at FOUR resolutions: once as a Law, once developed in its section, once as a card
line, once as a test row. That is not duplication — it is how the point survives the week. Still
forbidden: EXPLAINING the same thing twice at the same depth. The Laws compress, the section explains,
the card commands, the test checks. Four jobs, one point, no re-argument.

=== HOUSE STYLE ===
- PLAIN WORDS. Every sentence lands on the first read. "works with" not "synergises with", "adds up"
  not "accumulates", "money" not "econ". Game terms stay EXACT and untranslated — hero, item, ability,
  map and objective names are precise and the reader knows them.
- KEEP THEIR SHORTHAND, IN BALANCE. Any abbreviation the coach or the player uses stays available in
  the form they say it: "MM", "mid-boss". But the target document runs the short and long forms at
  roughly ONE TO ONE — "MM" six times, "matchmaking" six times — and prefers the SPELLED form for a
  rank or title, about five uses to two. Neither form dominates. Spell it out in a
  heading the reader scans cold and on first use; use the short form in running prose and on the card.
- THE READER WAS THERE. State the finding; do not rebuild the evidence for it. They know their own
  job, schedule, rank history and what they said an hour ago. Echo their own words where the wording
  IS the lesson — a coined phrase, a self-diagnosis you are confirming as correct, or a complaint you
  are answering directly. That echo is frequent and deliberate in this document; what is banned is
  replaying their circumstances back at them as support for a point.
- ACTIVE VOICE. "Sensitivity is fine", never "sensitivity was checked and found not to be an issue".
- 35 WORDS PER SENTENCE, hard ceiling. Sentences average about 9 words in the target and the median is
  8. A sentence chaining two events or two reasons is two sentences; the colon or dash joining them is
  the split.
- Prose economy is TIME-TO-ABSORB, not word count. The target document runs about 5,750 reader-facing
  words. Delete-test every word: if nothing is lost in meaning AND nothing in flow, cut it. Density,
  never fewer points.
- Never narrate your own reasoning or uncertainty. State the settled thing.
- Canonical names ONLY, matching the name list exactly.

=== ABSENT DATA CHANGES NOTHING ===
This document is built from the session. Never write about data you were not given, never note its
absence, never leave a section thin because more data would have thickened it.

=== SELF-CHECK BEFORE EMITTING ===
Read your draft once against this list and fix what fails. Do not report the check; just fix and emit.
1. Every speaker label resolved: the document contains exactly one coach and one "you", and no
   "Speaker N" survives anywhere.
2. Exactly ten Laws, each with a bolded rule AND an unbolded mechanism, and reading only the bold
   gives the session.
3. Every diagnosed habit has a replacement rule, and every rule that had a stated "why" carries it.
4. Every complaint the player raised has a row in the coverage appendix, and every row points at a
   section that exists. If one has nowhere to point, the point was dropped — go place it.
5. Every self-test row is one the player could act on mid-game, and the answer restates rather than
   re-explains.
6. Zero third-person references to the reader; zero narration of the conversation's mechanics.
7. Every taught framework has all its steps, and every worked example is reproduced in full.
8. Every card line is under a second to read and appears in no other card group.
9. Nothing in the document was not in the transcript.
10. The template's fixed strings are present and exact, the notation key matches the marks you
    actually used, and the only pictographic marks anywhere are ⚠ ✅ ❌ ⏸.
11. Count your devices outside the self-test and land INSIDE the bands, over as well as under:
    "→" 28-44 · "⚠" 8-16 · "=" 7-14 · "+" 12-22 · em dash 90-125 · parenthetical glosses 34-52 ·
    bold spans 175-235 · blockquotes 7-12 · tables 13-21 · "#"-marked numbers 9-16. Under a band means
    prose is doing a device's job; over means the device stopped marking anything.
12. The short and long form of every abbreviation both appear, at roughly one to one.`;

// ── the document template ────────────────────────────────────────────────────
// These strings are FIXED — the model does not re-decide them. checkTemplate asserts them, which
// removes a surprising amount of run-to-run variance at zero cost. The old separate SKELETON block
// was folded in here: two blocks describing one shape drifted apart on every edit.
export const BRIEF_TEMPLATE = `=== TEMPLATE — the shape of the document. Angle brackets are slots you fill; everything else is
literal and must appear exactly as written. ===

# Deadlock Coaching Notes — Session <NN>

**Coach:** <NAME><  (<rank>)> · **Format:** <one clause naming the session's format> · **Runtime:** ~<N> min
**Your focus heroes going forward:** <HERO> · <HERO> · <HERO> — *nothing else for now.*

---

## §0 — How to use this document

Read top to bottom **once**. Then you only ever need three things again:

| If you want… | Go to |
|---|---|
| The whole session compressed | **§1 — The Ten Laws** |
| The thing you keep open on monitor 2 while queuing | **§<C> — Side-Monitor Card** |
| To prove to yourself you actually absorbed it | **§<T> — Self-Test** |

Everything else (§2–§<L>) is the reasoning *behind* the laws. Read it once so the laws aren't arbitrary; after that they stand on their own.

Notation used throughout:
- **→** means "therefore / do this"
- **⚠** = a trap you specifically fall into
- **#** = a hard number worth memorizing
- *Italics* = coach's exact framing, preserved because the phrasing is the point

---

## §1 — The Ten Laws (the entire session, compressed)

1. **<Rule, imperative or claim.>** <The mechanism, cost or number that makes it stick.>
2. **<Rule.>** <Mechanism.>
   … exactly ten, ordered by importance, NOT one per section …

---

# PART I — MINDSET & RANK

## §2.1 <Title Case heading>

> *"<the coach's own framing, where the phrasing is the payload>"*

- <claim, with its reason attached>
- **<Bolded key term>:** <what follows from it>

## §2.2 <Heading>
   … one §2.N per distinct mindset topic …

---

# PART II — MACRO

## §3.1 <The principle answering the player's biggest self-diagnosed leak> *(<why it matters>)*

**The recurring scenario you described:**
> <the scenario, in their terms>

**The math:**

| Option | Value |
|---|---|
| <the tempting thing> | ~#<N> <units> |
| <the correct thing> | <what it actually buys> |

→ **<The ruling.>** <The consequence.>

⚠ <where this same leak shows up somewhere they did not expect>

## §3.2 <The procedure for the recurring endgame scenario>

**The procedure:**

1. **<step>**
2. **<step>**
3. **<step>**

**The reframe, explicitly:**

| Stop thinking | Start thinking |
|---|---|
| *"<the wrong internal monologue>"* | *"<the right one>"* |

---

# PART III — HERO PLAYBOOKS

## §4 — <HERO A, CAPS>   ← the most deeply covered hero comes first

### 4.1 Role identity
### 4.2 Positioning by game phase

| Phase | Where you are |
|---|---|

### 4.3 <The ability the session worked on> — <the discipline rule>
### 4.4 The combo
### 4.5 Build rules

| Build | Verdict |
|---|---|
| <archetype> | ✅ Valid |
| **<the banned archetype>** | ❌ **Never.** <the reason, with the coach's phrase if he coined one> |

### 4.6 Your existing build — coach's audit

## §5 — <HERO B, CAPS>
## §6 — <HERO C, CAPS>   ← the thinly-covered hero: a handful of short subsections

---

# PART IV — MECHANICS

## §7.1 <Mechanic A>

**Coach credential:** <the admission or credential that makes the advice land>
**Your symptom:** <the player's own description>

### <The headline instruction, as a heading>
### <The comparison that carries it>
> *<the memorable line, verbatim>*

**Worked example (<name>).** <the anecdote, ending in the transferable rule>

### <The thing audited and found fine — say so explicitly>

---

## §7.2 <Mechanic B>

### The priority verdict — read this before you spend another minute on <it>

\`\`\`
1. <highest priority>
2. <…>
   ────────────────────────────────
5. <the thing the player over-values>          ← you are not here
\`\`\`

### The one <mechanic> thing that *does* matter: **<the habit>**

---

# PART V — WHAT NOT TO DO YET

<One line of framing.>

| Item | Ruling |
|---|---|
| **<thing>** | ❌ <ruling, with the coach's reason> |
| **<deferred thing>** | ⏸ Deferred to a future session. <what stands in until then> |

**Coach's overall read on you:**
> *"<verbatim>"*

**<The real bottleneck, bolded.>** Which is why §<C> exists.

---

# PART VI — THE APPLICATION SYSTEM

## §<C> — Side-Monitor Card

**The method (<how the coach uses it himself>):**
<the method, two or three sentences>

**Why:** <the mechanism — why theory evaporates and the card bridges it>

**Keep this list short. Rotate items off as they become automatic.**

---

\`\`\`
┌─ CURRENT FOCUS ────────────────────────────────┐

  <GROUP LABEL, CAPS>
  □ <item>
  □ <item>

  <GROUP LABEL, CAPS>
  □ <item>

└────────────────────────────────────────────────┘
\`\`\`

<*One italic line naming work the coach deferred or owes — only if either exists.*>

---

## §<T> — Self-Test

Cover the right column. If you can answer all of these, you never need to re-read this document.

| Q | A |
|---|---|
| <question> | <answer, restating not re-explaining> |
   … about 40 rows, in document order …

---

# APPENDIX A — Numbers

| # | Meaning |
|---|---|
| **<N>** | <what it is> |

---

# APPENDIX B — Your intake list → where it's answered

Everything you raised at the top of the session, mapped. Nothing was dropped.

| You said | Answered in |
|---|---|
| "<their words, short>" | §<N> — <the answer in one clause, where a pointer alone is not enough> |

---

# APPENDIX C — Glossary of names dropped

| Name | What it is |
|---|---|
| **<name>** | <what it is and why it came up> |

<machine block, see the MACHINE BLOCK instruction below>

FIXED ELEMENTS, VERBATIM: the "**Coach:**" and "**Your focus heroes going forward:**" header lines;
"— How to use this document"; the "Notation used throughout:" key and its four bullets; "— The Ten
Laws"; "— WHAT NOT TO DO YET"; "— THE APPLICATION SYSTEM"; "— Side-Monitor Card"; "— Self-Test";
"# APPENDIX B —"; the "┌─ CURRENT FOCUS" and "└" rules bounding the card; "---" between top-level
sections.

NUMBERING: § numbers run sequentially through the document. §0 and §1 are fixed. Each PART then takes
the next number and splits it — §2.1, §2.2 for the first PART, §3.1, §3.2 for the second. THE HERO PART
IS THE EXCEPTION: each hero takes a whole § of its own (§4, §5, §6) with "### 4.1"-style subheadings.
WHAT NOT TO DO YET carries no § at all. The card and the self-test take the last two § numbers.
A PART with no material is OMITTED and everything after it renumbers.

HEADING GRAMMAR: PARTS and appendices are "# PART <ROMAN> — HEADING IN CAPS" and "# APPENDIX <L> —
Title". Sections are "## §N.N <Title Case>" or, for heroes, "## §N — <HERO IN CAPS>". Subheadings are
"### N.N Title Case" under a hero, or a bare "### <Title Case phrase>" elsewhere.`;

// ── typography ───────────────────────────────────────────────────────────────
// PICTOGRAPHIC MARKS ARE PERMITTED IN THIS DOCUMENT, and only these four. The 2026-07-26 decision
// converting ✅/⚠️/❌ to KEEP/CHECK/CUT was reversed the same day once the browser target proved the
// marks are load-bearing: ⚠ is a declared notation carrying symptom-to-cause linking with no word
// equivalent that keeps the scan property. checkTemplate now allows exactly these four and still
// hard-fails on any other pictograph, so a novel emoji cannot drift in behind them.
export const BRIEF_TYPOGRAPHY = `=== TYPOGRAPHY — the visual signature ===

1. FOUR PICTOGRAPHIC MARKS ARE ALLOWED, AND NO OTHERS: ⚠ ✅ ❌ ⏸. Any other emoji anywhere in the
   document is a failure.
   ⚠ — the trap the player specifically falls into, and the mark that links a symptom to its cause.
       Declared in the notation key. At line start, or opening a bolded lead: "⚠ **The trap:** …".
   ✅ — a permitted option in a verdict table. ❌ — a banned one. ⏸ — deferred rather than rejected.
       These three live in table cells and in the what-not-to-do rulings. Nowhere else.
2. EM DASHES, NOT PARENTHESES, for asides in body prose. Parentheses are for glosses and short factual
   notes: *(~18 min)*, *(you estimated ~50 games)*, "(her 2)".
3. "#" PREFIXES A NUMBER WORTH MEMORIZING — "#<N> seconds", "#<N> souls", "#<N>°". Declared in the
   notation key, used on the hard numbers in body prose, and dropped in tables and the appendix where
   the column already says the cell is a number.
4. BOLD LEAD RUNS ON INTO ITS SENTENCE. "**<The rule, bolded.>** <The number or mechanism that makes
   it stick, running straight on…>" Never a bare label with nothing after it.
5. BLOCKQUOTES CARRY THE COACH'S VERBATIM FRAMING and a section's single memorable rule. Seven to
   twelve across the document. A section can open on one.
6. TABLES ARE TWO COLUMNS BY DEFAULT. Conditionals: state → action. Verdicts: option → verdict.
   Phases: phase → job. Three columns only for a numbered decision tree.
7. A table with no meaningful header uses an EMPTY HEADER ROW ("| | |") rather than inventing labels.
8. *ITALICS* FOR THE COACH'S EXACT WORDS and for instructions to the reader. Never for emphasis; that
   is bold's job.
9. BOLD KEY TERMS INLINE on first use in a section. Once, not every recurrence. This document is
   bold-heavy by design — around 205 bolded spans — because the bold IS the skim layer.
10. CARD CHECKBOXES ARE "□", not "- [ ]". The card is a printed object, not a task list.
11. ARROWS AND EQUALS ARE THE HOUSE COMPRESSION DEVICES. Not decoration, not a last resort — they are
    the fastest way this reader parses a link between two things.
    "→" for a consequence chain ("<cause> → <effect> → <what follows on its own>"), for a priority
    ordering, for a combo ("<open> → <ability> → <finisher>"), and to introduce the ruling that falls
    out of the paragraph above it ("→ **<The ruling.>**").
    "=" for an equivalence that would otherwise need a linking phrase: "<the habit> = <the cost it
    hides>". "+" joins things used together: "<ability> + <item>", "<passive> + maxed <ability>".
    THE MECHANISM IS NOT LOST BY COMPRESSING IT — it is lost by DELETING it. "= bad habits" fails
    because it names no mechanism, not because it used "=". Write the mechanism, then compress the joint.
    TARGET DENSITY — BANDS TO LAND INSIDE, measured on the target document, whole document:
    "→" 28-44 · "⚠" 8-16 · "=" 7-14 · "+" 12-22 · em dash 90-125 · parenthetical glosses 34-52 ·
    bold spans 175-235 · blockquotes 7-12 · tables 13-21 · "#"-marked numbers 9-16.`;

// ── tie-broken heuristics ────────────────────────────────────────────────────
// Judgment calls the model would otherwise make differently every run.
export const BRIEF_HEURISTICS = `=== HEURISTICS — apply in order, stop at the first that decides ===

HERO SECTION ORDER
1. Depth of coverage, descending — the hero the session spent most words on comes first.
2. Tie: the hero the player named as a problem before the hero they named as working.
3. Tie: fewest games played first — least-formed habits, most correctable.
The thinly-covered hero still gets a full section; it is simply shorter, and it gets no Law of its own
unless the coach stated its rule twice.

WHAT GOES IN THE MINDSET PART
Include: any rule that applies to every hero; anything about rank, tilt, expectations or why to play;
the player's own psychological context where the coach responded to it; every piece of praise about
the player's approach rather than their mechanics.
Exclude: anything hero-specific, anything mechanical.
PRAISE IS A NAMED STRENGTH HANDED BACK AS AN INSTRUCTION — "this is the win condition … do not lose it
while chasing rank". Never a trailing compliment, never split across subsections because it reads
encouraging, and never two bullets of the same shape.
A DISCOURAGING FACT THE COACH ADDRESSED — a losing streak, an abandoned account, a dropped hero — goes
in the section that raised it with the coach's reassurance attached in the same breath, marked ⚠ where
it is a trap the player falls into. Never stranded.

WHAT EARNS A TABLE
- Any coach answer of the form "it depends on X" → table, states of X in column one.
- Any build audit of four or more items → table.
- Any two-way reframe (stop thinking / start thinking) → two-column table.
- Factual context about the player's account, record or history → a two-column table with an empty
  header row, so it reads as reference rather than as argument.
- Never table a sequence; taught frameworks stay numbered lists.

WHAT EARNS A BLOCKQUOTE
The coach's exact words where the phrasing is the payload, and a section's single memorable rule.
Seven to twelve across the whole document, and a section may open on one.

WHAT EARNS A FENCED BLOCK
Two per document: the priority-ordering list in the mechanics PART, and the card itself. A fenced
block says "this is an object, not prose" — use it where the shape is the point.

HOW MANY LAWS
Exactly ten. Earned by session weight, never by section count: a topic the coach worked through earns
one, a topic touched once in passing does not, however true it is. Plus weight for any rule the coach
stated twice or more. At eleven candidates, RELEGATE the weakest to its section; at nine, promote the
strongest theme you demoted.

HOW MANY SELF-TEST ROWS
One per decision the player has to make mid-game, with clustered numbers merged into single rows.
About 40 for a full session. Enumerating every fact on the page produces an exam nobody sits; stopping
at fifteen leaves the reader re-reading the body, which is the failure this table exists to prevent.

WHEN A HERO LEAVES THE POOL
Only when the coach said so. It goes in the what-not-to-do table with his reason, and the pool line
names only the heroes that stayed. Never infer a cut from the coach spending little time on a hero.

WHEN THE PLAYER'S SELF-DIAGNOSIS WAS RIGHT
Say so, in the section that owns it, before the instruction. It tells them which instincts to trust.

WHEN THE SESSION NUMBER IS UNKNOWN
It is given to you. Use it exactly as given, zero-padded to two digits.`;

// ── the machine block ────────────────────────────────────────────────────────
// The machine-readable things the JSON container was carrying, recovered as an HTML comment:
// invisible when rendered, survives copy-paste. `ledger` is the coverage mechanism and the only
// thing aimed at the failure the whole rule set did not catch — a one-sentence lesson dropped
// across a thousand transcript segments. It makes "did we lose a point" a question code can ask,
// with no second billed call. `deferred` exists because the deferred-work line has no fixed heading
// any more: it is one italic line under the card, and checkTemplate cannot tell an absent line from
// a session that deferred nothing unless the model says which happened.
export const BRIEF_MACHINE = `=== MACHINE BLOCK — the LAST thing in the document, after the final appendix ===

Emit it exactly in this shape, as an HTML comment:

<!-- brief-meta v2
player: <name or unresolved>
coach: <name>
pool: <hero>, <hero>, <hero>
deferred: <yes|no>
items: <slug>=pending; <slug>=pending; <slug>=pending
ledger: L1 12:03r 21-frame-heading; L2 18:27r 4-hero-a; L3 33:39r 71-mechanic-a; ...
-->

- deferred: "yes" if the coach deferred work or owes the player something — in which case the italic
  line under the card must be present. "no" if he deferred nothing.
- items: ONE ENTRY PER CARD LINE. The slug is the card line's text, lowercased, every run of
  non-alphanumeric characters replaced with a single "-", trimmed, capped at 60 characters. Status is
  always "pending" — the app owns the done/pending state and carries it across regenerates.
- ledger: ONE ENTRY PER POINT FROM YOUR EXTRACTION PASS: an id, the [m:ss] stamp it came from with its
  source letter, and the slug of the heading it landed under (same slug rule — a "##" section, or a
  "#" PART or appendix where that owns the text). A point you could not place still gets a line, with
  "unplaced" as its section.
- Nothing else goes in the comment. No prose, no explanation.`;

// The full system prompt: the method, then the literal blocks.
export const BRIEF_SYSTEM = [
  PLAYER_BRIEF_SYSTEM_PROMPT,
  BRIEF_TEMPLATE,
  BRIEF_TYPOGRAPHY,
  BRIEF_HEURISTICS,
  BRIEF_MACHINE,
].join('\n\n');

// ── the user prompt ──────────────────────────────────────────────────────────
// The browser chat that produced the target document was given the raw segments and nothing else.
// Matching that is the point, so the analyst brain's charter / patch digest / taught concepts /
// corrections / team pages are all gone, and so are the coach's tagged notes and any player notes —
// every one of them a route for a coaching point the coach never voiced to enter the document.
// The ONE survivor is the canonical name list, which cannot add a point: it only fixes spelling.
export function buildBriefPrompt({ transcriptBlock, lexiconBlock = '', sessionNumber = 1 }) {
  const lines = [`Session number: ${String(sessionNumber).padStart(2, '0')}.`];
  if (String(lexiconBlock).trim()) {
    lines.push('', '=== CANONICAL NAMES (spelling only — never a source of coaching points) ===',
      String(lexiconBlock).trim());
  }
  lines.push('', 'Review transcript:', transcriptBlock || '(empty transcript)');
  return lines.join('\n');
}

// The brain's LEXICON block, sliced out of the full context. Cheaper than a second reader and it
// cannot drift from what Process 1 loads, because it is the same string.
// No `m` flag on purpose: with it, `$` means end-of-LINE and the lazy body stops after one entry —
// a one-hero name list that looks exactly like a full one at the call site.
export function lexiconOnly(brainText) {
  const m = String(brainText ?? '').match(/(?:^|\n)=== LEXICON ===\n([\s\S]*?)(?=\n=== |$)/);
  return m ? m[1].trim() : '';
}

// Markdown output has no JSON to slice — the only tolerated deviation is the model wrapping the
// whole document in a fence despite being told not to. An empty body is a failure worth retrying.
export function parseBrief(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  if (!t) throw new Error('empty player brief');
  if (!/^#\s/m.test(t)) throw new Error('no markdown heading in model output');
  return t;
}

// ── document scan ────────────────────────────────────────────────────────────
// Regions no line-wise check may touch: the machine block, any fenced block (the card and the
// priority list live in them), and blockquote lines (the coach's verbatim framing is deliberately
// terse and would flag as fragments).
export function scanLines(md) {
  const out = [];
  let fence = false;
  let machine = false;
  for (const line of String(md ?? '').split('\n')) {
    if (/^\s*<!--\s*brief-meta\b/.test(line)) machine = true;
    const isFence = /^\s*```/.test(line);
    const skip = machine || fence || isFence || /^\s*>/.test(line);
    if (isFence) fence = !fence;
    out.push({ line, skip, fence: fence || isFence, machine });
    if (machine && /-->/.test(line)) machine = false;
  }
  return out;
}

// The sections, with their bodies. Used by checkProse (the `voiceless` flag is section-scoped), by
// checkCoverage (a ledger slug must resolve to one of these) and by briefToFinal.
//
// BOTH "#" AND "##" COUNT. The PART and APPENDIX headings are "#", and two of them own real text
// (what-not-to-do, and every appendix) — leaving them out made their ledger entries dangle. The
// document title is the first heading and is not a section; a PART that only introduces its "##"
// children owns no text and is dropped, so the sidecar's section list stays free of empty rows.
export function briefSections(md) {
  const out = [];
  let cur = null;
  let seenTitle = false;
  for (const { line, machine } of scanLines(md)) {
    if (machine) continue;
    const h = line.match(/^(#{1,2})\s+(.+?)\s*$/);
    if (h) {
      if (h[1] === '#' && !seenTitle) { seenTitle = true; continue; }
      cur = { id: slugId(h[2]), heading: h[2], body: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.body.push(line);
  }
  return out.map((s) => ({ ...s, body: s.body.join('\n').trim() })).filter((s) => s.body);
}

// The card's `□` lines, in order. These become the report's actionItems.
export function cardLines(md) {
  return scanLines(md)
    .filter(({ line, fence }) => fence && /^\s*□\s+\S/.test(line))
    .map(({ line }) => line.replace(/^\s*□\s+/, '').trim());
}

// ── checkTemplate ────────────────────────────────────────────────────────────
// Numbers are deliberately absent from these: a PART with no material is omitted and everything
// after it renumbers, so "§9 — Self-Test" would fail on a legitimate document. The dash-prefixed
// fragments pin the wording without pinning the count.
export const FIXED_STRINGS = [
  '**Coach:**',
  '**Your focus heroes going forward:**',
  '— How to use this document',
  'Notation used throughout:',
  '— The Ten Laws',
  '— WHAT NOT TO DO YET',
  '— THE APPLICATION SYSTEM',
  '— Side-Monitor Card',
  '— Self-Test',
  '# APPENDIX B —',
  '┌─ CURRENT FOCUS',
  '└',
  '<!-- brief-meta',
];

// Exactly four pictographs are load-bearing in the target document and are stripped before the
// catch-all test; \p{Extended_Pictographic} then covers every other pictographic codepoint and
// passes every structural character the template keeps (§ ° · – — … → ≈ ─ □ ┌ ┐ └ ┘), verified
// against the target. A blacklist of the ones we happen to have seen would catch only the phrasing
// already fixed, which is the failure this replaced.
const ALLOWED_MARKS = /[⚠✅❌⏸]️?/gu;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

export function checkTemplate(md) {
  const t = String(md ?? '');
  const flags = FIXED_STRINGS.filter((s) => !t.includes(s))
    .map((s) => `[template] missing fixed string: ${JSON.stringify(s)}`);
  for (const { line, machine } of scanLines(md)) {
    if (machine) continue;
    const hit = line.replace(ALLOWED_MARKS, '').match(EMOJI_RE);
    if (hit) {
      flags.push(`[template] emoji "${hit[0]}" — only ⚠ ✅ ❌ ⏸ are allowed: ${line.trim().slice(0, 60)}`);
      break; // one is the signal; the fix is the same for all of them
    }
  }
  // The deferred-work line has no heading of its own any more, so an absent line and a session that
  // deferred nothing look identical in the markdown. The machine block is the only thing that can
  // tell them apart — this is the regression watch-point that survived four runs. The card is the
  // LAST fenced block in the document, so the first non-empty line after it is the note or nothing.
  const meta = parseMachineBlock(md);
  if (meta.present && meta.deferred) {
    const after = (t.split('```').pop() || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    if (!/^\*[^*].*\*$/.test(after)) {
      flags.push('[template] machine block says work was deferred, but no italic line follows the card');
    }
  }
  return flags;
}

// ── checkProse ───────────────────────────────────────────────────────────────
// The FREE half of the wording rules: the prompt states the voice, this proves it landed, with no
// second paid pass. Flags are advisory strings, capped so a drifting run cannot wall the warnings
// box. Second person is correct here and its ABSENCE is the defect.
const PROSE_MAX_WORDS = 35;
const PROSE_MAX_FLAGS = 8;
const PROSE_MAX_PER_PART = 2;
// Rule breaches before cosmetics. `distance` first: a third-person reference is what most visibly
// marks the document as machine-written, and it is the rule this whole artifact exists to invert.
const PROSE_RANK = ['distance', 'voiceless', 'narration', 'label', 'length', 'fancy', 'passive'];
// Regex, not substring: the old list held the literal `off-meta` while the live report shipped "very
// off meta" four times. THREE ENTRIES WERE REMOVED 2026-07-26 because the target document uses them
// and a checker that fights the reference is noise: `off-meta` (a game term the coach says out loud),
// `synergi[sz]` and `infinitely more` (both inside verbatim coach quotes, where changing the words
// would be putting words in his mouth).
const PROSE_FANCY = [
  /\bas a side effect\b/i, /\bprioriti[sz]/i, /\baccumulat/i,
  /\bcompromised position\b/i, /\bin terms of\b/i, /\bessentially\b/i,
];
const PROSE_DISTANCE = [/\bthe player\b/i, /\bthe \w+ player\b/i, /\bthe coached\b/i, /\bSpeaker \d+/];
// Narrating the MECHANICS of the conversation. Naming the coach is not narration — the target does it
// constantly ("Coach's reaction:", "Coach: same as his") because authorship changes what a claim is
// worth. What is banned is the play-by-play.
const PROSE_NARRATION = [/\bthe coach then\b/i, /\bhe asked\b/i, /\bwas requested\b/i, /\bagreed on the spot\b/i, /\b(?:during|later in|earlier in) the session\b/i];
const PROSE_PASSIVE = /\b(?:was|were)\s+\w+(?:ed|en)\b/i;
// Sections whose shape makes the voice checks meaningless: the card is a fenced block of fragments,
// the self-test is question/answer pairs, and the appendices are lookup tables.
const VOICE_EXEMPT = /Side-Monitor Card|Self-Test|APPENDIX/i;

export function checkProse(md) {
  const found = [];
  const add = (where, kind, msg) => found.push({ where, kind, msg });
  let overLong = 0;
  for (const sec of briefSections(md)) {
    const where = `section "${sec.heading}"`;
    // The card, the self-test and the appendices are lookup surfaces, not prose. Their one-line
    // preambles are terse and often passive by design — the template's own "Nothing was dropped."
    // is the case in point, and a checker that fights the reference document is noise.
    const exempt = VOICE_EXEMPT.test(sec.heading);
    const rows = sec.body.split('\n').filter((l) => l.trim());
    const mostlyTable = rows.length > 2 && rows.filter((l) => l.trimStart().startsWith('|')).length / rows.length > 0.6;
    // Section-scoped: a body with no second person at all has drifted back to labelled-fact, the
    // exact failure this document exists to fix. A reference table (account history, a glossary) is
    // legitimately voiceless, so a body that is mostly table rows is exempt.
    if (!exempt && !mostlyTable && sec.body.split(/\s+/).length > 25
        && !/\b(?:you|your|yours)\b/i.test(sec.body)) {
      add(where, 'voiceless', 'no second person anywhere in this section — it has drifted back to labelled fact');
    }
    for (const { line, skip } of scanLines(sec.body)) {
      if (skip || !line.trim() || line.trimStart().startsWith('#')) continue;
      // A bolded lead that is a BARE LABEL: a short bold with nothing after it, or with nothing but
      // ANOTHER bolded label after it — a machine index rendering as reader-facing content.
      // NOT flagged: a colon lead carrying real content, which the template ships deliberately
      // (`**Why:** <mechanism>`). Content after the lead is the property that matters, not the
      // punctuation before it. The bullet prefix accepts `1.` as well as `-`/`*`: the Laws are a
      // numbered list and "a topic label is a failure" is the rule §1 exists to enforce.
      if (!line.includes('|')) {
        const lead = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?(?:[⚠✅❌⏸]\s*)?\*\*(.+?)\*\*\s*(.*)$/);
        const rest = lead ? lead[2].trim() : '';
        if (lead && lead[1].trim().split(/\s+/).length < 4 && (!rest || /^[-*]?\s*\*\*/.test(rest))) {
          add(where, 'label', `bare bolded label "${lead[1]}" — the lead must run on into its sentence`);
        }
      }
      for (const re of PROSE_DISTANCE) {
        if (re.test(line) && !/coach|Malthaiel/i.test(line)) { add(where, 'distance', 'third-person reference to the reader — the reader is "you"'); break; }
      }
      for (const re of PROSE_NARRATION) {
        if (re.test(line)) { add(where, 'narration', 'narrates the conversation — state the lesson, not the play-by-play'); break; }
      }
      for (const re of PROSE_FANCY) {
        if (re.test(line)) { add(where, 'fancy', `fancy wording "${line.match(re)[0]}" — use the plain word`); break; }
      }
      // The bolded lead closes AFTER its full stop ("…most of the way there.**"), so a plain
      // (?<=[.!?])\s+ split never fires there and glues the lead onto the next sentence.
      for (const sentence of line.split(/(?<=[.!?])[*_"')\]]*\s+/)) {
        const s = sentence.trim();
        if (!s) continue;
        if (s.split(/\s+/).length > PROSE_MAX_WORDS) { overLong++; add(where, 'length', `${s.split(/\s+/).length}-word sentence — split it`); continue; }
        if (!exempt && PROSE_PASSIVE.test(s)) add(where, 'passive', `passive voice ("${s.match(PROSE_PASSIVE)[0]}") — write it active`);
      }
    }
  }
  const flags = [];
  const perPart = new Map();
  for (const f of found.sort((a, b) => PROSE_RANK.indexOf(a.kind) - PROSE_RANK.indexOf(b.kind))) {
    if (flags.length >= PROSE_MAX_FLAGS) break;
    const n = perPart.get(f.where) || 0;
    if (n >= PROSE_MAX_PER_PART) continue;
    perPart.set(f.where, n + 1);
    flags.push(`[style] ${f.where}: ${f.msg}`);
  }
  // Totals past the cap: a run with 25 over-limit sentences must not read as a handful of nits.
  const distance = found.filter((f) => f.kind === 'distance').length;
  if (distance) flags.push(`[style] ${distance} third-person reference${distance > 1 ? 's' : ''} to the reader`);
  if (overLong) flags.push(`[style] ${overLong} sentence${overLong > 1 ? 's' : ''} over ${PROSE_MAX_WORDS} words`);
  return flags;
}

// ── device density ───────────────────────────────────────────────────────────
// The prompt states bands; this proves they landed, with no second paid pass. Measured on
// `deadlock-coaching-notes-session-01.md` (Citadel root) — the actual counts are in the comment
// beside each band, so a future retarget can see what moved. Advisory: a band miss is a texture
// drift, never a reason to reject a document that covered the session.
export const DEVICE_BANDS = [
  ['→', /→/g, 28, 44], //  target 35
  ['⚠', /⚠/g, 8, 16], //  target 12
  ['=', /(?<![|`=])=(?!=)/g, 7, 14], //  target 10
  ['+', /(?<!\w)\+(?!\w)/g, 12, 22], //  target 17
  ['em dash', /—/g, 90, 125], //  target 108
  ['parenthetical glosses', /\([^)]*\)/g, 34, 52], //  target 43
  ['bold spans', /\*\*[^*]+\*\*/g, 175, 235], //  target 205
  ['blockquotes', /(?:^> .*\n)+/gm, 7, 12], //  target 9
  ['tables', /^\|[-: |]+\|$/gm, 13, 21], //  target 17
  ['"#"-marked numbers', /#\d/g, 9, 16], //  target 12
];

export function checkDevices(md) {
  const body = String(md ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const [name, re, lo, hi] of DEVICE_BANDS) {
    const n = (body.match(re) || []).length;
    if (n < lo) out.push(`[density] ${name} ${n}, band ${lo}-${hi} — prose is doing a device's job`);
    else if (n > hi) out.push(`[density] ${name} ${n}, band ${lo}-${hi} — the device stopped marking anything`);
  }
  return out;
}

// The 35-word ceiling with teeth in code, not only in the prompt. Same timid splitter the analyst
// report uses (one shared implementation, so the two can never disagree about what a safe join is),
// refusing the machine block and the fenced blocks on top of its usual refusals.
export function splitBriefSentences(md) {
  const skip = new Set(scanLines(md).map(({ skip: s }, i) => (s ? i : -1)).filter((i) => i >= 0));
  return splitProseText(md, (_line, i) => skip.has(i));
}

// ── machine block ────────────────────────────────────────────────────────────
export function parseMachineBlock(md) {
  const m = String(md ?? '').match(/<!--\s*brief-meta[^\n]*\n([\s\S]*?)-->/);
  const out = { player: '', coach: '', pool: [], deferred: false, items: [], ledger: [], present: !!m };
  if (!m) return out;
  for (const raw of m[1].split('\n')) {
    const kv = raw.match(/^\s*(player|coach|pool|deferred|items|ledger)\s*:\s*(.*)$/i);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === 'player' || key === 'coach') out[key] = val;
    else if (key === 'deferred') out.deferred = /^y(es)?|true$/i.test(val);
    else if (key === 'pool') out.pool = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'items') {
      out.items = val.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [slug, status] = s.split('=');
        return { slug: String(slug || '').trim(), status: String(status || 'pending').trim() === 'done' ? 'done' : 'pending' };
      }).filter((it) => it.slug);
    } else if (key === 'ledger') {
      out.ledger = val.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
        const p = s.match(/^(\S+)\s+(\S+)\s+(\S+)$/);
        return p ? { id: p[1], stamp: p[2], section: p[3] } : { id: '', stamp: '', section: s };
      });
    }
  }
  return out;
}

// The coverage check: the only mechanism aimed at a point being silently dropped. Every ledger
// entry must name a real section (or admit it is unplaced), and every card line the model listed
// must actually appear on the card.
export function checkCoverage(md, meta = null) {
  const m = meta || parseMachineBlock(md);
  const flags = [];
  if (!m.present) return ['[coverage] no machine block — coverage cannot be checked'];
  const sections = new Set(briefSections(md).map((s) => s.id));
  const unplaced = m.ledger.filter((l) => l.section === 'unplaced');
  const dangling = m.ledger.filter((l) => l.section !== 'unplaced' && !sections.has(l.section));
  flags.push(`[coverage] ${m.ledger.length} points, ${m.ledger.length - unplaced.length - dangling.length} placed, ${unplaced.length} unplaced`);
  if (dangling.length) {
    flags.push(`[coverage] ${dangling.length} ledger entr${dangling.length > 1 ? 'ies name sections' : 'y names a section'} that does not exist: ${dangling.slice(0, 3).map((l) => l.section).join(', ')}`);
  }
  if (unplaced.length) flags.push(`[coverage] ${unplaced.length} point${unplaced.length > 1 ? 's' : ''} the model could not place — read them before shipping`);
  const onCard = new Set(cardLines(md).map(slugId));
  const missing = m.items.filter((it) => !onCard.has(it.slug));
  if (missing.length) {
    flags.push(`[coverage] ${missing.length} machine-block item${missing.length > 1 ? 's' : ''} with no card line: ${missing.slice(0, 3).map((it) => it.slug).join(', ')}`);
  }
  return flags;
}

// ── the shadow report ────────────────────────────────────────────────────────
// The brief IS the document; this is its machine projection, derived deterministically from the
// markdown with NO second billed call. Everything downstream (the Carry-Forward export, Team
// Progress, cross-session homework, the report view, the tree's section sub-nav) reads only
// `sections`, `actionItems` and `carry`, so they all keep working unchanged. Run through the
// existing coerceReport so the shape can never drift from what those consumers expect.
export function briefToFinal(md, { warnings = [], generated = '', model = '' } = {}) {
  return {
    ...coerceReport({
      schemaVersion: REPORT_SCHEMA_VERSION,
      sections: briefSections(md).map((s) => ({ id: s.id, heading: s.heading, md: s.body })),
      actionItems: cardLines(md).map((text) => ({ id: slugId(text), text, status: 'pending' })),
      carry: [],
      meta: { warnings },
      generated,
    }),
    model,
  };
}

// ── generate ─────────────────────────────────────────────────────────────────
// DI'd invoke (mirror generateReport) → generate + parse + check. One reprompt on a parse failure,
// then let the second throw. Markdown output means "parse failure" now means only that the model
// emitted nothing document-shaped, which is rare and recoverable.
//
// MODEL IS PINNED. The Settings→Agents alias maps `opus` to Opus 4.8; the target document was
// written by Opus 5, and model choice is a visible share of the remaining gap. The alias is resolved
// in src-tauri/src/commands/coaching.rs::classify_model_id.
export const BRIEF_MODEL = 'opus-5';

export async function generatePlayerBrief(invoke, { transcriptBlock, lexiconBlock = '', sessionNumber = 1, onRaw = null }, agents = {}) {
  const user = buildBriefPrompt({ transcriptBlock, lexiconBlock, sessionNumber });
  const base = {
    systemPrompt: BRIEF_SYSTEM,
    backend: agents.authBackend || 'api-key',
    model: BRIEF_MODEL,
    cliPath: agents.claudeCliPath || '',
  };
  const call = (userPrompt) => invoke('coaching_classify_match', { ...base, userPrompt });
  const raw = await parseOrRetry(call, user, parseBrief, 'Respond with ONLY the finished markdown document, nothing else.', onRaw);
  const split = splitBriefSentences(raw);
  const warnings = [];
  if (split.n) warnings.push(`Split ${split.n} over-long sentence${split.n > 1 ? 's' : ''} at a colon or dash — the 35-word ceiling is stated in the prompt.`);
  const md = split.text;
  const meta = parseMachineBlock(md);
  warnings.push(...checkTemplate(md), ...checkProse(md), ...checkDevices(md), ...checkCoverage(md, meta));
  return { md, meta, warnings };
}

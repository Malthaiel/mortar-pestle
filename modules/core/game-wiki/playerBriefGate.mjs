// Player-brief mechanical quality gate. Usage:
//   node modules/core/game-wiki/playerBriefGate.mjs "<abs path to a Player Brief.md>"
// Sibling of vodReportGate.mjs, and deliberately the same shape: the same Lexicon + learned-mishear
// load, and the same delegation to the pipeline's validateStamps so the gate and the generate path
// can never disagree about what a valid stamp is.
//
// The brief is markdown, so every check runs on text rather than a parsed object. Checks (spec §11):
//   1. lexicon zero-miss  — every hero named in the document is a canonical Lexicon entry.
//   2. no surviving mishears — no learned Mishear "wrong" spelling anywhere in the document.
//   3. timestamps valid   — every ledger stamp lands inside a real segment of the review recording.
//   4. no naked reader    — zero "the player" / "the <x> player" / "Speaker N" in the rendered body.
//                           HARD FAIL: this is what most visibly marks a document as machine-written,
//                           and it is the single rule this whole artifact exists to invert.
//   5. card non-empty     — a document with sections and no card lines fails. A session that taught
//                           nothing actionable did not happen.
//   6. template intact    — checkTemplate passes: the fixed strings, the four-mark allowance
//                           (⚠ ✅ ❌ ⏸ pass, any other pictograph fails), and the deferred-work
//                           note when the machine block says work was deferred.
import fs from 'node:fs';
import path from 'node:path';
import { parseMishears } from './analystBrain.js';
import { validateStamps } from './vodReport.js';
import { checkTemplate, cardLines, briefSections, parseMachineBlock, scanLines } from './playerBrief.js';

const GW = path.join(process.env.APPDATA, 'dev.malthaiel.mortar-pestle', 'GameWiki', 'Deadlock');
const briefPath = process.argv[2];
if (!briefPath) { console.error('usage: node playerBriefGate.mjs "<Player Brief.md>"'); process.exit(2); }
const md = fs.readFileSync(briefPath, 'utf8');

// ── Lexicon: canonical names + learned mishears ──────────────────────────────
const lex = fs.readFileSync(path.join(GW, 'Coaching/Analyst/Lexicon.md'), 'utf8');
const canon = new Set();
let section = '';
for (const line of lex.split(/\r?\n/)) {
  const h = line.match(/^##\s+(.+?)\s*$/);
  if (h) { section = h[1].toLowerCase(); continue; }
  if (section === 'mishears') continue; // handled by parseMishears below
  const b = line.match(/^-\s+(.+?)\s*$/);
  if (b) canon.add(b[1].trim().toLowerCase());
}
const mishears = parseMishears(lex);

// ── the hero pool is the structured field to check ───────────────────────────
// The analyst report had playerCards[].hero; the brief's equivalent is the machine block's `pool`
// plus the pool line in the header. Free prose is NOT swept for hero names — that would need a
// name-entity pass and would false-positive on ordinary words.
const meta = parseMachineBlock(md);
const heroFields = meta.pool.filter(Boolean);

// ── review transcript (stamp ground truth) ───────────────────────────────────
// The brief lives at the scrim folder root, so its review recording is the sibling `.vodcomms.json`
// (or a per-match `.reviewcomms.*` when the scrim has one).
const dir = path.dirname(briefPath);
const readSegs = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).segments || []; } catch { return []; } };
const perMatch = fs.existsSync(path.join(dir, 'Matches'))
  ? fs.readdirSync(path.join(dir, 'Matches')).filter((f) => /^\.reviewcomms\./.test(f))
  : [];
const segments = perMatch.length
  ? perMatch.flatMap((f) => readSegs(path.join(dir, 'Matches', f)))
  : readSegs(path.join(dir, '.vodcomms.json'));

// ── run checks ───────────────────────────────────────────────────────────────
const heroMisses = heroFields.filter((h) => !canon.has(h.toLowerCase()));
const mishearHits = mishears
  .filter(([wrong]) => wrong && new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(md))
  .map(([wrong, right]) => `"${wrong}" (should be "${right}")`);
// validateStamps walks a JSON blob for time tokens; the ledger stamps are exactly that set, and the
// document body carries no inline stamps by design (spec: "the player is not clicking anything").
const badStamps = validateStamps({ ledger: meta.ledger.map((l) => l.stamp) }, segments);
const NAKED = [/\bthe player\b/i, /\bthe \w+ player\b/i, /\bSpeaker \d+/];
const naked = scanLines(md)
  .filter(({ line, machine }) => !machine && NAKED.some((re) => re.test(line)) && !/coach|Malthaiel/i.test(line))
  .map(({ line }) => line.trim().slice(0, 70));
const card = cardLines(md);
const templateFlags = checkTemplate(md);

const pass = heroMisses.length === 0 && mishearHits.length === 0 && badStamps.length === 0
  && naked.length === 0 && card.length > 0 && templateFlags.length === 0;

console.log('Brief:', path.basename(briefPath), '|', briefSections(md).length, 'sections |', card.length, 'card lines |', meta.ledger.length, 'ledger points');
console.log('Lexicon entries:', canon.size, '| learned mishears:', mishears.length, '| review segs:', segments.length);
console.log('Hero pool checked:', heroFields.join(', ') || '(none)');
console.log('---');
console.log(heroMisses.length ? `FAIL hero not in Lexicon: ${heroMisses.join(', ')}` : 'PASS heroes: all in Lexicon');
console.log(mishearHits.length ? `FAIL surviving mishears: ${mishearHits.join('; ')}` : 'PASS mishears: none survive in prose');
console.log(badStamps.length ? `FAIL ledger stamps outside the recording: ${badStamps.join(', ')}` : 'PASS timestamps: all inside a segment');
console.log(naked.length ? `FAIL naked reader (${naked.length}): ${naked.slice(0, 3).join(' | ')}` : 'PASS reader: addressed as "you" throughout');
console.log(card.length ? `PASS card: ${card.length} lines` : 'FAIL card is empty — a session that taught nothing actionable did not happen');
console.log(templateFlags.length ? `FAIL template: ${templateFlags.join(' | ')}` : 'PASS template: fixed strings intact, no emoji');
console.log('---');
console.log(pass ? 'PLAYER BRIEF GATE: PASS' : 'PLAYER BRIEF GATE: FAIL');
process.exit(pass ? 0 : 1);

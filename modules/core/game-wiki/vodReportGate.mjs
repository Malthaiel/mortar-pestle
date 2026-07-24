// VOD-report mechanical quality gate (Move 16; M25 taught it the per-match reports). Usage:
//   node modules/core/game-wiki/vodReportGate.mjs "<abs path to a report sidecar>"
// Accepts any of the three report sidecars the pipeline writes:
//   • <scrim folder>/.vodreport.json                    — the legacy scrim report (one recording)
//   • <scrim folder>/Matches/.matchreport.Match N.json  — Process 1, the analyst's first report
//   • <scrim folder>/Matches/.matchfinal.Match N.json   — Process 2, the coach-voiced final report
// Checks the mechanical facts a report must hold regardless of prose depth:
//   1. lexicon zero-miss — every playerCards[].hero is a canonical Lexicon entry,
//      and no learned Mishear "wrong" spelling survives anywhere in the report.
//   2. timestamps exist — every stamp lands inside a real segment of the recording its own source
//      letter names (M18), delegated to the pipeline's validateStamps so the gate and the generate
//      path can never disagree about what a valid stamp is.
// The "player-card stats match digest" check is moot when the pipeline flags a
// digest/VOD mismatch (meta.warnings) and builds cards from the transcript instead.
import fs from 'node:fs';
import path from 'node:path';
import { parseMishears } from './analystBrain.js';
import { validateStamps } from './vodReport.js';

const GW = path.join(process.env.APPDATA, 'dev.malthaiel.mortar-pestle', 'GameWiki', 'Deadlock');
const reportPath = process.argv[2];
if (!reportPath) { console.error('usage: node vodReportGate.mjs <report.json>'); process.exit(2); }
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

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
const mishears = parseMishears(lex); // [[wrong, right]], skips header/separator

// ── gather report text + structured hero fields ──────────────────────────────
const allText = JSON.stringify(report);
const heroFields = (report.playerCards || []).map((c) => (c.hero || '').trim()).filter(Boolean);

// ── transcript segments (stamp ground truth) ─────────────────────────────────
// Schema v2 (GameWiki Unification): a scrim report lives at `<scrim folder>/.vodreport.json`, so its
// one transcript is the sibling `.vodcomms.json`. A match report lives in `Matches/` beside BOTH of
// its recordings, and validateStamps checks each stamp against the one its letter names.
const dir = path.dirname(reportPath);
const readSegs = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).segments || []; } catch { return []; } };
const kind = path.basename(reportPath).match(/^\.(matchreport|matchfinal)\.(Match \d+)\.json$/);
const segments = (() => {
  if (!kind) return readSegs(path.join(dir, '.vodcomms.json'));
  const comms = readSegs(path.join(dir, `.commstranscript.${kind[2]}.json`));
  // Process 1 has never seen a review, so it has no review recording to check an "r" stamp against.
  if (kind[1] === 'matchreport') return { comms, review: [] };
  // M8 adoption: a single-match scrim's final report may be reviewing the scrim-level recording, so
  // that file stands in when the per-match review sidecar does not exist.
  const per = readSegs(path.join(dir, `.reviewcomms.${kind[2]}.json`));
  return { comms, review: per.length ? per : readSegs(path.join(dir, '..', '.vodcomms.json')) };
})();
const segCount = Array.isArray(segments)
  ? `${segments.length} review`
  : `${segments.comms.length} in-game + ${segments.review.length} review`;

// ── run checks ───────────────────────────────────────────────────────────────
const heroMisses = heroFields.filter((h) => !canon.has(h.toLowerCase()));
const mishearHits = mishears
  .filter(([wrong]) => wrong && new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(allText))
  .map(([wrong, right]) => `"${wrong}" (should be "${right}")`);
const badStamps = validateStamps(report, segments);

const pass = heroMisses.length === 0 && mishearHits.length === 0 && badStamps.length === 0;
console.log('Report kind:', kind ? `${kind[1]} (${kind[2]})` : 'scrim report');
console.log('Lexicon entries:', canon.size, '| learned mishears:', mishears.length, '| transcript segs:', segCount);
console.log('Hero fields checked:', heroFields.join(', ') || '(none)');
console.log('---');
console.log(heroMisses.length ? `FAIL hero not in Lexicon: ${heroMisses.join(', ')}` : 'PASS heroes: all in Lexicon');
console.log(mishearHits.length ? `FAIL surviving mishears: ${mishearHits.join('; ')}` : 'PASS mishears: none survive in prose');
console.log(badStamps.length ? `FAIL timestamps outside the recording they name: ${badStamps.join(', ')}` : 'PASS timestamps: all inside a segment');
console.log('---');
console.log(pass ? 'MECHANICAL GATE: PASS' : 'MECHANICAL GATE: FAIL');
process.exit(pass ? 0 : 1);

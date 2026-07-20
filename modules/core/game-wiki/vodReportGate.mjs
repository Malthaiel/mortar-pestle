// VOD-report mechanical quality gate (Move 16). Usage:
//   node modules/core/game-wiki/vodReportGate.mjs "<abs path to <scrim folder>/.vodreport.json>"
// Checks the mechanical facts a report must hold regardless of prose depth:
//   1. lexicon zero-miss — every playerCards[].hero is a canonical Lexicon entry,
//      and no learned Mishear "wrong" spelling survives anywhere in the report.
//   2. timestamps exist — every m:ss in the report lands inside a real vodcomms segment.
// The "player-card stats match digest" check is moot when the pipeline flags a
// digest/VOD mismatch (meta.warnings) and builds cards from the transcript instead.
import fs from 'node:fs';
import path from 'node:path';
import { parseMishears } from './analystBrain.js';
import { mmss } from './vodReport.js';

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

// ── gather report text + structured hero fields + timestamps ─────────────────
const allText = JSON.stringify(report);
const heroFields = (report.playerCards || []).map((c) => (c.hero || '').trim()).filter(Boolean);
// Optional leading hour group: mmss() emits h:mm:ss past 1:00:00, and pre-2026-07-20 sidecars stored
// the same moment as a bare `67:25`. Both forms must resolve to the same second or a long review's
// stamps all read as "outside the transcript".
const stamps = [...allText.matchAll(/\b(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)\b/g)]
  .map((m) => (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]));

// ── vodcomms segments (transcript ground truth) ──────────────────────────────
// Schema v2 (GameWiki Unification): the report lives at `<scrim folder>/.vodreport.json`,
// so the transcript is simply its sibling `.vodcomms.json`.
const segs = JSON.parse(fs.readFileSync(path.join(path.dirname(reportPath), '.vodcomms.json'), 'utf8')).segments;
const spanEnd = segs[segs.length - 1].t1Ms;
const TOL = 5000; // segments are ~2.5s apart; ±5s covers rounding
const inSeg = (sec) => {
  const ms = sec * 1000;
  if (ms < 0 || ms > spanEnd + TOL) return false;
  return segs.some((s) => ms >= s.t0Ms - TOL && ms <= s.t1Ms + TOL);
};

// ── run checks ───────────────────────────────────────────────────────────────
const heroMisses = heroFields.filter((h) => !canon.has(h.toLowerCase()));
const mishearHits = mishears
  .filter(([wrong]) => wrong && new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(allText))
  .map(([wrong, right]) => `"${wrong}" (should be "${right}")`);
const badStamps = [...new Set(stamps)].filter((s) => !inSeg(s)).map(mmss);

const pass = heroMisses.length === 0 && mishearHits.length === 0 && badStamps.length === 0;
console.log('Lexicon entries:', canon.size, '| learned mishears:', mishears.length, '| transcript segs:', segs.length, `(0–${(spanEnd / 60000).toFixed(0)}min)`);
console.log('Hero fields checked:', heroFields.join(', ') || '(none)');
console.log('Timestamps checked:', new Set(stamps).size);
console.log('---');
console.log(heroMisses.length ? `FAIL hero not in Lexicon: ${heroMisses.join(', ')}` : 'PASS heroes: all in Lexicon');
console.log(mishearHits.length ? `FAIL surviving mishears: ${mishearHits.join('; ')}` : 'PASS mishears: none survive in prose');
console.log(badStamps.length ? `FAIL timestamps outside transcript: ${badStamps.join(', ')}` : 'PASS timestamps: all inside a segment');
console.log('---');
console.log(pass ? 'MECHANICAL GATE: PASS' : 'MECHANICAL GATE: FAIL');
process.exit(pass ? 0 : 1);

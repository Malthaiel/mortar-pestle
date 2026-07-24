// Runnable check for matchReport.js pure logic (no framework): `node matchReport.selftest.mjs`.
// Covers the parts that break silently — provenance tag extraction, prompt assembly (the no-comms
// guard especially, since a graded-but-never-shown commsGrade is the format's worst failure), the
// tolerant parse, and coercion defaults that keep the view from branching on undefined.
import assert from 'node:assert/strict';
import {
  MATCH_REPORT_SCHEMA_VERSION, MATCH_REPORT_SYSTEM_PROMPT, TAGS, splitTag, collectClaims,
  buildMatchReportPrompt, coerceMatchReport, parseMatchReport, generateMatchReport,
} from './matchReport.js';
import { sidecarPath } from './matchData.js';

// --- provenance tags -------------------------------------------------------
assert.deepEqual(splitTag('[data] 20.4k souls'), { tag: 'data', text: '20.4k souls' });
assert.deepEqual(splitTag('  [ANALYST]   lane lost early'), { tag: 'analyst', text: 'lane lost early' });
assert.deepEqual(splitTag('[grounded] patch 07-02 cut it'), { tag: 'grounded', text: 'patch 07-02 cut it' });
assert.deepEqual(splitTag('no tag here'), { tag: '', text: 'no tag here' }, 'untagged text passes through whole');
assert.deepEqual(splitTag('[opinion] made up class'), { tag: '', text: '[opinion] made up class' }, 'unknown class is not a tag');
assert.deepEqual(splitTag(null), { tag: '', text: '' }, 'null degrades');
assert.deepEqual(splitTag('[data] a [analyst] b'), { tag: 'data', text: 'a [analyst] b' }, 'only the leading tag is the tag');
assert.deepEqual(TAGS, ['data', 'grounded', 'analyst']);

const claims = collectClaims({
  playerCards: [{ player: 'Sam', hero: 'Infernus', laneVerdict: '[data] 3.1k behind', coaching: '[analyst] farm the safe wave', drills: ['[analyst] last-hit drill', 'untagged drill'] }],
  macro: { tempoRead: '[grounded] slow patch meta', swings: [{ t: '18:40', cause: '[analyst] overextended mid' }] },
  meta: { warnings: ['[data] no comms attached'] },
});
assert.equal(claims.filter((c) => c.tag === 'analyst').length, 3, 'analyst claims found at every depth');
assert.equal(claims.filter((c) => c.tag === 'data').length, 2);
assert.equal(claims.filter((c) => c.tag === 'grounded').length, 1);
assert.ok(!claims.some((c) => c.text.startsWith('[')), 'collected claim text is tag-stripped');
assert.ok(claims.some((c) => c.ref === 'playerCards[0].drills[0]'), 'refs address array members exactly');
assert.ok(!claims.some((c) => c.text === 'untagged drill'), 'untagged strings are not claims');
assert.deepEqual(collectClaims(null), [], 'garbage input -> no claims');

// --- prompt ----------------------------------------------------------------
const withComms = buildMatchReportPrompt({ digest: '## Match digest', coachedTeam: 'North', tfCommsBlock: '=== IN-GAME COMMS JUDGMENTS (Match 1) ===\n2 fights', brainContext: 'lexicon' });
assert.ok(withComms.includes('Coached team: North.'));
assert.ok(withComms.includes('=== ANALYST BRAIN ===') && withComms.includes('=== MATCH DATA DIGEST ==='));
assert.ok(withComms.includes('IN-GAME COMMS JUDGMENTS'), 'comms block reaches the prompt');
assert.ok(!withComms.includes('NO IN-GAME COMMS ATTACHED'), 'no false no-comms guard when comms exist');

const noComms = buildMatchReportPrompt({ digest: '## Match digest' });
assert.ok(noComms.includes('=== NO IN-GAME COMMS ATTACHED ==='), 'missing comms -> explicit do-not-grade guard');
assert.ok(noComms.includes('Coached team: (unnamed).'));
assert.ok(buildMatchReportPrompt({}).includes('(no digest)'), 'digestless build still produces a prompt');

// the system prompt carries its non-negotiables
for (const needle of ['[data]', '[grounded]', '[analyst]', 'PROVENANCE', 'YOUR OWN READS ARE THE JOB', 'GAME clock']) {
  assert.ok(MATCH_REPORT_SYSTEM_PROMPT.includes(needle), `system prompt states: ${needle}`);
}
// the scrim report's exclusions must NOT appear here — no homework, no Q&A, no follow-ups
for (const absent of ['"actionItems"', '"qa"', '"followUps"']) {
  assert.ok(!MATCH_REPORT_SYSTEM_PROMPT.includes(absent), `match report schema omits ${absent}`);
}

// --- parse + coerce --------------------------------------------------------
const full = {
  schemaVersion: 1,
  playerCards: [{ player: 'Sam', hero: 'Infernus', lane: 'Lane 1', laneVerdict: '[data] lost lane', soulsCurveRead: '', itemCritique: '[analyst] greedy', coaching: '', deathAnalysis: [{ t: '12:00', what: 'dove', why: 'no vision', lesson: 'ward' }], drills: ['last-hit'] }, { player: '', hero: '' }],
  macro: { tempoRead: '[data] slow', objectiveWindows: [{ t: '20:00', event: 'mid boss', verdict: 'lost', why: '[analyst] no setup' }], laneMap: '', swings: [{ t: '25:00', direction: 'theirs', cause: '[data] wipe' }] },
  commsGrade: { overall: '', callouts: [], missed: [] },
  sections: [{ heading: 'Losing the Mid Lane', md: '**The lane was lost on wave two:** ...' }, { heading: '', md: '' }],
  keepDoing: ['[data] 8 denies'],
  meta: { warnings: ['no comms attached'] },
};
const rep = parseMatchReport('```json\n' + JSON.stringify(full) + '\n```');
assert.equal(rep.schemaVersion, MATCH_REPORT_SCHEMA_VERSION, 'fenced payload parses');
assert.equal(rep.playerCards.length, 1, 'nameless+heroless card dropped');
assert.equal(rep.sections.length, 1, 'empty section dropped');
assert.equal(rep.sections[0].id, 'losing-the-mid-lane', 'missing id slugged from the heading');
assert.throws(() => parseMatchReport('not json at all'), /no JSON object/, 'unparseable output throws');

const empty = coerceMatchReport({});
assert.equal(empty.schemaVersion, MATCH_REPORT_SCHEMA_VERSION);
assert.deepEqual(empty.playerCards, []);
assert.deepEqual(empty.macro, { tempoRead: '', objectiveWindows: [], laneMap: '', swings: [] });
assert.deepEqual(empty.commsGrade, { overall: '', callouts: [], missed: [] });
assert.deepEqual(empty.keepDoing, []);
assert.deepEqual(empty.meta, { warnings: [], reviewed: '', reconciliation: [] }, 'M24 reconciliation keys default');
assert.deepEqual(coerceMatchReport(null).sections, [], 'garbage input coerces to an empty report');

// M24 write-back shape survives a round trip, and a bogus verdict falls back to unaddressed
const reconciled = coerceMatchReport({ meta: { reviewed: '2026-07-24', reconciliation: [{ claim: 'lane lost early', verdict: 'confirmed', note: 'coach agreed [14:02]' }, { claim: 'x', verdict: 'nonsense' }] } });
assert.equal(reconciled.meta.reviewed, '2026-07-24');
assert.deepEqual(reconciled.meta.reconciliation[0], { claim: 'lane lost early', verdict: 'confirmed', note: 'coach agreed [14:02]' });
assert.equal(reconciled.meta.reconciliation[1].verdict, 'unaddressed', 'unknown verdict degrades, never throws');

// --- sidecar path ----------------------------------------------------------
assert.equal(sidecarPath('Scrim/North VS Extinction/Overview.md', 2, 'matchreport'), 'Scrim/North VS Extinction/Matches/.matchreport.Match 2.json');
assert.equal(sidecarPath('Scrim/North VS Extinction', 1, 'tfcomms'), 'Scrim/North VS Extinction/Matches/.tfcomms.Match 1.json', 'existing kinds unchanged');
assert.equal(sidecarPath('Scrim/North VS Extinction', 1), 'Scrim/North VS Extinction/Matches/.matchdata.Match 1.json', 'default kind unchanged');
assert.equal(sidecarPath('Scrim/North VS Extinction', 1, 'bogus'), 'Scrim/North VS Extinction/Matches/.matchdata.Match 1.json', 'unknown kind falls back');

// --- generate (fake invoke — never bills) ----------------------------------
let seen = null;
const fakeInvoke = async (cmd, args) => { seen = { cmd, args }; return JSON.stringify(full); };
const gen = await generateMatchReport(fakeInvoke, { digest: '## d', coachedTeam: 'North' }, { model: 'opus' });
assert.equal(seen.cmd, 'coaching_classify_match', 'routes through the existing match invoke — no new Rust command');
assert.equal(seen.args.systemPrompt, MATCH_REPORT_SYSTEM_PROMPT);
assert.equal(gen.schemaVersion, MATCH_REPORT_SCHEMA_VERSION, 'version stamped regardless of model echo');
assert.equal(gen.playerCards[0].hero, 'Infernus');

// one bad emission reprompts, the retry lands
let calls = 0;
const flakyInvoke = async () => { calls += 1; return calls === 1 ? 'sorry, here is the report:' : JSON.stringify(full); };
const retried = await generateMatchReport(flakyInvoke, { digest: '## d' });
assert.equal(calls, 2, 'a parse failure reprompts exactly once');
assert.equal(retried.playerCards[0].hero, 'Infernus');

console.log('matchReport.selftest: all assertions passed');

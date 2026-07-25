// Runnable check for matchReport.js pure logic (no framework): `node matchReport.selftest.mjs`.
// Covers the parts that break silently — provenance tag extraction, prompt assembly (the no-comms
// guard especially, since a graded-but-never-shown commsGrade is the format's worst failure), the
// tolerant parse, and coercion defaults that keep the view from branching on undefined.
import assert from 'node:assert/strict';
import {
  MATCH_REPORT_SCHEMA_VERSION, MATCH_REPORT_SYSTEM_PROMPT, buildMatchReportSystemPrompt, TAGS,
  splitTag, collectClaims, buildMatchReportPrompt, coerceMatchReport, parseMatchReport,
  generateMatchReport, linkTagTokens, enforceFirstReport,
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

// M3: the in-game comms transcript is a first-class input — labeled, and it alone defuses the guard
const withTranscript = buildMatchReportPrompt({ digest: '## d', commsBlock: '[0:12] Sam: rotating mid' });
assert.ok(withTranscript.includes('=== IN-GAME COMMS TRANSCRIPT ==='), 'transcript block labeled');
assert.ok(withTranscript.includes('[0:12] Sam: rotating mid'), 'transcript content reaches the prompt');
assert.ok(!withTranscript.includes('NO IN-GAME COMMS ATTACHED'), 'transcript alone defuses the no-comms guard');

// the system prompt carries its non-negotiables
for (const needle of ['[data]', '[grounded]', '[analyst]', 'PROVENANCE', 'YOUR OWN READS ARE THE JOB', 'GAME clock']) {
  assert.ok(MATCH_REPORT_SYSTEM_PROMPT.includes(needle), `system prompt states: ${needle}`);
}
// Same coin-flip the final-report prompt had: a card with every field empty is a shell, not a card.
assert.ok(MATCH_REPORT_SYSTEM_PROMPT.includes('OMIT a player entirely when every field would be empty'),
  'P1 omits empty player cards too — both prompts state it, so neither can drift');
// M3: full report shape — the final must be able to replace this 1:1
for (const present of ['"actionItems"', '"qa"', '"debates"', '"followUps"', '"keepDoing"']) {
  assert.ok(MATCH_REPORT_SYSTEM_PROMPT.includes(present), `match report schema carries ${present}`);
}
// ...but qa/followUps are declared ALWAYS empty (Process 2 owns them)
assert.equal((MATCH_REPORT_SYSTEM_PROMPT.match(/ALWAYS the empty array/g) || []).length, 2, 'qa + followUps schema lines both state the invariant');

// M5: the data-free build REPLACES the data-grounded schema comments — never appends around them
const dfPrompt = buildMatchReportSystemPrompt({ dataFree: true });
assert.ok(dfPrompt.includes('NO MATCH DATA THIS RUN'), 'data-free prompt carries the rule block');
assert.ok(!dfPrompt.includes('off the lane souls curve'), 'data-grounded laneVerdict comment replaced, not kept');
assert.ok(dfPrompt.includes('"laneVerdict"') && dfPrompt.includes('"swings"'), 'schema keys survive the swap');
assert.ok(!MATCH_REPORT_SYSTEM_PROMPT.includes('NO MATCH DATA THIS RUN'), 'default prompt has no data-free text');
assert.equal(buildMatchReportSystemPrompt(), MATCH_REPORT_SYSTEM_PROMPT, 'no-arg build IS the default prompt');

// --- parse + coerce --------------------------------------------------------
const full = {
  schemaVersion: 1,
  playerCards: [{ player: 'Sam', hero: 'Infernus', lane: 'Lane 1', laneVerdict: '[data] lost lane', soulsCurveRead: '', itemCritique: '[analyst] greedy', coaching: '', deathAnalysis: [{ t: '12:00', what: 'dove', why: 'no vision', lesson: 'ward' }], drills: ['last-hit'] }, { player: '', hero: '' }],
  macro: { tempoRead: '[data] slow', objectiveWindows: [{ t: '20:00', event: 'mid boss', verdict: 'lost', why: '[analyst] no setup' }], laneMap: '', swings: [{ t: '25:00', direction: 'theirs', cause: '[data] wipe' }] },
  commsGrade: { overall: '', callouts: [], missed: [] },
  sections: [{ heading: 'Losing the Mid Lane', md: '**The lane was lost on wave two:** ...' }, { heading: '', md: '' }],
  actionItems: [{ text: '[analyst] rotate mid after first tower', count: 2, timestamps: ['4:10', '12:33'], player: 'Sam' }],
  qa: [{ q: 'should not survive', a: 'Process 1 has no review session' }],
  keepDoing: ['[data] 8 denies'],
  debates: ['[analyst] Rapid Recharge vs Boundless on Infernus is a real fork'],
  followUps: [{ priorItem: 'should not survive', verdict: 'persisting', evidence: 'x' }],
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
assert.deepEqual(empty.actionItems, [], 'M3 full-shape keys default');
assert.deepEqual(empty.qa, []);
assert.deepEqual(empty.debates, []);
assert.deepEqual(empty.followUps, []);
assert.deepEqual(empty.meta, { warnings: [], speakerMap: {}, reviewed: '', reconciliation: [] }, 'M24 reconciliation + M10 speakerMap keys default');
assert.deepEqual(coerceMatchReport(null).sections, [], 'garbage input coerces to an empty report');

// M3 coerce details: stable id slugged from text when missing (never re-keyed), status/verdict degrade
const ai = coerceMatchReport({ actionItems: [{ text: '[analyst] Rotate mid!', status: 'bogus' }], followUps: [{ priorItem: 'x', verdict: 'nonsense' }] });
assert.equal(ai.actionItems[0].id, 'analyst-rotate-mid', 'missing id slugged from the text');
assert.equal(ai.actionItems[0].status, 'pending', 'unknown status degrades to pending');
assert.equal(ai.actionItems[0].count, 1, 'missing count floors at 1');
assert.equal(ai.followUps[0].verdict, 'unclear', 'unknown followUp verdict degrades');

// Process 1 invariant: enforceFirstReport strips qa/followUps no matter what the model emitted
const enforced = enforceFirstReport(coerceMatchReport(full));
assert.deepEqual(enforced.qa, [], 'first report never carries qa');
assert.deepEqual(enforced.followUps, [], 'first report never carries followUps');
assert.equal(enforced.actionItems.length, 1, 'analyst actionItems survive enforcement');
assert.equal(enforced.debates.length, 1, 'debates survive enforcement');

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
assert.deepEqual(gen.qa, [], 'generate enforces the first-report invariant even when the model emits qa');
assert.deepEqual(gen.followUps, [], 'generate enforces the first-report invariant even when the model emits followUps');
assert.equal(gen.actionItems.length, 1, 'analyst actionItems pass through generate');

// M5: an empty digest flips the sent system prompt to the data-free variant
await generateMatchReport(fakeInvoke, { digest: '', coachedTeam: 'North' }, { model: 'opus' });
assert.ok(seen.args.systemPrompt.includes('NO MATCH DATA THIS RUN'), 'empty digest sends the data-free schema');

// one bad emission reprompts, the retry lands
let calls = 0;
const flakyInvoke = async () => { calls += 1; return calls === 1 ? 'sorry, here is the report:' : JSON.stringify(full); };
const retried = await generateMatchReport(flakyInvoke, { digest: '## d' });
assert.equal(calls, 2, 'a parse failure reprompts exactly once');
assert.equal(retried.playerCards[0].hero, 'Infernus');

// M23: tags inside section markdown become #tag- links so the view's existing `a` override chips
// them — the same channel linkTimeTokens uses, so tables/lists/markdown keep working.
assert.equal(linkTagTokens('[analyst] lane lost early'), '[analyst](#tag-analyst) lane lost early');
assert.equal(linkTagTokens('- [data] 20k souls\n- [grounded] patch cut it'), '- [data](#tag-data) 20k souls\n- [grounded](#tag-grounded) patch cut it');
assert.equal(linkTagTokens('[data](http://x) already a link'), '[data](http://x) already a link', 'a real markdown link is left alone');
assert.equal(linkTagTokens('`[data] in code`'), '`[data] in code`', 'code spans pass through untouched');
assert.equal(linkTagTokens('```\n[data] fenced\n```'), '```\n[data] fenced\n```', 'fenced blocks pass through untouched');
assert.equal(linkTagTokens('[12:00] no tag'), '[12:00] no tag', 'a timestamp is not a tag');
assert.equal(linkTagTokens(null), '', 'null degrades');

// M9/M10: the analyst prompt carries the attribution + speaker-identity blocks (the P1 half of WS2),
// and the data-free variant keeps them — neither rule depends on match data existing.
for (const needle of [
  'Attribution fidelity', 'Actions belong to their actor', 'Name the concrete person',
  'Speaker identity', 'meta.speakerMap', 'NO user-facing field may contain "Speaker N"',
]) {
  assert.ok(MATCH_REPORT_SYSTEM_PROMPT.includes(needle), `P1 rule present: ${needle}`);
  assert.ok(buildMatchReportSystemPrompt({ dataFree: true }).includes(needle), `P1 rule survives data-free: ${needle}`);
}

// M10: speakerMap coerces exactly like the scrim report's, so one reader serves both reports.
assert.deepEqual(coerceMatchReport({}).meta.speakerMap, {}, 'absent speakerMap -> {}');
assert.deepEqual(coerceMatchReport({ meta: { speakerMap: [] } }).meta.speakerMap, {}, 'array speakerMap -> {}');
const msm = coerceMatchReport({ meta: { speakerMap: {
  'Speaker 3': { name: 'Celeste', confidence: 'high', evidence: '[12:04] addressed by name' },
  'Speaker 7': { name: 'Ash' },
} } }).meta.speakerMap;
assert.deepEqual(msm['Speaker 3'], { name: 'Celeste', confidence: 'high', evidence: '[12:04] addressed by name' }, 'full mapping survives');
assert.deepEqual(msm['Speaker 7'], { name: 'Ash', confidence: 'low', evidence: '' }, 'partial mapping defaults to low confidence');

// M18: the analyst prompt teaches the stamp-source letter, and teaches that "r" is not its to write
// — Process 1 has never seen a VOD review, so an "r" stamp out of it would link to nothing.
for (const needle of ['Stamp sources', '[8:12c]', 'never', 'clickable']) {
  assert.ok(MATCH_REPORT_SYSTEM_PROMPT.includes(needle), `P1 stamp-source rule states: ${needle}`);
  assert.ok(buildMatchReportSystemPrompt({ dataFree: true }).includes(needle), `P1 stamp-source rule survives data-free: ${needle}`);
}
assert.ok(!MATCH_REPORT_SYSTEM_PROMPT.includes('[27:49r]'), 'P1 never shows an "r" stamp as an example to copy');
// The structured single-stamp fields hold a bare time, so the letter rule has to reach them by name
// or a death's or callout's moment can never become clickable.
for (const needle of ['The short time fields hold a BARE time', 'write 8:12c there']) {
  assert.ok(MATCH_REPORT_SYSTEM_PROMPT.includes(needle), `P1 bare-field stamp rule states: ${needle}`);
  assert.ok(buildMatchReportSystemPrompt({ dataFree: true }).includes(needle), `P1 bare-field stamp rule survives data-free: ${needle}`);
}

console.log('matchReport.selftest: all assertions passed');

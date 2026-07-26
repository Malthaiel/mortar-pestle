// Runnable check for vodReport.js pure logic (no framework): `node vodReport.selftest.mjs`.
// Covers the parts that break silently — transcript formatting, tolerant parse (fenced + noisy),
// coercion of a missing id, and checkbox reconcile across a regenerate.
import assert from 'node:assert/strict';
import { mmss, slugId, buildTranscriptBlock, buildReportPrompt, parseReport, reconcileReport, serializeReportMarkdown, buildNormalizePrompt, parseCorrections, applyCorrections, transcriptHash, normalizeTranscript, parseFindings, applyFindings, verifyReport, validateStamps, collapseStampRuns, parseStamp, segIndexForStamp, serializeTfComms, coerceReport, checkProse, splitLongSentences, generateReport, VOD_REPORT_SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT } from './vodReport.js';
import { MATCH_REPORT_SYSTEM_PROMPT } from './matchReport.js';

// mmss
assert.equal(mmss(0), '0:00');
assert.equal(mmss(75), '1:15');
assert.equal(mmss(-3), '0:00');
assert.equal(mmss('abc'), '0:00');
// hour boundary — must read exactly as YouTube renders the same second
assert.equal(mmss(3599), '59:59');
assert.equal(mmss(3600), '1:00:00');
assert.equal(mmss(4045), '1:07:25');
assert.equal(mmss(3644), '1:00:44');

// slugId deterministic
assert.equal(slugId('Rotate MID after first tower!'), 'rotate-mid-after-first-tower');
assert.equal(slugId(''), 'item');

// transcript block: drops empty text, stamps speaker + m:ss
const block = buildTranscriptBlock([
  { t0Ms: 0, t1Ms: 1000, text: 'ok so first fight', speaker: 'Coach' },
  { t0Ms: 90000, t1Ms: 92000, text: '  ', speaker: 'Alex' },
  { t0Ms: 125000, t1Ms: 126000, text: 'why did we dive?', speaker: 'Sam' },
]);
assert.equal(block, '[0:00] Coach: ok so first fight\n[2:05] Sam: why did we dive?');

// tolerant parse: fenced JSON with noise, missing id gets a slug, unknown status → pending
const raw = '```json\n{"tldr":"good macro","actionItems":[{"text":"ward river","count":2,"timestamps":["1:15","3:40"]}],"qa":[],"keepDoing":["early game"],"debates":[],"followUps":[]}\n```';
const rep = parseReport(raw);
assert.equal(rep.tldr, 'good macro');
assert.equal(rep.actionItems.length, 1);
assert.equal(rep.actionItems[0].id, 'ward-river'); // id derived from text
assert.equal(rep.actionItems[0].status, 'pending');
assert.deepEqual(rep.keepDoing, ['early game']);

// missing sections key coerces to [] (old sidecars / forgetful model)
assert.deepEqual(rep.sections, []);

// sections: id derived from heading, empty entries dropped, md + [m:ss] tokens pass through verbatim
const secRaw = JSON.stringify({
  tldr: 't',
  sections: [
    { heading: 'Gaining a Lead', md: '1. Win lane [2:05]\n2. Gank\n\n| Down | Up |\n|---|---|\n| Group | Split |' },
    { heading: '', md: '' },
  ],
  actionItems: [], qa: [], keepDoing: [], debates: [], followUps: [],
});
const secRep = parseReport(secRaw);
assert.equal(secRep.sections.length, 1);
assert.equal(secRep.sections[0].id, 'gaining-a-lead');
assert.ok(secRep.sections[0].md.includes('[2:05]'));
assert.ok(secRep.sections[0].md.includes('| Down | Up |'));

// notesBlock: included when non-empty, omitted when blank
const withNotes = buildReportPrompt({ transcriptBlock: 'T', notesBlock: '### Convert\n- take midboss' });
assert.ok(withNotes.includes('Player-written notes'));
assert.ok(withNotes.includes('take midboss'));
assert.ok(!buildReportPrompt({ transcriptBlock: 'T' }).includes('Player-written notes'));
assert.ok(!buildReportPrompt({ transcriptBlock: 'T', notesBlock: '  ' }).includes('Player-written notes'));

// parse throws on no object
assert.throws(() => parseReport('no json here'), /no JSON object/);

// reconcile: a done toggle on a matching id survives a regenerate; fresh text wins
const prior = { actionItems: [{ id: 'ward-river', text: 'ward river (old wording)', status: 'done' }] };
const fresh = { tldr: 'x', actionItems: [{ id: 'ward-river', text: 'ward the river bushes', status: 'pending' }], qa: [], keepDoing: [], debates: [], followUps: [] };
const merged = reconcileReport(fresh, prior);
assert.equal(merged.actionItems[0].status, 'done');           // human toggle carried
assert.equal(merged.actionItems[0].text, 'ward the river bushes'); // fresh AI content wins
// a fresh item with no prior match stays pending
const merged2 = reconcileReport({ actionItems: [{ id: 'new-thing', text: 'new', status: 'pending' }] }, prior);
assert.equal(merged2.actionItems[0].status, 'pending');

// ── Schema v2 (Move 10) ──────────────────────────────────────────────────────

// v1 sidecar (no new keys) coerces to loud defaults, never crashes the view
const v1 = parseReport(JSON.stringify({ tldr: 'old report', actionItems: [], qa: [], keepDoing: [], debates: [], followUps: [] }));
assert.equal(v1.schemaVersion, 1);
assert.deepEqual(v1.playerCards, []);
assert.deepEqual(v1.macro, { tempoRead: '', objectiveWindows: [], laneMap: '', swings: [] });
assert.deepEqual(v1.commsGrade, { overall: '', callouts: [], missed: [] });
assert.deepEqual(v1.meta, { passes: [], brainSections: [], warnings: [], speakerMap: {}, findings: [] });
assert.deepEqual(v1.reconciliation, [], 'M4: old sidecars default reconciliation to [] and keep rendering');

// M4 reconciliation coerce: shape kept, bogus verdict degrades to confirmed, and the prompt/schema carry it
const rec = coerceReport({ reconciliation: [{ claim: 'lane lost on wave 2', verdict: 'overridden', note: 'coach: it was the gank path', stamp: '14:02' }, { claim: 'x', verdict: 'bogus' }], generated: '2026-07-24' });
assert.deepEqual(rec.reconciliation[0], { claim: 'lane lost on wave 2', verdict: 'overridden', note: 'coach: it was the gank path', stamp: '14:02' });
assert.equal(rec.reconciliation[1].verdict, 'confirmed', 'unknown verdict degrades, never throws');
assert.equal(rec.generated, '2026-07-24', 'generated survives coercion — the banner dates from it');
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('"reconciliation"'), 'schema names reconciliation');
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('RECONCILIATION —'), 'prompt carries the reconciliation rule');

// followUps may only judge SUPPLIED priors. Live session-9 run wrote two followUps off the first
// report instead — one of them duplicating this report's own action item, which is the exact
// duplication the code-level self-loop kill was for. The rule closes the wording route to it.
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('FOLLOW-UPS —'), 'prompt carries the follow-ups rule');
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('its action items are never follow-ups'),
  'the first report is explicitly excluded as a follow-up source');
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('one lesson, one home'), 'followUps/actionItems overlap forbidden');
const pPrior = buildReportPrompt({ transcriptBlock: 'T', priorActionItems: [{ id: 'a', text: 'call rotations' }] });
assert.ok(pPrior.includes('with ONLY these items'), 'prior-items block points back at the rule');
assert.ok(!buildReportPrompt({ transcriptBlock: 'T' }).includes('Prior action items from earlier scrims'),
  'no priors supplied -> no prior block, so the rule sends followUps to []');

// Session-9 run 2 emitted three name-only player cards (every field "") where run 1 had correctly
// omitted them and said why — the prompt never picked a side, so the model flipped a coin per run.
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('OMIT a player entirely when every field would be empty'),
  'empty player cards are omitted, not emitted as name-only shells');
// The same run's carry entry copied an action item ending "— see the <heading> section"; the exported
// sheet is read away from the report, where that pointer resolves to nothing.
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('Every carry line must stand alone'),
  'carry entries drop trailing cross-references');
// Session-10 sweep for the REST of that coin-flip class: every schema field that can legitimately be
// empty must say which of omit / emit-empty the model takes, in BOTH prompts, asserted in both
// selftests so the pair cannot drift. These three were the P2 side's unstated defaults.
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('"" when no digest names it — never guess one'),
  'hero/lane fall back to "" without a digest — identical guard asserted in matchReport.selftest.mjs');
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('a string field with nothing real to put in it is ""'),
  'P2 carried only the empty-ARRAY half of this rule; strings had no stated default at all');
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('never grade comms you were'),
  'no judgments AND no review comms talk -> commsGrade.overall "", not an invented grade');

// M4 first-report reference block: labeled + reference-only rule inline; absent when empty
const pFinal = buildReportPrompt({ transcriptBlock: 'T', firstReportBlock: '{"sections":[]}' });
assert.ok(pFinal.includes('=== FIRST REPORT (ANALYST) ==='), 'first report block labeled');
assert.ok(pFinal.includes('NEVER copy its text as source material'), 'reference-only rule rides inline');
assert.ok(!buildReportPrompt({ transcriptBlock: 'T' }).includes('FIRST REPORT (ANALYST)'), 'no first report -> no block');

// v2 payload round-trips; malformed card entries are cleaned, empty cards dropped
const v2 = parseReport(JSON.stringify({
  schemaVersion: 2, tldr: 't',
  playerCards: [
    { player: 'Sam', hero: 'Celeste', lane: 'Lane 1', laneVerdict: 'won', soulsCurveRead: 'ahead all game', itemCritique: 'fine', deathAnalysis: [{ t: '4:09', what: 'dove tower', why: 'no wave', lesson: 'wait' }], drills: ['vod 3 deaths'] },
    { player: '', hero: '' },
  ],
  macro: { tempoRead: 'slow', objectiveWindows: [{ t: '10:50', event: 'walker', verdict: 'good', why: 'numbers' }], laneMap: 'won 1/3', swings: [{ t: '18:16', direction: 'Amber', cause: 'mid boss' }] },
  commsGrade: { overall: 'B', callouts: [{ t: '2:05', who: 'Sam', call: 'gank mid', verdict: 'correct', evidence: 'kill at 2:12' }], missed: ['no call at 14:20 rotation'] },
  actionItems: [], qa: [], keepDoing: [], debates: [], followUps: [],
  meta: { warnings: ['souls claim at 8:00 unverifiable'] },
}));
assert.equal(v2.schemaVersion, 2);
assert.equal(v2.playerCards.length, 1);
assert.equal(v2.playerCards[0].deathAnalysis[0].lesson, 'wait');
assert.equal(v2.macro.swings[0].cause, 'mid boss');
assert.equal(v2.commsGrade.callouts[0].verdict, 'correct');
assert.deepEqual(v2.meta.warnings, ['souls claim at 8:00 unverifiable']);

// v2 prompt carries brain, digests, coach notes — each omitted when empty
const p2 = buildReportPrompt({ transcriptBlock: 'T', brainContext: '=== LEXICON ===\n- Mirage', matchDigests: ['## Match digest — Match 1', ''], coachNotesBlock: '- [2:05] Blunder: dove 1v3' });
assert.ok(p2.includes('=== ANALYST BRAIN ==='));
assert.ok(p2.includes('- Mirage'));
assert.equal((p2.match(/=== MATCH DATA DIGEST ===/g) || []).length, 1); // empty digest dropped
assert.ok(p2.includes('chess.com-style'));
const p3 = buildReportPrompt({ transcriptBlock: 'T' });
assert.ok(!p3.includes('=== ANALYST BRAIN ===') && !p3.includes('=== MATCH DATA DIGEST ==='));

// ── Pass 0 normalization (Move 9) ────────────────────────────────────────────

// prompt: numbered by ORIGINAL index, blanks skipped not renumbered
const segs = [
  { t0Ms: 0, text: 'infernal is fed', speaker: 'Coach' },
  { t0Ms: 1000, text: '   ', speaker: 'Alex' },
  { t0Ms: 2000, text: 'grey talem missed the arrow', speaker: 'Sam' },
];
const np = buildNormalizePrompt(segs, '## Heroes\n- Infernus\n- Grey Talon');
assert.ok(np.includes('0\tinfernal is fed'));
assert.ok(np.includes('2\tgrey talem missed the arrow'));
assert.ok(!np.includes('1\t'));

// parseCorrections: fence + noise tolerated, malformed entries dropped
const cs = parseCorrections('```json\n[{"i":0,"from":"infernal","to":"Infernus"},{"i":"x","from":"a","to":"b"},{"i":2,"from":"","to":"b"},{"i":2,"from":"same","to":"same"}]\n```');
assert.deepEqual(cs, [{ i: 0, from: 'infernal', to: 'Infernus' }]);
assert.throws(() => parseCorrections('no array'), /no JSON array/);

// applyCorrections: exact-substring replace in segment i; misses skipped, never guessed
const { segments: fixed, skipped } = applyCorrections(segs, [
  { i: 0, from: 'infernal', to: 'Infernus' },
  { i: 2, from: 'grey talem', to: 'Grey Talon' },
  { i: 2, from: 'not present', to: 'x' },
  { i: 9, from: 'infernal', to: 'Infernus' },
]);
assert.equal(fixed[0].text, 'Infernus is fed');
assert.equal(fixed[2].text, 'Grey Talon missed the arrow');
assert.equal(skipped.length, 2);
assert.equal(segs[0].text, 'infernal is fed'); // input untouched (copies)

// transcriptHash: stable + content-sensitive
assert.equal(transcriptHash(segs), transcriptHash(segs.map((s) => ({ ...s }))));
assert.notEqual(transcriptHash(segs), transcriptHash(fixed));

// normalizeTranscript happy path (fake invoke)
const okInvoke = async () => '[{"i":0,"from":"infernal","to":"Infernus"}]';
const r1 = await normalizeTranscript(okInvoke, segs, 'lex');
assert.equal(r1.discarded, false);
assert.equal(r1.segments[0].text, 'Infernus is fed');

// reprompt-once then discard on double parse failure — segments untouched
let calls = 0;
const badInvoke = async () => { calls++; return 'not json at all'; };
const r2 = await normalizeTranscript(badInvoke, segs, 'lex');
assert.equal(calls, 2);
assert.equal(r2.discarded, true);
assert.ok(/no JSON array/.test(r2.warning));
assert.equal(r2.segments[0].text, 'infernal is fed');

// transport failure (CLI timeout kill) discards WITHOUT a reprompt — retrying a timeout just
// resends a longer prompt into the same wall and double-bills the run.
let tcalls = 0;
const deadInvoke = async () => { tcalls++; throw new Error('claude timed out after 1200s (killed)'); };
const r2b = await normalizeTranscript(deadInvoke, segs, 'lex');
assert.equal(tcalls, 1, 'transport failure must not be retried');
assert.equal(r2b.discarded, true);
assert.ok(/timed out/.test(r2b.warning));
assert.equal(r2b.segments[0].text, 'infernal is fed');

// rewrite-drift discard: corrections > max(10, 30% of segments)
const segs40 = Array.from({ length: 40 }, (_, i) => ({ t0Ms: i, text: `line ${i}`, speaker: 'A' }));
const floodInvoke = async () => JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ i, from: `line ${i}`, to: 'y' })));
const r3 = await normalizeTranscript(floodInvoke, segs40, 'lex');
assert.equal(r3.discarded, true);
assert.ok(/rewrite drift/.test(r3.warning));
// …but a small legit batch on a tiny transcript does NOT self-discard (the floor)
const r3b = await normalizeTranscript(async () => '[{"i":0,"from":"infernal","to":"Infernus"},{"i":2,"from":"grey talem","to":"Grey Talon"}]', segs, 'lex');
assert.equal(r3b.discarded, false);

// from-mismatch-drift discard: >20% of corrections skipped
const segs10 = Array.from({ length: 10 }, (_, i) => ({ t0Ms: i, text: `line ${i}`, speaker: 'A' }));
const missInvoke = async () => JSON.stringify([{ i: 0, from: 'line 0', to: 'Line 0' }, { i: 1, from: 'absent', to: 'x' }]);
const r4 = await normalizeTranscript(missInvoke, segs10, 'lex');
assert.equal(r4.discarded, true);
assert.ok(/exact-substring/.test(r4.warning));

// cached corrections short-circuit the model call
let cachedCalls = 0;
const r5 = await normalizeTranscript(async () => { cachedCalls++; return '[]'; }, segs, 'lex', {}, { cached: { corrections: [{ i: 0, from: 'infernal', to: 'Infernus' }] } });
assert.equal(cachedCalls, 0);
assert.equal(r5.segments[0].text, 'Infernus is fed');

// empty transcript = clean no-op
const r6 = await normalizeTranscript(okInvoke, [], 'lex');
assert.equal(r6.discarded, false);
assert.deepEqual(r6.corrections, []);

// ── Pass 2 verify (Move 11) ──────────────────────────────────────────────────

// parseFindings: fence + noise tolerated, entries without an issue dropped
const pf = parseFindings('```json\n{"findings":[{"ref":"playerCards[0].hero","field":"hero","issue":"Grey Talom","fix":"Grey Talon","confidence":"exact","evidence":"Fact/Heroes/Grey Talon.md"},{"fix":"x"}]}\n```');
assert.equal(pf.length, 1);
assert.equal(pf[0].fix, 'Grey Talon');
assert.throws(() => parseFindings('nope'), /no JSON object/);

// applyFindings: exact fixes replace everywhere EXCEPT id fields; non-exact → flags + warnings
const draft = parseReport(JSON.stringify({
  schemaVersion: 2, tldr: 'Grey Talom carried.',
  playerCards: [{ player: 'Sam', hero: 'Grey Talom', lane: 'Lane 1', laneVerdict: '', soulsCurveRead: '', itemCritique: '', deathAnalysis: [], drills: [] }],
  actionItems: [{ id: 'grey-talom-drill', text: 'Grey Talom farm drill', count: 1, timestamps: [], player: null, metric: null, status: 'pending' }],
  qa: [], keepDoing: [], debates: [], followUps: [], meta: {},
}));
const verified = applyFindings(draft, [
  { ref: 'playerCards[0].hero', field: 'hero', issue: 'Grey Talom', fix: 'Grey Talon', confidence: 'exact', evidence: 'Fact/Heroes' },
  { ref: 'playerCards[0].soulsCurveRead', field: 'stat', issue: '30k at 10:00', fix: '21k at 10:00', confidence: 'likely', evidence: 'digest curve' },
]);
assert.equal(verified.tldr, 'Grey Talon carried.');
assert.equal(verified.playerCards[0].hero, 'Grey Talon');
assert.equal(verified.actionItems[0].text, 'Grey Talon farm drill');
assert.equal(verified.actionItems[0].id, 'grey-talom-drill'); // ids never rewritten
assert.equal(verified.meta.findings.length, 1);
assert.ok(verified.meta.warnings.some((w) => w.includes('30k at 10:00')));
assert.equal(draft.playerCards[0].hero, 'Grey Talom'); // input untouched

// verifyReport happy path + degrade path (fake invoke)
const vr1 = await verifyReport(async () => '{"findings":[]}', { report: draft });
assert.equal(vr1.ran, true);
assert.deepEqual(vr1.findings, []);
const vr2 = await verifyReport(async () => { throw new Error('CLI walled'); }, { report: draft });
assert.equal(vr2.ran, false);
assert.ok(vr2.report.meta.warnings.some((w) => w.includes('Pass 2 skipped')));
assert.equal(vr2.report.playerCards[0].hero, 'Grey Talom'); // draft shipped unmodified

// ── WS1 final improvements (M2 data-free prompt, M3 stamp validation, M4 timestamp auto-apply) ──

// M2: a data-free run (no digests) emits the NO-MATCH-DATA addendum; a run WITH a digest does not.
const dataFreePrompt = buildReportPrompt({ transcriptBlock: '[0:00] A: hi', matchDigests: [] });
assert.ok(dataFreePrompt.includes('NO MATCH DATA ATTACHED'), 'data-free prompt carries the addendum');
assert.ok(dataFreePrompt.includes('review-talk evidence only'), 'addendum names the commsGrade basis');
// Session-10: the addendum used to name laneVerdict + soulsCurveRead ONLY, leaving six other
// digest-fed fields reading "grounded in the souls curve" with no curve to stand on.
for (const f of ['.hero', '.lane', '.itemCritique', '.deathAnalysis', 'macro.tempoRead', '.laneMap', '.objectiveWindows', '.swings']) {
  assert.ok(dataFreePrompt.includes(f), `addendum names ${f} among the digest-fed fields it empties`);
}
assert.ok(!dataFreePrompt.includes('MATCH DATA DIGEST'), 'no digest header when data-free');
const dataPrompt = buildReportPrompt({ transcriptBlock: '[0:00] A: hi', matchDigests: ['Match 1: souls 21k at 10:00'] });
assert.ok(!dataPrompt.includes('NO MATCH DATA ATTACHED'), 'digest present → no addendum');
assert.ok(dataPrompt.includes('MATCH DATA DIGEST'), 'digest present → digest header');

// M3: validateStamps flags m:ss outside the transcript, passes real ones, no-ops without segments,
// and skips the matchSummaries subtree (its game-clock times aren't VOD stamps — M24 forward-compat).
const stampSegs = [{ t0Ms: 0, t1Ms: 3000 }, { t0Ms: 60000, t1Ms: 63000 }]; // 0:00–0:03 and 1:00–1:03
assert.deepEqual(validateStamps({ sections: [{ id: 's', heading: 'H', md: 'good at [0:01] and [1:02]' }] }, stampSegs), [], 'real stamps clean');
const badStamps = validateStamps({ sections: [{ id: 's', heading: 'H', md: 'invented [45:00] moment' }] }, stampSegs);
assert.ok(badStamps.includes('45:00'), 'invented stamp flagged');
assert.deepEqual(validateStamps({ sections: [{ id: 's', heading: 'H', md: '[45:00]' }] }, []), [], 'no segments → no-op');
assert.deepEqual(validateStamps({ sections: [], matchSummaries: [{ match: 1, summary: 'won a fight at 12:34 game clock' }] }, stampSegs), [], 'matchSummaries stamps skipped');

// M4: a field:'timestamp' finding whose FIXED stamp is real and WRONG stamp is unique auto-applies;
// an ambiguous (non-unique) wrong stamp or a fix outside the transcript stays flag-only.
const tsSegs = [{ t0Ms: 0, t1Ms: 3000 }, { t0Ms: 1600000, t1Ms: 1610000 }]; // 0:00–0:03, 26:40–26:50
const tsFixed = applyFindings(
  { sections: [{ id: 's', heading: 'H', md: 'the play at [27:49] was the turn' }], meta: { warnings: [], findings: [] } },
  [{ ref: 'sections[s].md', field: 'timestamp', issue: '[27:49]', fix: '[26:49]', confidence: 'likely' }], tsSegs);
assert.ok(JSON.stringify(tsFixed).includes('[26:49]') && !JSON.stringify(tsFixed).includes('[27:49]'), 'unique timestamp fix auto-applied');
assert.equal(tsFixed.meta.findings.length, 0, 'auto-applied → not flagged');
const ambOut = applyFindings(
  { sections: [{ id: 's', heading: 'H', md: 'at [27:49] and again [27:49]' }], meta: { warnings: [], findings: [] } },
  [{ field: 'timestamp', issue: '[27:49]', fix: '[26:49]', confidence: 'likely' }], tsSegs);
assert.ok(JSON.stringify(ambOut).includes('[27:49]'), 'ambiguous stamp not rewritten');
assert.equal(ambOut.meta.findings.length, 1, 'ambiguous stamp flagged instead');
const unrealOut = applyFindings(
  { sections: [{ id: 's', heading: 'H', md: 'at [27:49]' }], meta: { warnings: [], findings: [] } },
  [{ field: 'timestamp', issue: '[27:49]', fix: '[99:00]', confidence: 'likely' }], tsSegs);
assert.ok(JSON.stringify(unrealOut).includes('[27:49]'), 'fix outside transcript not applied');
assert.equal(unrealOut.meta.findings.length, 1, 'unreal fix flagged instead');

// M15<->M4: coerceReport folds tight runs into "[a–b]" range tokens BEFORE verify sees the draft, so a
// correction to a range arrives as a whole-token swap. It must apply — and every stamp in the fix must
// land in the transcript, not just the leading one (a bad range END used to ride in on a good START).
const rangeSegs = [{ t0Ms: 1600000, t1Ms: 1603000 }, { t0Ms: 1609000, t1Ms: 1612000 }]; // 26:40–26:43, 26:49–26:52
const rangeFixed = applyFindings(
  { sections: [{ id: 's', heading: 'H', md: 'the push at [26:40–27:49] broke them' }], meta: { warnings: [], findings: [] } },
  [{ field: 'timestamp', issue: '[26:40–27:49]', fix: '[26:40–26:49]', confidence: 'likely' }], rangeSegs);
assert.ok(JSON.stringify(rangeFixed).includes('[26:40–26:49]'), 'range-end correction auto-applied');
assert.equal(rangeFixed.meta.findings.length, 0, 'applied range fix not also flagged');
const rangeBadEnd = applyFindings(
  { sections: [{ id: 's', heading: 'H', md: 'the push at [26:40–26:49] broke them' }], meta: { warnings: [], findings: [] } },
  [{ field: 'timestamp', issue: '[26:40–26:49]', fix: '[26:40–99:00]', confidence: 'likely' }], rangeSegs);
assert.ok(JSON.stringify(rangeBadEnd).includes('[26:40–26:49]'), 'range fix with an unreal END rejected');
assert.equal(rangeBadEnd.meta.findings.length, 1, 'unreal range end flagged instead');
assert.ok(VERIFY_SYSTEM_PROMPT.includes('RANGE token'), 'verify prompt teaches whole-range citation');

// ── M15: collapse stamp runs ─────────────────────────────────────────────────
// A run of ≥3 whitespace-separated [m:ss] stamps within ≤45s gaps folds to one [first–last] range;
// fewer than 3, a >45s gap, or prose between, leaves the individual stamps. Idempotent on ranges.
assert.equal(collapseStampRuns('the fight [1:00] [1:20] [1:35] [1:50] ended'), 'the fight [1:00–1:50] ended', '4-run within 45s folds');
assert.equal(collapseStampRuns('[0:00] [0:10] [0:20] [0:30] [0:40] [0:50] [1:00]'), '[0:00–1:00]', '7-run folds to one range');
assert.equal(collapseStampRuns('here [2:00] and later [5:00]'), 'here [2:00] and later [5:00]', 'prose between → untouched');
assert.equal(collapseStampRuns('two only [3:00] [3:20]'), 'two only [3:00] [3:20]', '2-run stays individual');
assert.equal(collapseStampRuns('[1:00] [1:20] [3:00] [3:15] [3:30]'), '[1:00] [1:20] [3:00–3:30]', '>45s gap splits; only the tight ≥3 sub-run folds');
assert.equal(collapseStampRuns('no stamps here'), 'no stamps here', 'no stamps → identity');
assert.equal(collapseStampRuns('[1:00–1:50]'), '[1:00–1:50]', 'range token idempotent');
// coerceReport applies it to prose fields but leaves the single-stamp .t fields alone
const m15rep = parseReport(JSON.stringify({
  keepDoing: ['chained [4:00] [4:20] [4:35] focus'],
  macro: { swings: [{ t: '5:00', direction: 'ours', cause: 'won [9:00] [9:20] [9:40] teamfight' }] },
  actionItems: [], qa: [], debates: [], followUps: [],
}));
assert.equal(m15rep.keepDoing[0], 'chained [4:00–4:35] focus', 'coerce folds keepDoing run');
assert.equal(m15rep.macro.swings[0].cause, 'won [9:00–9:40] teamfight', 'coerce folds swings.cause run');
assert.equal(m15rep.macro.swings[0].t, '5:00', 'single-stamp .t field untouched');

// ── M18: stamp sources ───────────────────────────────────────────────────────
// A stamp may glue a source letter to the time: r = VOD review, c = in-game comms, none = game
// clock. Untagged parses as 'clock' ON PURPOSE — that is what makes an unmarked stamp render inert
// instead of guessing a recording and jumping the coach somewhere the moment never happened.
assert.deepEqual(parseStamp('[27:49r]'), { t: '27:49', letter: 'r', source: 'review' });
assert.deepEqual(parseStamp('[8:12c]'), { t: '8:12', letter: 'c', source: 'comms' });
assert.deepEqual(parseStamp('[12:00]'), { t: '12:00', letter: '', source: 'clock' });
assert.deepEqual(parseStamp('[1:07:25r]'), { t: '1:07:25', letter: 'r', source: 'review' }, 'hour form keeps its letter');
assert.deepEqual(parseStamp('[27:49–28:20r]'), { t: '27:49–28:20', letter: 'r', source: 'review' }, 'range keeps one letter');
assert.equal(parseStamp('27:49'), null, 'bare time is not a stamp token');
assert.equal(parseStamp('[27:49x]'), null, 'unknown letter is not a stamp token');

// collapseStampRuns folds a tagged run and keeps the letter on the range, but NEVER folds across
// sources — a range spanning two recordings would claim a stretch of one that the other half of the
// run never happened in.
assert.equal(collapseStampRuns('[1:00r] [1:20r] [1:35r] [1:50r]'), '[1:00–1:50r]', 'same-source run folds, letter kept');
assert.equal(collapseStampRuns('[1:00r] [1:20c] [1:35r]'), '[1:00r] [1:20c] [1:35r]', 'mixed sources never fold');
assert.equal(collapseStampRuns('[1:00c] [1:20c] [1:35c] [4:00r] [4:20r] [4:35r]'), '[1:00–1:35c] [4:00–4:35r]', 'two same-source runs fold separately');
assert.equal(collapseStampRuns('[1:00] [1:20] [1:35r]'), '[1:00] [1:20] [1:35r]', 'untagged never folds into a tagged stamp');

// validateStamps still sees a tagged stamp: the trailing `\b` it used to end on does not exist
// between a digit and a letter, so `27:49r` would have gone silently unvalidated.
assert.ok(validateStamps({ sections: [{ id: 's', heading: 'H', md: 'invented [45:00r]' }] }, stampSegs).includes('45:00'), 'tagged invented stamp still flagged');
assert.deepEqual(validateStamps({ sections: [{ id: 's', heading: 'H', md: 'real [0:01c] and [1:02r]' }] }, stampSegs), [], 'tagged real stamps clean');

// M25 tightening: given a {review, comms} pair instead of one flat array, each stamp is checked
// against the recording its OWN letter names — a review-only moment can no longer pass by happening
// to land inside the in-game recording, which is exactly what the concatenated union allowed.
const srcSegs = { comms: [{ t0Ms: 0, t1Ms: 3000 }], review: [{ t0Ms: 600000, t1Ms: 603000 }] }; // 0:00–0:03 in-game, 10:00–10:03 review
const bySrc = (md) => validateStamps({ sections: [{ id: 's', heading: 'H', md }] }, srcSegs);
assert.deepEqual(bySrc('real [0:01c] and [10:01r]'), [], 'each stamp inside its own recording is clean');
assert.deepEqual(bySrc('[10:01c]'), ['10:01'], 'a review moment tagged in-game is flagged');
assert.deepEqual(bySrc('[0:01r]'), ['0:01'], 'an in-game moment tagged review is flagged');
assert.deepEqual(bySrc('mid boss at [12:00] and 45:00 flat'), [], 'untagged times are game clock, never checked');
assert.deepEqual(validateStamps({ sections: [{ id: 's', heading: 'H', md: '[10:01r]' }] }, { comms: srcSegs.comms }), [], 'a recording that was not supplied has nothing to check against');
assert.deepEqual(bySrc('the run [10:01–10:02r]'), [], 'a real range is clean');
assert.deepEqual(bySrc('the run [45:00–45:20r]'), ['45:00', '45:20'], 'a range is checked at BOTH ends — its one letter carries to the start');

// segIndexForStamp: exact whole-second start, else the first segment at/after, else the last row.
const jumpSegs = [{ t0Ms: 0 }, { t0Ms: 60000 }, { t0Ms: 120000 }];
assert.equal(segIndexForStamp(jumpSegs, '1:00'), 1, 'exact start matches');
assert.equal(segIndexForStamp(jumpSegs, '0:30'), 1, 'falls forward to the next segment');
assert.equal(segIndexForStamp(jumpSegs, '9:99'), 2, 'past the end lands on the last row');
assert.equal(segIndexForStamp(jumpSegs, '1:00–1:40'), 1, 'a range jumps to its START');
assert.equal(segIndexForStamp([], '1:00'), -1, 'no segments → nothing to jump to');

// Both prompts have to TEACH the encoding or the model never emits a letter and every chip dies.
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('Stamp sources:'), 'P2 prompt carries the Stamp sources rule');
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('[27:49r]') && VOD_REPORT_SYSTEM_PROMPT.includes('[8:12c]'), 'P2 rule shows both letters by example');
// The structured single-stamp fields hold a bare time, so the letter rule has to reach them by name
// or a death/callout/qa moment can never become clickable.
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('The short time fields hold a BARE time'), 'P2 rule covers the structured single-stamp fields');

// ── Export to markdown (serializeReportMarkdown) ─────────────────────────────

const exRep = parseReport(JSON.stringify({
  tldr: 'good macro',
  sections: [{ id: 'tempo', heading: 'Tempo', md: 'Hold the push [2:05]\n- step one' }],
  actionItems: [
    { id: 'ward-river', text: 'ward river', count: 2, timestamps: ['1:15', '3:40'], player: 'Sam', status: 'done' },
    { id: 'rotate', text: 'rotate mid', count: 1, timestamps: [], player: null, status: 'pending' },
  ],
  qa: [{ q: 'why dive?', a: 'bad call', askedBy: 'Sam', t: '4:09' }],
  keepDoing: ['early game'], debates: ['item order'],
  followUps: [{ priorItem: 'ward river', verdict: 'persisting', evidence: 'still no wards [6:00]' }],
}));

const mdAll = serializeReportMarkdown(exRep, new Set(['report', 'actions', 'qa', 'keep', 'debates', 'followups']), 'Scrim 2026-07-13');
assert.ok(mdAll.startsWith('# Scrim 2026-07-13\n'));
assert.ok(!mdAll.includes('## TL;DR'), 'TL;DR retired from export');
assert.ok(mdAll.includes('## Tempo'));
assert.ok(mdAll.includes('[2:05]'), 'plain [m:ss] token survives');
assert.ok(mdAll.includes('- [x] ward river ×2 @Sam [1:15] [3:40]'), 'done action item with count+player+stamps');
assert.ok(mdAll.includes('- [ ] rotate mid'), 'pending action item');
assert.ok(mdAll.includes('**[4:09] Sam:** why dive?'), 'qa question line');
assert.ok(mdAll.includes('> bad call'), 'qa answer blockquoted');
assert.ok(mdAll.includes('## Keep Doing\n\n- early game'));
assert.ok(mdAll.includes('## Debates\n\n- item order'));
assert.ok(mdAll.includes('- **persisting** — ward river'), 'followup verdict line');
assert.ok(mdAll.includes('still no wards [6:00]'), 'followup evidence indented');

// selection omits unchecked sections
const mdSome = serializeReportMarkdown(exRep, new Set(['report']), 'X');
assert.ok(mdSome.includes('## Tempo'));
assert.ok(!mdSome.includes('## Action Items'));
assert.ok(!mdSome.includes('## Q&A'));

// empty selection → empty string
assert.equal(serializeReportMarkdown(exRep, new Set(), 'X'), '');

// A selected-but-EMPTY section is dropped, not printed as "_(none)_" — a real export stacked three of
// those headers at the end. Drills render one bullet each: joining with '; ' welded a full stop to the
// separator ("…solo-queue build.; In every fight…") six times in that same export.
const mdEmpty = serializeReportMarkdown({ sections: [{ heading: 'S', md: 'Give the camp up.' }] },
  new Set(['report', 'macro', 'debates', 'followups']), 'X');
assert.ok(!mdEmpty.includes('_(none)_'), 'empty sections are dropped from the export');
assert.ok(!mdEmpty.includes('## Debates'), 'an empty section takes its header with it');
assert.ok(mdEmpty.includes('## S'), 'sections with content still export');
const mdDrills = serializeReportMarkdown({ playerCards: [{ player: 'Sam', drills: ['Queue the scrim build.', 'Pre-plan the route.'] }] },
  new Set(['players']), 'X');
assert.ok(!mdDrills.includes('.;'), 'drills never weld a full stop onto the separator');
assert.equal((mdDrills.match(/\*\*Drill:\*\*/g) || []).length, 2, 'one bullet per drill');

// segments section renders the transcript with m:ss stamps
const mdSeg = serializeReportMarkdown(exRep, new Set(['segments']), 'X', [{ t0Ms: 125000, speaker: 'Coach', text: 'hello' }]);
assert.ok(mdSeg.includes('## Segments (transcript)'));
assert.ok(mdSeg.includes('2:05 Coach hello'));

// M18 export parity: Player Cards / Macro / Comms Grade now serialize (were omitted entirely before).
const exRep2 = parseReport(JSON.stringify({
  playerCards: [{ player: 'Sam', hero: 'Vindicta', lane: 'Lane 1', laneVerdict: 'won lane [3:00]', soulsCurveRead: '', itemCritique: 'greedy', coaching: 'play safer', deathAnalysis: [{ t: '12:00', what: 'dove', why: 'no vision', lesson: 'ward' }], drills: ['last-hit drill'] }],
  macro: { tempoRead: 'slow start [5:00]', laneMap: 'standard', objectiveWindows: [{ t: '20:00', event: 'mid boss', verdict: 'contestable', why: 'cooldowns up' }], swings: [{ t: '25:00', direction: 'ours', cause: 'good fight' }] },
  commsGrade: { overall: 'quiet [8:00]', callouts: [{ t: '9:00', who: 'Sam', call: 'rotate', verdict: 'good', evidence: 'saved a life' }], missed: ['no ult call'] },
}));
const mdCards = serializeReportMarkdown(exRep2, new Set(['players', 'macro', 'comms']), 'X');
assert.ok(mdCards.includes('## Player Cards'), 'player cards H2');
assert.ok(mdCards.includes('### Vindicta (Sam) — Lane 1') && mdCards.includes('**Lane verdict:** won lane [3:00]'), 'player card body + raw stamp');
assert.ok(mdCards.includes('**Death [12:00]:** dove — no vision — Lesson: ward'), 'death line');
assert.ok(mdCards.includes('## Macro') && mdCards.includes('**Tempo:** slow start [5:00]') && mdCards.includes('- [20:00] mid boss — contestable (cooldowns up)'), 'macro body');
assert.ok(mdCards.includes('## Comms Grade') && mdCards.includes('**Overall:** quiet [8:00]') && mdCards.includes('- [9:00] **Sam:** rotate — good (saved a life)') && mdCards.includes('- no ult call'), 'comms body');
// empty player/macro/comms → the whole block is dropped (was "_(none)_" under its header), not a crash
const mdBlank = serializeReportMarkdown(parseReport('{}'), new Set(['players', 'macro', 'comms']), 'X');
assert.ok(!mdBlank.includes('_(none)_'), 'empty sections degrade to nothing at all');
assert.ok(!/## (Player Cards|Macro|Comms Grade)/.test(mdBlank), 'empty sections take their headers with them');
assert.ok(mdBlank.trim().startsWith('# X'), 'the title survives an all-empty export');

// --- WS2 -------------------------------------------------------------------
// M11: tfcomms judgments serialize to one compact block. Neutral (unjudged) calls are dropped;
// a fight with nothing judged shows only in the header count.
const tfFights = [
  { id: 'f1', tStart: 220, tEnd: 245, jumble: { label: 'Jumbled' },
    calls: [{ speaker: 'Sam', atGame: 222, text: 'go mid', verdict: 'wrong', note: 'fight was lost' },
            { speaker: 'Ash', atGame: 230, text: 'nothing', verdict: null, note: '' }],
    missed: [{ what: 'no retreat call', shouldSay: 'back off' }] },
  { id: 'f2', tStart: 600, tEnd: 610, calls: [{ speaker: 'Ash', atGame: 601, text: 'idle', verdict: null }], missed: [] },
];
const tfBlock = serializeTfComms(tfFights, 'Match 1');
assert.ok(tfBlock.startsWith('=== IN-GAME COMMS JUDGMENTS (Match 1) ==='), 'tfcomms block header');
assert.ok(tfBlock.includes('2 fights reviewed, 1 call judged, 1 missed call'), 'tfcomms header counts');
assert.ok(tfBlock.includes('GAME clock'), 'tfcomms warns the times are game clock, not VOD stamps');
assert.ok(tfBlock.includes('Fight 3:40-4:05 (Jumbled):'.replace('-', '–')), 'judged fight line with jumble label');
assert.ok(tfBlock.includes('wrong - Sam 3:42: go mid [fight was lost]'.replace(' - ', ' — ')), 'judged call line');
assert.ok(tfBlock.includes('missed - no retreat call (should have said: "back off")'.replace(' - ', ' — ')), 'missed call line');
assert.ok(!tfBlock.includes('idle') && !tfBlock.includes('nothing'), 'unjudged calls omitted');
assert.ok(!tfBlock.includes('10:00'), 'a fight with nothing judged emits no body line');
assert.equal(serializeTfComms([], 'Match 1'), '', 'no fights -> empty block, prompt omits it');
assert.equal(serializeTfComms(null), '', 'garbage input -> empty block');

// the block reaches the prompt only when passed, and stays out otherwise
const promptTf = buildReportPrompt({ transcriptBlock: 't', tfCommsBlocks: [tfBlock] });
assert.ok(promptTf.includes('IN-GAME COMMS JUDGMENTS (Match 1)'), 'tfcomms block lands in the user prompt');
assert.ok(!buildReportPrompt({ transcriptBlock: 't' }).includes('IN-GAME COMMS JUDGMENTS'), 'no tfcomms -> no block');

// M6: meta.speakerMap coerces (v1/v2 sidecars have none -> {}), garbage shapes degrade instead of crashing
assert.deepEqual(coerceReport({}).meta.speakerMap, {}, 'absent speakerMap -> {}');
assert.deepEqual(coerceReport({ meta: { speakerMap: [] } }).meta.speakerMap, {}, 'array speakerMap -> {}');
const sm = coerceReport({ meta: { speakerMap: { 'Speaker 3': { name: 'Celeste', confidence: 'high', evidence: '[12:04] named' }, 'Speaker 5': { name: 'Ash' } } } }).meta.speakerMap;
assert.deepEqual(sm['Speaker 3'], { name: 'Celeste', confidence: 'high', evidence: '[12:04] named' }, 'full mapping survives');
assert.deepEqual(sm['Speaker 5'], { name: 'Ash', confidence: 'low', evidence: '' }, 'partial mapping defaults to low confidence');

// M5-M13: every WS2 rule block is present in the system prompt, and nothing pre-existing was lost.
for (const needle of [
  'Attribution fidelity', 'Speaker identity', 'meta.speakerMap', 'Debate & nuance fidelity',
  'Causal chains stay joined', 'PROCEDURE for praise', 'Habits with history', 'Prose hygiene',
  // The live North final report (2026-07-25) dropped the ONE segment stating a loss lesson ("we pushed
  // up like too far on their Walker that we lost") out of 999. Praise and questions each had a sweep;
  // lessons — the report's actual product — had none. A single mention is the most losable point there is.
  'PROCEDURE for lessons', 'a single mention is not a small point',
  'Comms Grade grades IN-GAME comms', 'Say-it-once, player cards specifically',
  'Order "sections" as a story',
]) assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes(needle), `WS2 rule present: ${needle}`);
for (const kept of [
  'Canonical names ONLY', 'ANALYST BRAIN is for GROUNDING ONLY', 'PROCEDURE for qa',
  'Quote sparingly', 'Quoting less changes WORDING ONLY', 'NEVER compress a taught framework',
]) assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes(kept), `pre-existing rule kept: ${kept}`);

// Asserted VERBATIM in matchReport.selftest.mjs too — see the note there for the live North run that
// produced both failures. The two prompts must not drift on this rule.
for (const needle of [
  'A comparison or superlative names the pool it ranges over',
  'A count comes from the source data, never from the entries you happened to write up',
]) assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes(needle), `P2 comparison/count rule states: ${needle}`);

// M4 latent: the verify prompt now tells the model which field name makes a stamp fix auto-applicable.
assert.ok(VERIFY_SYSTEM_PROMPT.includes('"timestamp"') && VERIFY_SYSTEM_PROMPT.includes('Timestamp corrections'),
  'verify prompt instructs field:"timestamp" for stamp fixes');

// M17: the carry-forward index coerces (old sidecars have none -> []), normalizes its three kinds,
// and DROPS an entry whose kind the model garbled rather than mis-bucketing it in the M24 export.
assert.deepEqual(coerceReport({}).carry, [], 'absent carry -> []');
const carried = coerceReport({
  carry: [
    { kind: 'habit', text: 'never buys Counterspell since the rework', player: 'Matt', stamp: '[27:49]' },
    { kind: 'PLAN', text: 'draft shred into the next comp' },
    { kind: 'debate', text: 'Rapid Recharge on Infernus left unsettled', player: null, stamp: '' },
    { kind: 'lesson', text: 'a this-match lesson does not carry' },
    { kind: 'habit', text: '' },
  ],
}).carry;
assert.equal(carried.length, 3, 'unknown kind and empty text are dropped');
assert.deepEqual(carried[0], { kind: 'habit', text: 'never buys Counterspell since the rework', player: 'Matt', stamp: '[27:49]' });
assert.deepEqual(carried[1], { kind: 'plan', text: 'draft shred into the next comp', player: null, stamp: '' }, 'kind lower-cases, player/stamp default');
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('CARRY-FORWARD') && VOD_REPORT_SYSTEM_PROMPT.includes('"carry": ['),
  'M17 carry rule + schema key are both in the prompt');

// A .matchfinal is written by THIS coercer and — since the kind-routed read in VodReportView — read
// back by it too. The banner's confirmed/overridden counts and its date die if either key is lost,
// which is exactly what the variant-routed read used to do.
const finalRoundTrip = coerceReport({
  schemaVersion: 2, generated: '2026-07-24T18:00:00Z',
  reconciliation: [{ claim: 'lane lost on wave two', verdict: 'overridden', note: 'the coach put it on the first fight', stamp: '[8:12]' }],
});
assert.equal(finalRoundTrip.generated, '2026-07-24T18:00:00Z', 'matchfinal generated stamp survives coercion');
assert.equal(finalRoundTrip.reconciliation.length, 1, 'matchfinal reconciliation survives coercion');
assert.equal(finalRoundTrip.reconciliation[0].verdict, 'overridden');

// A cancel during the verify pass must ABORT the whole report, not degrade to "Pass 2 skipped" and
// ship anyway. The degrade branch swallows every other failure by design, so without the rethrow
// the stop button would burn the draft's money and still save an unverified report.
const cancelErr = Object.assign(new Error('cancelled by the user'), { code: 'CANCELED' });
await assert.rejects(
  verifyReport(async () => { throw cancelErr; }, { report: { sections: [], meta: { warnings: [] } } }),
  (e) => e.code === 'CANCELED',
  'a cancel in the verify pass propagates instead of degrading',
);
// while a plain transport failure still degrades to an un-verified report, as before
const degraded = await verifyReport(async () => { throw new Error('claude timed out'); }, { report: { sections: [], meta: { warnings: [] } } });
assert.equal(degraded.ran, false, 'a timeout still degrades rather than aborting');
assert.ok(degraded.report.meta.warnings.some((w) => w.startsWith('Pass 2 skipped')), 'degrade still warns');

// ---- Wording rules: the report reads as a LESSON, not as minutes of a meeting -------------------
// The user's complaint was that "He asked for one tried-and-true build per hero he can queue almost
// every game" reads like a transcript summary. The fix is a voice rule in the prompt; these pin its
// load-bearing clauses so a later prompt edit cannot quietly drop them.
for (const needle of [
  'VOICE — NO POINT OF VIEW',
  'are BANNED as ways of addressing or describing the',
  'An INSTRUCTION is a bare command with no subject',
  'a reflexive that IS the meaning may',
  'is a LABELLED FACT with no subject',
  'Never narrate the session',
  'runs on into its sentence',
  'PLAIN WORDS, first-read comprehension',
  'Game terms stay EXACT and untranslated',
  'Prose economy is TIME-TO-ABSORB, not word count',
  'chopped stubs read',
  'never stack two turn-words',
  'HARD CEILING: 35 words per sentence, counted.',
  'the colon or dash joining them IS the split point',
  // The voice rule sat under the "Section rules:" header, so the model applied it to sections and
  // nowhere else — five real leaks landed in action items and qa answers. It is report-wide now.
  'This binds the ENTIRE report, not just section prose',
  'every action item, keepDoing line, debate, qa answer',
  'A DESCRIPTION is not a',
  'is a NAME, not a',
  'keeps the question in the asker',
  'Test every lead by reading ONLY the bold text',
]) assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes(needle), `P2 voice rule states: ${needle}`);
// The voice rule must sit ABOVE the section-rules header, or it reads as section-only again.
assert.ok(VOD_REPORT_SYSTEM_PROMPT.indexOf('VOICE — NO POINT OF VIEW') < VOD_REPORT_SYSTEM_PROMPT.indexOf('Section rules:'),
  'the voice rule is stated report-wide, before the section-rules block');
assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes('"drills": [] },                // ALWAYS EMPTY'),
  'drills are merged into actionItems — one homework list, never two');
// Density must NOT have been traded away for the new flowing voice — every point still survives.
for (const kept of [
  'every point and every stamp stays',
  'reproduced in FULL',
  'A bare topic label is the',
]) assert.ok(VOD_REPORT_SYSTEM_PROMPT.includes(kept), `pre-existing density rule kept: ${kept}`);
// P1 carries the plain-word half of the same house style (it has no single "you" to address).
assert.ok(MATCH_REPORT_SYSTEM_PROMPT.includes('Prose economy is TIME-TO-ABSORB, not word count'),
  'P1 carries the absorption rule verbatim');
assert.ok(MATCH_REPORT_SYSTEM_PROMPT.includes('Game terms (hero, item, ability, map, objective names) stay EXACT'),
  'P1 keeps game terms exact');

// checkProse — the free deterministic half. One probe per flag, each on prose that trips ONLY it.
const oneCard = (coaching) => ({ playerCards: [{ player: 'p', coaching }], sections: [], keepDoing: [] });
const flagsFor = (coaching) => checkProse(oneCard(coaching)).join(' | ');
assert.match(flagsFor('Rescue Beam synergises with the high ground.'), /fancy wording/, 'fancy word flagged');
assert.match(flagsFor('He gave up the camp early.'), /third person/, 'he/his flagged — the report carries no point of view');
assert.match(flagsFor('Give up your camp when a fight starts.'), /second person/, 'you/your flagged too');
assert.deepEqual(checkProse(oneCard('**Stop cubing yourself** — that is exactly what the enemy wants.')), [],
  'a reflexive inside an imperative is the one carve-out');
assert.deepEqual(checkProse(oneCard('The coach reached E6 as a support player, and he says it is possible.')), [],
  'he/his is excused where it names the coach, a real third party');
assert.match(flagsFor('However the camp is worth less, regardless of the timer.'), /two turn-words/, 'doubled turn-word flagged');
assert.match(flagsFor('Sensitivity was checked before the game.'), /passive voice/, 'passive voice flagged');
assert.match(flagsFor(`Give the camp up ${'because it is worth far less than the fight '.repeat(5)}.`), /\d+-word sentence/, 'over-long sentence flagged');
// The approved house voice — bare orders plus labelled facts — trips nothing.
assert.deepEqual(checkProse(oneCard('**Give the far camp up.** A far-side tier two is worth about 300 souls, and being in position for the fight is worth more. Current habit, raised unprompted: a far tier two taken while the team fights.')), [],
  'orders plus labelled facts raise no style flag');
assert.ok(checkProse(oneCard(`bad. ${'However regardless. '.repeat(20)}`)).length <= 8, 'style flags are capped');
// ...but the cap must not hide SCALE: a live run held 25 over-limit sentences and surfaced 7. The true
// total is reported past the cap, so 20 long sentences read as drift rather than as a handful of nits.
const long = `Give the camp up ${'because it is worth far less than the fight '.repeat(5)}. `;
const manyLong = checkProse(oneCard(long.repeat(20)));
assert.match(manyLong[manyLong.length - 1], /20 sentences over 35 words/, 'true over-limit total escapes the flag cap');
assert.ok(!checkProse(oneCard('Give the far camp up. It is worth about 300 souls.')).some((f) => /over 35 words/.test(f)),
  'no total line when every sentence is inside the ceiling');
// Every reader-facing field is scanned, not just sections/keepDoing/cards — a 58-word "debates" entry
// was invisible to the first version.
for (const [field, report] of [
  ['debates', { debates: ['He gave up the camp early.'] }],
  ['qa', { qa: [{ q: 'when?', a: 'He gave up the camp early.' }] }],
  ['actionItems', { actionItems: [{ text: 'He gave up the camp early.' }] }],
  ['macro', { macro: { overall: 'He gave up the camp early.' } }],
  ['comms', { commsGrade: { missed: ['He gave up the camp early.'] } }],
]) assert.match(checkProse(report).join(' | '), new RegExp(`${field}.*third person`), `${field} is style-checked too`);
// The cap must SPREAD: one drifting section used to eat all 8 flags and hide every other place.
const drift = { sections: [1, 2, 3, 4].map((n) => ({ heading: `S${n}`, md: 'He gave up the camp early. '.repeat(5) })) };
assert.equal(new Set(checkProse(drift).filter((f) => f.includes('section "')).map((f) => f.split(':')[0])).size, 4,
  'flags spread across all four sections');
// ...and a broken rule must outrank a cosmetic nit. Eight sections of passive voice used to fill every
// slot before the checker ever reached the action items, where the real POV leaks were.
const buried = {
  sections: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ heading: `S${n}`, md: 'The camp was cleared before the fight started.' })),
  actionItems: [{ text: 'Play matchmaking with your scrim build.' }],
  playerCards: [{ player: 'p', drills: ['Pre-plan your escape route.'] }],
};
const bf = checkProse(buried);
assert.ok(bf.some((f) => /actionItems.*second person/.test(f)), 'a POV leak in actionItems outranks eight passive-voice nits');
assert.ok(bf.some((f) => /drills.*second person/.test(f)), 'drills are style-checked too');
assert.ok(bf.some((f) => /2 point-of-view leaks in the report/.test(f)), 'POV total is reported past the cap');

// splitLongSentences — the ceiling's last resort. Two live runs breached the 35-word limit with the rule
// stated in the prompt, so an over-long sentence is broken mechanically at the join. Timid by design.
const long40 = 'The far-side tier two trades roughly three hundred souls for a fight the team is already taking without it: the camp will still be standing in ninety seconds and the fight will not, so the trade is a loss every time.';
const longRep = { sections: [{ heading: 'S', md: long40 }] };
assert.equal(splitLongSentences(longRep), 1, 'an over-long sentence is split at its join');
assert.ok(longRep.sections[0].md.includes('. The camp will still be standing'), 'the second half is re-capitalised');
assert.ok(!checkProse(longRep).some((f) => /word sentence/.test(f)), 'the split clears the flag');
// A sentence with no safe join is left ALONE for the checker to flag, never mangled.
const noJoin = { sections: [{ heading: 'S', md: `Give the camp up ${'because it is worth far less than the fight '.repeat(5)}.` }] };
assert.equal(splitLongSentences(noJoin), 0, 'no safe join → no split');
// Never inside a bolded lead, never in a table row, never leaving a stub half.
const bold = { sections: [{ heading: 'S', md: `**Give the far camp up — it is worth about three hundred souls.** ${'and the fight is worth far more than that '.repeat(6)}.` }] };
splitLongSentences(bold);
assert.ok(bold.sections[0].md.startsWith('**Give the far camp up — it is worth about three hundred souls.**'), 'a bolded lead is never split apart');
const table = { sections: [{ heading: 'S', md: `| item | why |\n| Rescue Beam | ${'it works with the position already wanted and never comes out of the build '.repeat(3)} |` }] };
assert.equal(splitLongSentences(table), 0, 'table rows are left alone');
const stub = { sections: [{ heading: 'S', md: `Stated: ${'the aim goes jittery in every teamfight and it feels like brain lag '.repeat(4)}.` }] };
splitLongSentences(stub);
assert.ok(stub.sections[0].md.startsWith('Stated: the aim'), 'a join leaving a stub half is skipped');
// A bolded lead closes after its own full stop, so the splitter must consume the trailing "**" or it
// welds the lead onto the next sentence and reports one long one. Four false flags on the first live run.
assert.deepEqual(checkProse(oneCard('**Low economy on Viscous is a feature.** The camps skipped there go to teammates who convert them into more, and the jungle never needs clearing on cooldown [52:21r].')), [],
  'a bolded lead is its own sentence, not a prefix on the next one');

// FOLLOW-UPS gate: with no prior action items supplied there is no earlier homework to judge, so
// any follow-up the model emits anyway is dropped in code. MatchPage feeds priorActionItems from
// openHomework(), which has been non-empty on every real run — this guards the first scrim, where
// invented "since last time" items would read as history the reader has no way to falsify.
const inventedFollowUps = JSON.stringify({
  sections: [], actionItems: [], qa: [], keepDoing: [], debates: [], carry: [],
  followUps: [{ priorItem: 'stop cubing yourself', verdict: 'persisting', evidence: 'he still does it [7:17r]' }],
});
const noPriors = await generateReport(async () => inventedFollowUps, { transcriptBlock: 'T', teams: {}, coachedTeam: '' });
assert.deepEqual(noPriors.followUps, [], 'follow-ups invented with no prior list are dropped');
assert.ok(noPriors.meta.warnings.some((w) => w.startsWith('Dropped 1 follow-up')), 'the drop is warned, never silent');
const withPriors = await generateReport(async () => inventedFollowUps, {
  transcriptBlock: 'T', teams: {}, coachedTeam: '', priorActionItems: [{ id: 'cube', text: 'stop cubing yourself' }],
});
assert.equal(withPriors.followUps.length, 1, 'a supplied prior list still yields follow-ups');

console.log('vodReport.selftest: all assertions passed');

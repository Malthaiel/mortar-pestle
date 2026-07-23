// Runnable check for vodReport.js pure logic (no framework): `node vodReport.selftest.mjs`.
// Covers the parts that break silently — transcript formatting, tolerant parse (fenced + noisy),
// coercion of a missing id, and checkbox reconcile across a regenerate.
import assert from 'node:assert/strict';
import { mmss, slugId, buildTranscriptBlock, buildReportPrompt, parseReport, reconcileReport, serializeReportMarkdown, buildNormalizePrompt, parseCorrections, applyCorrections, transcriptHash, normalizeTranscript, parseFindings, applyFindings, verifyReport, validateStamps } from './vodReport.js';

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
assert.deepEqual(v1.meta, { passes: [], brainSections: [], warnings: [], findings: [] });

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

// segments section renders the transcript with m:ss stamps
const mdSeg = serializeReportMarkdown(exRep, new Set(['segments']), 'X', [{ t0Ms: 125000, speaker: 'Coach', text: 'hello' }]);
assert.ok(mdSeg.includes('## Segments (transcript)'));
assert.ok(mdSeg.includes('2:05 Coach hello'));

console.log('vodReport.selftest: all assertions passed');

// The `correct-report` recipe (Move 14): regenerate a scrim's VOD report with
// the coach's recorded corrections (.vodfeedback entries + an optional free-text
// correction from the chat turn) as AUTHORITATIVE input. The hidden chat turn is
// Pass 1 (the grounded draft — the Analyst system prompt already carries the
// brain, so it is not duplicated here); the tray previews a before/after diff of
// the Report + Action Items sections; Apply re-runs Pass 2 (the read-only
// tool-armed fact-check, which degrades to a warning) and writes the .vodreport
// sidecar. Pass 0 reuses the .vodnorm cache deterministically — no model call in
// loadContext. Checkbox state carries via reconcileReport. The Team page regen is
// left to the next Generate Report run (the sidecar is the source of truth).
// Trigger: a "correct: …" chat message in a match-pointed Analyst window, or
// openAnalyst({ recipe: 'correct-report', target: { scrimPath, note } }).

import { api, invoke } from '../../api.js';
import MarkdownDiff from '../../components/agents/MarkdownDiff.jsx';
import { scrimSidecarPath, sidecarPath } from '@modules/core/game-wiki/matchData.js';
import {
  VOD_REPORT_SYSTEM_PROMPT, buildReportPrompt, parseReport, reconcileReport, coerceReport,
  serializeReportMarkdown, buildTranscriptBlock, applyCorrections, transcriptHash,
  verifyReport, REPORT_SCHEMA_VERSION,
} from '@modules/core/game-wiki/vodReport.js';
import { buildMatchDigest } from '@modules/core/game-wiki/matchDigest.js';
import { LEXICON_PATH } from '@modules/core/game-wiki/analystBrain.js';
import { openHomework, teamSidecarPath } from '@modules/core/game-wiki/teamProgress.js';
import { parseCommsSidecar } from '@modules/core/game-wiki/commsCompile.js';

const baseName = (p) => String(p).replace(/\.md$/, '').split('/').pop();

export const correctReport = {
  id: 'correct-report',
  label: 'Correct the report',

  // Everything the re-draft needs, read deterministically (missing pieces degrade like
  // generateVodReport: no digests / notes / homework just narrows the prompt).
  async loadContext(target) {
    const scrimPath = String(target?.scrimPath || '');
    if (!scrimPath) throw { code: 'NO_MATCH', message: 'Open the Analyst from a report window (Ask Analyst) so it knows the scrim.' };
    const read = async (p) => String((await api.getRawFileMeta(p, 'gamewiki')).content);

    let prior;
    try { prior = coerceReport(JSON.parse(await read(scrimSidecarPath(scrimPath, 'vodreport')))); }
    catch { throw { code: 'NO_REPORT', message: 'No report to correct — Generate Report on the scrim first.' }; }

    let entries = [];
    try {
      const j = JSON.parse(await read(scrimSidecarPath(scrimPath, 'vodfeedback')));
      entries = Array.isArray(j.entries) ? j.entries : [];
    } catch { /* no feedback sidecar yet */ }
    const note = String(target?.note || '').trim();
    if (!entries.length && !note) {
      throw { code: 'NO_FEEDBACK', message: 'No corrections recorded — mark items Wrong / Edit / Note in the report window, or write the correction after "correct:".' };
    }

    // transcript, with the cached Pass-0 normalization re-applied when the hash still matches
    let segments = [];
    try { segments = parseCommsSidecar(await read(scrimSidecarPath(scrimPath, 'vodcomms'))).segments; } catch { /* report can re-draft from the prior report alone */ }
    try {
      const c = JSON.parse(await read(scrimSidecarPath(scrimPath, 'vodnorm')));
      if (c.hash === transcriptHash(segments)) segments = applyCorrections(segments, c.corrections).segments;
    } catch { /* no cache — un-normalized transcript */ }

    // scrim page → teams + match numbers for the deterministic digests
    let md = '';
    try { md = await read(scrimPath); } catch { /* teams/digests degrade */ }
    const fmVal = (k) => (md.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim() || '';
    const coachedTeam = fmVal('Coached Team') || fmVal('Team 1');
    const opponent = (fmVal('Team 1') === coachedTeam ? fmVal('Team 2') : fmVal('Team 1')) || '';
    const matchDigests = [];
    for (const m of md.matchAll(/^## Match (\d+)/gm)) {
      try { matchDigests.push(buildMatchDigest(JSON.parse(await read(sidecarPath(scrimPath, Number(m[1])))), { label: `Match ${m[1]}` })); }
      catch { /* no match data for this one */ }
    }

    let priorActionItems = [];
    try { priorActionItems = openHomework(JSON.parse(await read(teamSidecarPath(coachedTeam)))); } catch { /* no team memory yet */ }
    let notesBlock = '';
    try { notesBlock = await read(scrimSidecarPath(scrimPath, 'vodnotes')); } catch { /* no notes */ }
    let lexicon = '';
    try { lexicon = await read(LEXICON_PATH); } catch { /* verify degrades */ }

    return {
      scrimPath, prior, entries, note, coachedTeam, opponent, matchDigests,
      priorActionItems, notesBlock, lexicon,
      transcriptBlock: buildTranscriptBlock(segments), name: baseName(scrimPath),
    };
  },

  buildPrompt(ctx) {
    return [
      'Regenerate the VOD report below. The coach corrections are AUTHORITATIVE — obey them over the',
      'transcript and over the prior report. Follow this contract exactly:',
      '',
      VOD_REPORT_SYSTEM_PROMPT,
      '',
      '=== COACH CORRECTIONS (AUTHORITATIVE) ===',
      ...ctx.entries.map((e) => JSON.stringify(e)),
      ...(ctx.note ? [`Free-text correction: ${ctx.note}`] : []),
      '',
      '=== PRIOR REPORT (being corrected) ===',
      JSON.stringify(ctx.prior),
      '',
      buildReportPrompt({
        transcriptBlock: ctx.transcriptBlock, teams: { opponent: ctx.opponent }, coachedTeam: ctx.coachedTeam,
        priorActionItems: ctx.priorActionItems, notesBlock: ctx.notesBlock, matchDigests: ctx.matchDigests,
      }),
    ].join('\n');
  },

  parse(text, ctx) {
    const fresh = parseReport(text);
    fresh.schemaVersion = REPORT_SCHEMA_VERSION;
    const report = reconcileReport(fresh, ctx.prior); // done/pending checkboxes survive
    const SEL = new Set(['report', 'actions']);
    return {
      report, ctx,
      before: serializeReportMarkdown(ctx.prior, SEL, `${ctx.name} (before)`),
      after: serializeReportMarkdown(report, SEL, `${ctx.name} (corrected)`),
    };
  },

  renderConfirm(proposal, { onApply, onDiscard, applying }) {
    return (
      <MarkdownDiff
        before={proposal.before}
        after={proposal.after}
        onApply={onApply}
        onDiscard={onDiscard}
        applying={applying}
      />
    );
  },

  // Apply = Pass 2 on the corrected draft (can take minutes; degrades to a warning), then the write.
  async apply(proposal) {
    const { ctx } = proposal;
    const { report, ran } = await verifyReport(invoke, { report: proposal.report, matchDigests: ctx.matchDigests, lexicon: ctx.lexicon }, {});
    report.meta.passes = ['draft(corrected)', ...(ran ? ['verify'] : [])];
    await api.savePage(scrimSidecarPath(ctx.scrimPath, 'vodreport'), JSON.stringify(report), null, 'gamewiki');
  },
};

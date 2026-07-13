// The `analyst-teach` recipe: distill a coach-taught fact into the Analyst
// brain (GameWiki vault) with a diff preview in the RecipeTray before any disk
// write. Mirrors organize-md's lifecycle; the distiller contract + the
// never-lose-information shrinkage guard live in analystBrain.js (shared with
// Phase B's correct-report/learn recipes). Trigger: a "teach: …" chat message
// in the Analyst window, or openAnalyst({ recipe: 'analyst-teach', target: { text } }).

import { api } from '../../api.js';
import MarkdownDiff from '../../components/agents/MarkdownDiff.jsx';
import {
  buildDistillerPrompt, parseDistillerOutput, distilledShrunk, replaceDistilled, addMishears,
  parseMishears, sectionOf, CONCEPTS_PATH, CORRECTIONS_PATH, LEXICON_PATH,
} from '@modules/core/game-wiki/analystBrain.js';

const label = (name, body) => `=== ${name} ===\n${String(body).trim() || '(empty)'}`;

export const analystTeach = {
  id: 'analyst-teach',
  label: 'Teach the Analyst',

  // ctx = the taught text + the three brain pages (full markdown, for merge + write).
  async loadContext(target) {
    const text = String(target?.text || '').trim();
    if (!text) throw { code: 'NO_TEXT', message: 'Nothing to teach — write the fact after "teach:".' };
    const read = async (p) => String((await api.getRawFileMeta(p, 'gamewiki')).content);
    const [conceptsPage, correctionsPage, lexiconPage] = await Promise.all([
      read(CONCEPTS_PATH), read(CORRECTIONS_PATH), read(LEXICON_PATH),
    ]);
    return { text, conceptsPage, correctionsPage, lexiconPage };
  },

  buildPrompt(ctx) {
    return buildDistillerPrompt({
      taught: ctx.text,
      concepts: sectionOf(ctx.conceptsPage, 'Distilled'),
      corrections: sectionOf(ctx.correctionsPage, 'Distilled'),
      mishears: parseMishears(ctx.lexiconPage),
    });
  },

  // Shrinkage guard runs at parse (before the preview) so a lossy merge surfaces
  // as a tray error and never reaches Apply.
  parse(text, ctx) {
    const out = parseDistillerOutput(text);
    const beforeCon = sectionOf(ctx.conceptsPage, 'Distilled');
    const beforeCor = sectionOf(ctx.correctionsPage, 'Distilled');
    if (distilledShrunk(beforeCon, out.concepts)) {
      throw { code: 'SHRINKAGE', message: 'Concepts Distilled shrank >20% without a SUPERSEDED marker — write refused; merge by hand.' };
    }
    if (distilledShrunk(beforeCor, out.corrections)) {
      throw { code: 'SHRINKAGE', message: 'Corrections Distilled shrank >20% without a SUPERSEDED marker — write refused; merge by hand.' };
    }
    const before = [label('Concepts — Distilled', beforeCon), label('Corrections — Distilled', beforeCor)].join('\n\n');
    const after = [
      label('Concepts — Distilled', out.concepts || beforeCon),
      label('Corrections — Distilled', out.corrections || beforeCor),
      out.mishears.length ? label('New mishears', out.mishears.map(([h, c]) => `| ${h} | ${c} |`).join('\n')) : '',
    ].filter(Boolean).join('\n\n');
    return { ...out, before, after, ctx };
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

  // Only pages the distiller actually changed are written; each write replaces
  // ## Distilled and appends a dated ## Log line (mishears append to the table).
  async apply(proposal) {
    const { ctx } = proposal;
    const stamp = new Date().toISOString().slice(0, 10);
    const logLine = `${stamp} — taught: ${ctx.text.replace(/\s+/g, ' ').slice(0, 160)}`;
    if (proposal.concepts && proposal.concepts.trim() !== sectionOf(ctx.conceptsPage, 'Distilled')) {
      await api.savePage(CONCEPTS_PATH, replaceDistilled(ctx.conceptsPage, proposal.concepts, logLine), null, 'gamewiki');
    }
    if (proposal.corrections && proposal.corrections.trim() !== sectionOf(ctx.correctionsPage, 'Distilled')) {
      await api.savePage(CORRECTIONS_PATH, replaceDistilled(ctx.correctionsPage, proposal.corrections, logLine), null, 'gamewiki');
    }
    const newLex = addMishears(ctx.lexiconPage, proposal.mishears);
    if (newLex !== ctx.lexiconPage) {
      await api.savePage(LEXICON_PATH, newLex, null, 'gamewiki');
    }
  },
};

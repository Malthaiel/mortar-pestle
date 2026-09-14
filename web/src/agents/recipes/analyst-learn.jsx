// The `analyst-learn` recipe (Move 14): distill the coach's recorded report
// corrections (.vodfeedback entries) into durable brain lessons — name mishears
// to the Lexicon Mishears map, concept/team facts to Concepts, report-mistake
// rules to Corrections. Same distiller lifecycle + shrinkage guard as
// analyst-teach (makeDistillRecipe); only the input differs. Trigger: a "learn"
// chat message in a match-pointed Analyst window, or
// openAnalyst({ recipe: 'analyst-learn', target: { scrimPath } }).

import { api } from '../../api.js';
import { scrimSidecarPath } from '@modules/core/deadlock/matchData.js';
import { makeDistillRecipe, loadBrainPages } from './analyst-teach.jsx';

const baseName = (p) => String(p).replace(/\.md$/, '').split('/').pop();

export const analystLearn = makeDistillRecipe({
  id: 'analyst-learn',
  label: 'Learn from corrections',
  async loadContext(target) {
    const scrimPath = String(target?.scrimPath || '');
    if (!scrimPath) throw { code: 'NO_MATCH', message: 'Open the Analyst from a report window (Ask Analyst) so it knows the scrim.' };
    let entries = [];
    try {
      const j = JSON.parse(String((await api.getRawFileMeta(scrimSidecarPath(scrimPath, 'vodfeedback'), 'deadlock')).content));
      entries = Array.isArray(j.entries) ? j.entries : [];
    } catch { /* no feedback sidecar yet */ }
    if (!entries.length) throw { code: 'NO_FEEDBACK', message: 'No corrections recorded on this report yet — mark items Wrong / Edit / Note in the report window first.' };
    return { feedback: entries, scrimBase: baseName(scrimPath), ...(await loadBrainPages()) };
  },
  logLineOf: (ctx) => `learned from report corrections: ${ctx.scrimBase}`,
});

// Analyst — the Deadlock coach-analyst agent's system prompt. Mirrors
// makeConciergeSystem's shape (`({ backend }) => Promise<string>` builder for
// useAgentChat) but assembles the persona OVER the Analyst brain
// (buildBrainContext — the same context the report passes read), plus an
// optional match pointer so the chat opens aimed at a specific scrim/match.
// Rebuilt per send, so brain edits land on the next turn without a reopen.

import { api } from '../../api.js';
import { buildBrainContext } from '@modules/core/game-wiki/analystBrain.js';

export function makeAnalystSystem({ scrimPath = '', matchN = null } = {}) {
  return async ({ backend } = {}) => { // eslint-disable-line no-unused-vars
    let coachedTeam = '';
    let matchBlock = '';
    if (scrimPath) {
      try {
        const { content } = await api.getRawFileMeta(scrimPath, 'gamewiki');
        const m = String(content).match(/^Coached Team:\s*(.+)$/m) || String(content).match(/^Team 1:\s*(.+)$/m);
        coachedTeam = m ? m[1].trim() : '';
      } catch { /* scrim page unreadable — chat still works unpointed */ }
      matchBlock = [
        '',
        `The user is pointed at scrim "${scrimPath}"${matchN != null ? `, match ${matchN}` : ''}` +
        `${coachedTeam ? ` (coached team: ${coachedTeam})` : ''}. Their questions default to this match.`,
      ].join('\n');
    }
    const brain = await buildBrainContext(api, { coachedTeam });
    return [
      'You are the Deadlock Analyst — an elite Deadlock coach-analyst inside Mortar & Pestle.',
      'You answer questions about matches, scrims, players, and the meta using the brain context below.',
      'Canonical names only (see LEXICON). Every claim cites evidence from the brain, match data, or',
      'transcript the user shares — never invent stats, events, or timestamps.',
      'You never free-write the brain or a report from chat — writes run as reviewed recipes with a',
      'preview. Tell the user the exact prefixes when relevant: "teach: <fact>" distills a durable fact',
      'into the brain; in a match-pointed chat, "correct: <optional note>" regenerates that report with',
      'their recorded corrections authoritative, and "learn" distills those corrections into the brain.',
      'Per-item corrections (Wrong / Edit / Note) are recorded in the report window itself.',
      matchBlock,
      '',
      brain.text,
    ].join('\n');
  };
}

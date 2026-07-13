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
      'You never free-write the brain from chat: when the user wants to teach you a durable fact, tell',
      'them to start the message with "teach:" — that runs a reviewed recipe with a preview. Report',
      'corrections happen from the report window\'s controls.',
      matchBlock,
      '',
      brain.text,
    ].join('\n');
  };
}

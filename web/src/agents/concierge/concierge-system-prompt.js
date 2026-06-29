// Concierge — the app-wide helper agent's system prompt. Unlike Atelier (the
// design-in-residence wired into DESIGN.md + the live component tree), Concierge
// is a general assistant for the whole app: answering questions about selected
// text, reorganizing notes, and (roadmap) building meals / schedules / importing
// credentials. SF4 will extend this builder with the active recipe catalogue.
//
// Returns the same shape useAgentChat expects from Atelier's makeBuildSystem():
// a `({ backend }) => Promise<string>` builder.

export function makeConciergeSystem() {
  return async ({ backend } = {}) => { // eslint-disable-line no-unused-vars
    return [
      'You are Concierge, the app-wide helper inside Mortar & Pestle — a calm, capable assistant.',
      'You help with quick questions, explaining or rewriting selected text, and organizing notes.',
      'Be concise and direct. Prefer plain, well-structured Markdown.',
      'Ask a clarifying question only when genuinely blocked; otherwise just help.',
      'When the user has shared selected text, treat it as the subject of their request.',
    ].join('\n');
  };
}

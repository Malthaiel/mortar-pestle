// SF4 — the Concierge recipe registry. Each recipe is a structured task the
// helper performs via a forced single-turn round-trip + a confirm tray, never
// an autonomous tool loop (v1). A recipe owns its whole lifecycle:
//   loadContext(target) → ctx           (read the inputs; may capture mtime)
//   buildPrompt(ctx)     → string       (the isolated user-turn prompt)
//   parse(text, ctx)     → proposal      (typed result from the model output)
//   renderConfirm(proposal, { onApply, onDiscard, applying }) → JSX
//   apply(proposal)      → Promise       (execute via existing IPC)
//
// Recipes trigger explicitly (a viewer action / picker), so Concierge's system
// prompt needs no recipe catalogue in v1 — the recipe drives its own prompt.

import { organizeMd } from './organize-md.jsx';

export const RECIPES = {
  [organizeMd.id]: organizeMd,
};

export function getRecipe(id) {
  return RECIPES[id] || null;
}

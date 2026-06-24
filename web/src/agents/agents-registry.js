// Agent registry — the catalog of agents the app offers. Atelier is the
// design-in-residence (Design Mode); Concierge is the app-wide helper. The dock
// "Agents" popover (SF3) reads this to list launchable agents; each entry owns
// how it launches and where it lives.
//
// Kept metadata-only for now — component / launch wiring lands with each agent's
// own sub-feature so this file never gates a working agent.

export const AGENTS_REGISTRY = {
  atelier: {
    id: 'atelier',
    label: 'Atelier',
    tagline: 'design-in-residence',
    // Launches Design Mode (settings.agents.mode) — see DesignModeOverlay.
    launch: 'design-mode',
  },
  concierge: {
    id: 'concierge',
    label: 'Concierge',
    tagline: 'app-wide helper',
    // Opens the Concierge floating window — see ConciergeProvider (SF2).
    launch: 'window',
  },
};

export function listAgents() {
  return Object.values(AGENTS_REGISTRY);
}

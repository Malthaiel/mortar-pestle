// Agents module — owns the app-wide Concierge helper. Concierge mounts via the
// ConciergeProvider (a ComposedProviders provider, so it streams across route
// changes); Atelier (Design Mode) stays host-level. The dock "Agents" button
// (host-level DockAgentsButton) launches both. This module's card in Settings →
// Modules carries `settingsTarget: {tab:'agents'}`, so its gear opens the Agents
// settings tab rather than a module page.

import ConciergeProvider from '@host/agents/concierge/ConciergeProvider.jsx';
import AnalystProvider from '@host/agents/analyst/AnalystProvider.jsx';

export default {
  register(api) {
    api.slots.registerProvider(ConciergeProvider);
    api.slots.registerProvider(AnalystProvider);
  },
};

// Domain Builder module — registers the provider + overlay and a Cmd+K
// launcher. No left-sidebar slot (so no Dock pill) and no route; the wizard is
// a global overlay opened via the `domain-builder:open` shared event.

import { registerCommandAction } from '@host/command-actions.js';
import { sharedEvents } from '@host/module-sdk/index.js';

import { DomainBuilderProvider, OPEN_EVENT } from './state.jsx';
import { DomainBuilderOverlay } from './Overlay.jsx';

export default {
  register(api) {
    api.slots.registerProvider(DomainBuilderProvider);
    api.slots.registerOverlay(DomainBuilderOverlay);

    registerCommandAction({
      id: 'domain-builder.new',
      label: 'New Domain…',
      hint: 'Scaffold a Knowledge domain + /transcript pipeline',
      keywords: ['domain', 'knowledge', 'scaffold', 'pipeline', 'create'],
      run: () => sharedEvents.emit(OPEN_EVENT, {}),
    });
  },
};

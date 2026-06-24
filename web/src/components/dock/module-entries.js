// Synthesizes dock-button entries for modules from registered left-sidebar
// slots + module manifests. Each entry swaps to the module on click and
// reflects activeModuleId so the active styling tracks the current selection.
// Entries are returned in registry (load) order; their position in the dock is
// governed by the unified `dock.order` setting, which holds both built-in
// button ids and `module:<id>` ids.

import { useMemo } from 'react';
import { useLeftSidebarSlots, useManifests, usePageSidebars } from '../../module-sdk/useModuleRegistry.js';
import { useActiveModule } from '../../hooks/useActiveModule.jsx';
import { useHashRoute } from '../../router.js';
import * as hostIcons from '../icons.jsx';

export function useModuleDockEntries() {
  const rawSlots = useLeftSidebarSlots();
  const manifests = useManifests();
  const { activeModuleId, setActiveModule } = useActiveModule();
  const pageSidebars = usePageSidebars();
  const route = useHashRoute();
  // While a non-module page sidebar owns the current route (e.g. Docs), the
  // displaced module must NOT show active — only the page's own dock button does.
  const pageOwnsSidebar = !!(route.page && pageSidebars[route.page]);

  return useMemo(() => {
    return rawSlots.map(slot => {
      const manifest = manifests[slot.moduleId];
      if (!manifest) return null;
      const Icon = manifest.iconKey && hostIcons[manifest.iconKey]
        ? hostIcons[manifest.iconKey]
        : null;
      return {
        id: `module:${slot.moduleId}`,
        moduleId: slot.moduleId,
        group: 'modules',
        Icon,
        label: manifest.name,
        onClick: () => setActiveModule(slot.moduleId, { source: 'dock-click' }),
        isActive: () => !pageOwnsSidebar && activeModuleId === slot.moduleId,
      };
    }).filter(Boolean);
  }, [rawSlots, manifests, activeModuleId, setActiveModule, pageOwnsSidebar]);
}

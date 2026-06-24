// Collapsed-mode body for the right sidebar. Maps right-sidebar slots
// through each module's optional `renderRail({ accent, variant })`. Slots
// without a renderRail fall through to RailEmptyState showing the
// module's manifest name rotated vertically.
//
// Right-click on any tile that exposes `railVariants` opens the app-wide
// context menu (SF5 migration) listing those variants as a radio group — pick
// swaps the live mini variant. Tiles without variants don't claim the event, so
// it bubbles to the global suppressor and shows the generic chrome menu.

import RailEmptyState from './RailEmptyState.jsx';
import { useManifests } from '../../module-sdk/useModuleRegistry.js';
import { readRailVariant, setRailVariant } from '../../hooks/useRailVariant.js';
import { useContextMenu } from '../../context-menu/useContextMenu.js';

const TILE_HEIGHT = 150;

export default function RightRailStack({ rightSlots, accent }) {
  const manifests = useManifests();
  const { openContextMenu } = useContextMenu();

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {rightSlots.map((slot) => {
        const manifest = manifests[slot.moduleId] || null;
        const handleContext = (e) => {
          // Only claim the right-click when this tile has variants to offer;
          // otherwise let it bubble to the global suppressor (generic menu).
          if (!Array.isArray(slot.railVariants) || slot.railVariants.length === 0) return;
          const current = readRailVariant(slot.moduleId, slot.railVariants[0]?.id);
          const items = slot.railVariants.map((v) => ({
            label: v.label,
            kind: 'radio',
            checked: v.id === current,
            onClick: () => setRailVariant(slot.moduleId, v.id),
          }));
          openContextMenu(e, items, { header: 'Mini variant', accent });
        };
        return (
          <div
            key={slot.moduleId + ':' + slot.id}
            onContextMenu={handleContext}
            style={{
              flex: '0 0 auto',
              minHeight: TILE_HEIGHT,
              display: 'flex', flexDirection: 'column',
              overflow: 'hidden',
              borderBottom: '1px solid var(--border)',
            }}
          >
            {typeof slot.renderRail === 'function'
              ? slot.renderRail({ accent })
              : <RailEmptyState manifest={manifest} accent={accent}/>}
          </div>
        );
      })}
    </div>
  );
}

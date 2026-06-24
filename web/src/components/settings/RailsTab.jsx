// Settings → Mini Rails tab. Lists every right-sidebar module slot that
// declares `railVariants` and renders a Seg picker per module. Writes
// through the same `useRailVariant` hook as the right-click menu, so
// both surfaces stay in sync.

import { useWidgetSlots, useManifests } from '../../module-sdk/useModuleRegistry.js';
import { useRailVariant } from '../../hooks/useRailVariant.js';
import { Seg } from '../ui/index.js';

export default function RailsTab({ accent }) {
  const slots = useWidgetSlots();
  const manifests = useManifests();
  const eligible = slots.filter(s => Array.isArray(s.railVariants) && s.railVariants.length > 0);

  if (eligible.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
        No right-sidebar modules expose mini variants yet.
      </div>
    );
  }

  return (
    <>
      <div style={{
        fontSize: 12,
        color: 'var(--text-muted)',
        marginBottom: 20,
        lineHeight: 1.5,
      }}>
        Pick which "mini" variant each right-sidebar module shows when the
        toolkit is collapsed. You can also right-click a mini tile to swap
        in place.
      </div>
      {eligible.map(slot => (
        <ModuleSection
          key={slot.moduleId + ':' + slot.id}
          slot={slot}
          manifest={manifests[slot.moduleId]}
          accent={accent}
        />
      ))}
    </>
  );
}

function ModuleSection({ slot, manifest, accent }) {
  const title = manifest?.name || manifest?.label || slot.moduleId;
  const fallback = slot.railVariants[0]?.id;
  const [variantId, setVariantId] = useRailVariant(slot.moduleId, fallback);
  // Optional second axis: the EXPANDED-tile skin (distinct storage key), shown
  // only for slots that declare `tileVariants`. Independent of the collapsed
  // mini-rail variant above.
  const hasTile = Array.isArray(slot.tileVariants) && slot.tileVariants.length > 0;
  const [tileId, setTileId] = useRailVariant(
    slot.tileVariantModuleId || slot.moduleId + '-tile',
    slot.tileVariants?.[0]?.id,
  );
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600,
        marginBottom: 12,
      }}>{title}</div>
      {hasTile && (
        <>
          <SubLabel>Expanded tile</SubLabel>
          <Seg
            options={slot.tileVariants.map(v => ({ value: v.id, label: v.label }))}
            value={tileId}
            onChange={setTileId}
            accent={accent}
          />
          <SubLabel style={{ marginTop: 16 }}>Collapsed mini</SubLabel>
        </>
      )}
      <Seg
        options={slot.railVariants.map(v => ({ value: v.id, label: v.label }))}
        value={variantId}
        onChange={setVariantId}
        accent={accent}
      />
    </div>
  );
}

function SubLabel({ children, style }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--text-muted)', fontWeight: 600,
      marginBottom: 8,
      ...style,
    }}>{children}</div>
  );
}

// Dock settings tab. The dock is a full-width bar flush with the screen bottom,
// always visible. Exposes edge depth (flush hairline | soft band), hover-expand
// speed (expand / collapse durations), module selection behavior (default
// module, click behavior, route sync, swap motion + duration, active
// indicator), and drag-to-reorder for both the chrome buttons and the module
// group.

import { useMemo } from 'react';
import { Seg } from '../ui/Pill.jsx';
import { OutlinedBtn } from '../ui/Button.jsx';
import { DOCK_DEFAULT } from '../../hooks/useSettings.js';
import { DOCK_BUTTONS } from '../dock/dock-buttons.js';
import { isSpecial, isSpacerId, applyThreeZoneOrder } from '../dock/dock-order.js';
import { useLeftSidebarSlots, useManifests } from '../../module-sdk/useModuleRegistry.js';
import * as hostIcons from '../icons.jsx';

export default function DockTab({ settings, setSetting, accent }) {
  const dock = { ...DOCK_DEFAULT, ...(settings?.dock || {}) };
  const set = (patch) => setSetting('dock', patch);

  const dockModules = { ...DOCK_DEFAULT.modules, ...(dock.modules || {}) };
  const setModules = (patch) => set({ modules: { ...dockModules, ...patch } });
  const rawSlots  = useLeftSidebarSlots();
  const manifests = useManifests();
  // Module list for the Boot-module picker below. Dock ordering now lives in
  // the unified `dock.order` (reorder by dragging icons in the dock itself), so
  // this list is just registry order — no separate module-order store.
  const moduleList = useMemo(() => rawSlots.map(slot => {
    const m = manifests[slot.moduleId];
    if (!m) return null;
    const Icon = m.iconKey && hostIcons[m.iconKey] ? hostIcons[m.iconKey] : null;
    return { id: slot.moduleId, name: m.name, Icon };
  }).filter(Boolean), [rawSlots, manifests]);

  // Human label for a hidden id (built-in button or module) in the restore list.
  const labelFor = (id) => {
    const btn = DOCK_BUTTONS.find(b => b.id === id);
    if (btn) return btn.label;
    const mod = moduleList.find(m => `module:${m.id}` === id);
    return mod ? mod.name : id;
  };

  // Reset returns to the chosen default layout: a single centred cluster
  // (order: []) or the 3-zone split over the default button set (modules first,
  // then the always-visible built-ins).
  const resetOrder = () => {
    if (dock.defaultLayout === 'three-zone') {
      const defIds = [
        ...moduleList.map(m => `module:${m.id}`),
        ...DOCK_BUTTONS.filter(b => !b.visible).map(b => b.id),
      ];
      set({ order: applyThreeZoneOrder(defIds) });
    } else {
      set({ order: [] });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SectionHeader title="Appearance" />

      <Row
        anchor="set-dock-edgeStyle"
        label="Edge depth"
        hint="Flush keeps the bar's top a bare hairline, matching the side rails. Band adds a soft upward shadow so the dock lifts gently off the content."
      >
        <Seg
          accent={accent}
          value={dock.edgeStyle}
          options={[
            { value: 'flush', label: 'Flush hairline' },
            { value: 'band',  label: 'Depth band' },
          ]}
          onChange={(v) => set({ edgeStyle: v })}
        />
      </Row>

      <Row
        anchor="set-dock-bgShade"
        label="Dock color"
        hint="Solid fill behind the icons, fixed across every theme. Charcoal matches the app's grey family; the lines pattern is removed."
      >
        <Seg
          accent={accent}
          value={dock.bgShade}
          options={[
            { value: 'charcoal', label: 'Charcoal' },
            { value: 'graphite', label: 'Graphite' },
            { value: 'slate',    label: 'Slate' },
          ]}
          onChange={(v) => set({ bgShade: v })}
        />
      </Row>

      <Row
        anchor="set-dock-iconStyle"
        label="Icon style"
        hint="Light keeps bright chips on the dark bar (macOS look). Dark blends the chips into the fill. Native uses the theme-adaptive candy treatment."
      >
        <Seg
          accent={accent}
          value={dock.iconStyle}
          options={[
            { value: 'light',  label: 'Light' },
            { value: 'dark',   label: 'Dark' },
            { value: 'native', label: 'Native' },
          ]}
          onChange={(v) => set({ iconStyle: v })}
        />
      </Row>

      <SectionHeader title="Module selection" />

      <Row
        anchor="set-dock-defaultMode"
        label="Default module on launch"
        hint="Last selected restores your previous pick. Specific always boots to the chosen module."
      >
        <Seg
          accent={accent}
          value={dockModules.defaultMode}
          options={[
            { value: 'last',     label: 'Last selected' },
            { value: 'specific', label: 'Specific' },
          ]}
          onChange={(v) => setModules({ defaultMode: v })}
        />
      </Row>

      {dockModules.defaultMode === 'specific' && (
        <Row
          label="Boot module"
          hint="The module to select on every launch."
        >
          <ModulePicker
            modules={moduleList}
            value={dockModules.defaultModule}
            accent={accent}
            onChange={(v) => setModules({ defaultModule: v })}
          />
        </Row>
      )}

      <Row
        anchor="set-dock-clickBehavior"
        label="Dock button click"
        hint="Navigate + swap also routes to the module's home page. Swap only just switches the sidebar."
      >
        <Seg
          accent={accent}
          value={dockModules.clickBehavior}
          options={[
            { value: 'navigate-and-swap', label: 'Navigate + swap' },
            { value: 'swap-only',         label: 'Swap only' },
          ]}
          onChange={(v) => setModules({ clickBehavior: v })}
        />
      </Row>

      <Row
        anchor="set-dock-navSync"
        label="Route → sidebar sync"
        hint="Auto switches the sidebar when a route outside the active module loads. Sticky keeps your selection."
      >
        <Seg
          accent={accent}
          value={dockModules.navSync}
          options={[
            { value: 'auto',   label: 'Auto-sync' },
            { value: 'sticky', label: 'Sticky' },
          ]}
          onChange={(v) => setModules({ navSync: v })}
        />
      </Row>

      <Row
        anchor="set-dock-slideDuration"
        label="Swap duration"
        hint="Higher values feel softer. Staggered overlaps the outgoing and incoming layers by 100 ms."
      >
        <Seg
          accent={accent}
          value={String(dockModules.slideDuration)}
          options={[
            { value: '220',       label: '220 ms' },
            { value: '260',       label: '260 ms' },
            { value: '320',       label: '320 ms' },
            { value: 'staggered', label: 'Staggered' },
          ]}
          onChange={(v) => setModules({ slideDuration: v === 'staggered' ? 'staggered' : parseInt(v, 10) })}
        />
      </Row>

      <Row
        anchor="set-dock-activeIndicator"
        label="Active indicator"
        hint="How the active module button is marked in the dock."
      >
        <Seg
          accent={accent}
          value={dockModules.activeIndicator}
          options={[
            { value: 'accent-fill', label: 'Accent fill' },
            { value: 'vertical-beam',   label: 'Vertical beam' },
            { value: 'lift',            label: 'Lift + glow' },
          ]}
          onChange={(v) => setModules({ activeIndicator: v })}
        />
      </Row>

      <SectionHeader title="Hover expand" />

      <Row
        anchor="set-dock-expandMs"
        label="Expand speed"
        hint="How fast an icon grows into its label when you hover it."
      >
        <Seg
          accent={accent}
          value={String(dock.expandMs)}
          options={[
            { value: '120', label: '120 ms snappy' },
            { value: '240', label: '240 ms smooth' },
            { value: '400', label: '400 ms relaxed' },
            { value: '600', label: '600 ms slow' },
          ]}
          onChange={(v) => set({ expandMs: parseInt(v, 10) })}
        />
      </Row>

      <Row
        anchor="set-dock-collapseMs"
        label="Collapse speed"
        hint="How fast an icon shrinks back to a plain icon when the cursor leaves."
      >
        <Seg
          accent={accent}
          value={String(dock.collapseMs)}
          options={[
            { value: '120', label: '120 ms snappy' },
            { value: '240', label: '240 ms smooth' },
            { value: '400', label: '400 ms relaxed' },
            { value: '600', label: '600 ms slow' },
          ]}
          onChange={(v) => set({ collapseMs: parseInt(v, 10) })}
        />
      </Row>

      <SectionHeader title="Order" />

      <Row
        anchor="set-dock-order"
        label="Dock order"
        hint="Drag any dock icon left or right to rearrange — modules and built-in buttons share one order. Reset returns to the default order."
      >
        <OutlinedBtn small onClick={resetOrder}>Reset order</OutlinedBtn>
      </Row>

      <SectionHeader title="Layout" />

      <Row
        anchor="set-dock-defaultLayout"
        label="Default layout"
        hint="Centered keeps every icon in one middle cluster. 3-zone splits them into far-left, centre, and far-right clusters. Reset order returns to this."
      >
        <Seg
          accent={accent}
          value={dock.defaultLayout}
          options={[
            { value: 'center',     label: 'Centered' },
            { value: 'three-zone', label: '3-zone' },
          ]}
          onChange={(v) => set({ defaultLayout: v })}
        />
      </Row>

      <Row
        anchor="set-dock-edgeSnap"
        label="Edge snap on drag"
        hint="Releasing a dragged icon near the dock's left edge, centre, or right edge snaps it into that cluster. No markers show during the drag."
      >
        <Seg
          accent={accent}
          value={dock.edgeSnap ? 'on' : 'off'}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'on',  label: 'On' },
          ]}
          onChange={(v) => set({ edgeSnap: v === 'on' })}
        />
      </Row>

      {dock.edgeSnap && (
        <Row
          anchor="set-dock-snapStrength"
          label="Snap strength"
          hint="How close to a zone the cursor must be on release for the snap to trigger."
        >
          <Seg
            accent={accent}
            value={dock.snapStrength}
            options={[
              { value: 'subtle', label: 'Subtle' },
              { value: 'medium', label: 'Medium' },
              { value: 'strong', label: 'Strong' },
            ]}
            onChange={(v) => set({ snapStrength: v })}
          />
        </Row>
      )}

      <Row
        label="Separators & spacers"
        hint="Dividers currently in the dock. Add them by right-clicking the dock bar; drag to reposition."
      >
        <DividerManager dock={dock} set={set} />
      </Row>

      <Row
        label="Hidden icons"
        hint="Icons removed from the dock via right-click. Restore brings them back."
      >
        <HiddenManager dock={dock} set={set} labelFor={labelFor} />
      </Row>
    </div>
  );
}

function Row({ label, hint, inline, anchor, children }) {
  if (inline) {
    return (
      <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
          {hint && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{hint}</div>
          )}
        </div>
        <div style={{ flexShrink: 0 }}>{children}</div>
      </div>
    );
  }
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
      <div style={{ marginTop: 2 }}>{children}</div>
    </div>
  );
}

function SectionHeader({ title }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'var(--font-mono)',
      letterSpacing: '0.12em', textTransform: 'uppercase',
      color: 'var(--text-faint)', fontWeight: 700,
      paddingTop: 6, marginTop: 2,
      borderTop: '1px solid var(--border-soft)',
    }}>{title}</div>
  );
}

function ModulePicker({ modules, value, accent, onChange }) {
  const accentColor = accent || 'var(--text)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {modules.map(p => {
        const Icon = p.Icon;
        const selected = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '7px 10px',
              border: `1px solid ${selected
                ? `color-mix(in oklch, ${accentColor} 45%, var(--border))`
                : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)',
              background: selected
                ? `color-mix(in oklch, ${accentColor} 10%, var(--surface))`
                : 'var(--surface)',
              color: selected ? accentColor : 'var(--text)',
              cursor: 'pointer',
              fontSize: 12, fontWeight: 500,
              textAlign: 'left',
              transition: 'background 100ms ease, border-color 100ms ease, color 100ms ease',
            }}
          >
            {Icon && <Icon size={14}/>}
            <span>{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

// Lists the separators/spacers currently in the order, with per-item remove and
// a Clear all — a non-drag way to clean dividers up.
function DividerManager({ dock, set }) {
  const specials = (dock.order || []).filter(isSpecial);
  if (!specials.length) {
    return <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>None yet.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {specials.map(id => (
        <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text)' }}>{isSpacerId(id) ? 'Spacer' : 'Separator'}</span>
          <OutlinedBtn small onClick={() => set({ order: dock.order.filter(x => x !== id) })}>Remove</OutlinedBtn>
        </div>
      ))}
      <OutlinedBtn small onClick={() => set({ order: dock.order.filter(x => !isSpecial(x)) })}>Clear all</OutlinedBtn>
    </div>
  );
}

// Lists buttons hidden from the dock, each with a Restore button.
function HiddenManager({ dock, set, labelFor }) {
  const hidden = dock.hidden || [];
  if (!hidden.length) {
    return <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>None hidden.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {hidden.map(id => (
        <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text)' }}>{labelFor(id)}</span>
          <OutlinedBtn small onClick={() => set({ hidden: hidden.filter(x => x !== id) })}>Restore</OutlinedBtn>
        </div>
      ))}
    </div>
  );
}

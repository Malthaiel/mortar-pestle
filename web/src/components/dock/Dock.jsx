// Full-width dock rail, flush with the bottom of the screen — the horizontal
// twin of the side rails. Always visible (static), squared, carrying the same
// abstract lines-pattern as the sidebars. Sticky hover-expand labels (icons grow
// into icon+label buttons) and drag-to-reorder within each cluster. The outer
// .dock-pos wrapper spans the full width; the inner .dock-root is the bar. Live
// buttons (Planner mini, Quick Capture) land in sub-feature 5.

import { useState, useRef, useCallback } from 'react';
import { useHashRoute, navigate } from '../../router.js';
import DockButton from './DockButton.jsx';
import ModuleDockButton from './ModuleDockButton.jsx';
import NotificationBell from '../../notifications/NotificationBell.jsx';
import DownloadsDockButton from '../../downloads/DownloadsDockButton.jsx';
import DockVaultSwitcher from './DockVaultSwitcher.jsx';
import DockAgentsButton from './DockAgentsButton.jsx';
import DraggableSidebarList from '../DraggableSidebarList.jsx';
import { DOCK_BUTTONS } from './dock-buttons.js';
import { DOCK_DEFAULT } from '../../hooks/useSettings.js';
import { useUpdateStatus } from '../../hooks/useUpdateStatus.js';
import { useModuleDockEntries } from './module-entries.js';
import { useContextMenu } from '../../context-menu/useContextMenu.js';
import { DockSeparator, DockSpacer } from './DockDivider.jsx';
import {
  isSpecial, isSpacerId, makeSpecialId, snapStrengthPx,
  applyThreeZoneOrder, groupByTypeOrder,
} from './dock-order.js';
import {
  IconLayers, IconMaximize, IconLayoutGrid, IconReset,
  IconX, IconMove, IconChevronLeft, IconChevronRight,
} from '../icons.jsx';

// Compute the effective button order: prefer the saved order, append any new
// IDs that were added after the user customized, and drop ids no longer known
// (e.g. uninstalled modules). Order ids mix built-in ('settings') and module
// ('module:<id>') entries under one unified array.
function effectiveOrder(saved, knownIds) {
  if (!Array.isArray(saved) || saved.length === 0) return knownIds.slice();
  const knownSet = new Set(knownIds);
  // Keep separator/spacer ids (never in knownIds) while still dropping stale
  // button ids (e.g. an uninstalled module).
  const filtered = saved.filter(id => isSpecial(id) || knownSet.has(id));
  const missing  = knownIds.filter(id => !saved.includes(id));
  return [...filtered, ...missing];
}

// Phase 2b: the Knowledge + Infrastructure modules merged into one Vault View
// module. Remap legacy dock-order ids so the merged button inherits the
// earliest of the two old positions (dedupe) instead of being appended to the
// dock end. Idempotent — once no legacy ids remain it's a passthrough.
function remapVaultDockIds(saved) {
  if (!Array.isArray(saved)) return saved;
  const out = [];
  for (const id of saved) {
    const mapped = (id === 'module:knowledge' || id === 'module:infrastructure') ? 'module:vault' : id;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export default function Dock({
  settings,
  setSetting,
  setSettingsOpen, settingsOpen,
  setPaletteOpen, paletteOpen,
  setHintsOpen, hintsOpen,
  setPlannerOpen, plannerOpen,
  setNotifOpen, notifOpen,
  setDownloadsOpen, downloadsOpen,
  setRecycleBinOpen, recycleBinOpen,
  accent,
}) {
  const route = useHashRoute();
  const { openContextMenu } = useContextMenu();
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  // Update-available badge on the settings gear (mirrors the System rail tab).
  const { available: updateAvailable } = useUpdateStatus();
  const dock = { ...DOCK_DEFAULT, ...(settings?.dock || {}) };
  const edgeStyle = dock.edgeStyle || DOCK_DEFAULT.edgeStyle;
  const bgShade   = dock.bgShade   || DOCK_DEFAULT.bgShade;
  const iconStyle = dock.iconStyle || DOCK_DEFAULT.iconStyle;
  const dockRootRef = useRef(null);
  // Last dock icon the cursor entered. Held across the inter-icon gaps (empty
  // flex gap, not a hover target) so the expanded button doesn't collapse
  // mid-gap; cleared only on a different icon (onDockOver), dock-exit
  // (onDockLeave), or drag (setDragActive). See [data-dock-hover] in styles.css.
  const hovered = useRef(null);
  const setHovered = (btn) => {
    if (hovered.current === btn) return;
    if (hovered.current) delete hovered.current.dataset.dockHover;
    if (btn) btn.dataset.dockHover = 'true';
    hovered.current = btn;
  };

  // Cursor left the dock entirely → collapse the held hover-expand icon.
  const onDockLeave = () => { setHovered(null); };

  // Sticky hover-expand: entering an icon hands it the expanded state. The gaps
  // between icons aren't .candy-btn targets, so closest() is null there and we
  // keep the last icon expanded until a real handoff or onDockLeave.
  const onDockOver = (e) => {
    const btn = e.target.closest?.('.candy-btn[data-shape="icon"]');
    if (btn) setHovered(btn);
  };

  const ctx = {
    settings, setSetting, route, navigate, accent,
    setSettingsOpen, settingsOpen,
    setPaletteOpen, paletteOpen,
    setHintsOpen, hintsOpen,
    setPlannerOpen, plannerOpen,
    setNotifOpen, notifOpen,
    setDownloadsOpen, downloadsOpen,
    setRecycleBinOpen, recycleBinOpen,
    setQuickCaptureOpen, quickCaptureOpen,
    plannerTimer: null, // sub-feature 5 wires this
  };

  const moduleEntries = useModuleDockEntries();

  // One unified pool + order across modules and built-in buttons. `dock.order`
  // (a single string array) holds both built-in ids ('settings') and module
  // ids ('module:<id>'). Modules-first seeds the old leftmost-group layout on a
  // fresh/empty order; effectiveOrder appends newly-registered items and drops
  // stale ones.
  const allItems = [...moduleEntries, ...DOCK_BUTTONS];
  const knownIds = allItems.map(b => b.id);
  const order = effectiveOrder(remapVaultDockIds(dock.order), knownIds);
  const itemById = new Map(allItems.map(b => [b.id, b]));
  const hiddenSet = new Set(dock.hidden || []);
  // Synthesize lightweight items for the inline separators/spacers, and drop any
  // button the user hid. Separators/spacers (b.kind set) are never hidden and
  // never gated by visible().
  const visibleItems = order
    .map(id => {
      if (isSpecial(id)) return { id, kind: isSpacerId(id) ? 'spacer' : 'sep' };
      return itemById.get(id) || null;
    })
    .filter(b => b
      && (b.kind || !hiddenSet.has(b.id))
      && (b.kind || !b.visible || b.visible(ctx)));

  // Centre magnet target for edge-snap: the slot just after the first spacer
  // (start of the centre cluster), else the geometric middle.
  const firstSpacerIdx = visibleItems.findIndex(b => b.kind === 'spacer');
  const centerIndex = firstSpacerIdx >= 0 ? firstSpacerIdx + 1 : Math.floor(visibleItems.length / 2);

  const renderBtn = (b) => {
    if (b.id === 'notifications') return (
      <NotificationBell
        key={b.id}
        label={b.label}
        onClick={() => b.onClick?.(ctx)}
        isActive={b.isActive ? !!b.isActive(ctx) : false}
        accent={accent}
        onContextMenu={(e) => onItemContext(e, b.id)}
      />
    );
    if (b.id === 'downloads') return (
      <DownloadsDockButton
        key={b.id}
        label={b.label}
        onClick={() => b.onClick?.(ctx)}
        isActive={b.isActive ? !!b.isActive(ctx) : false}
        accent="#6fb56f"
        onContextMenu={(e) => onItemContext(e, b.id)}
      />
    );
    if (b.id === 'vault-switcher') return (
      <DockVaultSwitcher
        key={b.id}
        label={b.label}
        isActive={b.isActive ? !!b.isActive(ctx) : false}
        accent={accent}
        onContextMenu={(e) => onItemContext(e, b.id)}
      />
    );
    if (b.id === 'design-mode') return (
      <DockAgentsButton
        key={b.id}
        label={b.label}
        accent={accent}
        settings={settings}
        setSetting={setSetting}
        onContextMenu={(e) => onItemContext(e, b.id)}
      />
    );
    return (
      <DockButton
        key={b.id}
        Icon={b.Icon}
        label={b.label}
        onClick={() => b.onClick?.(ctx)}
        isActive={b.isActive ? !!b.isActive(ctx) : false}
        accent={accent}
        auraPulse={b.id === 'design-mode' && !!ctx.settings?.agents?.mode}
        updateDot={b.id === 'settings' && !!updateAvailable && ctx.settings?.dev?.autoCheckUpdates !== false}
        onContextMenu={(e) => onItemContext(e, b.id)}
      />
    );
  };

  const activeIndicator = dock.modules?.activeIndicator || DOCK_DEFAULT.modules.activeIndicator;
  const renderModuleBtn = (b) => (
    <ModuleDockButton
      key={b.id}
      Icon={b.Icon}
      label={b.label}
      onClick={() => b.onClick?.(ctx)}
      isActive={b.isActive ? !!b.isActive(ctx) : false}
      accent={accent}
      activeIndicator={activeIndicator}
      onContextMenu={(e) => onItemContext(e, b.id)}
    />
  );

  // Map a reorder over the VISIBLE items back onto the full persisted order,
  // leaving hidden ids (quick-capture, a non-running planner-timer, …) pinned at
  // their slots. Mirrors the index convention DraggableSidebarList emits.
  const handleReorder = (from, to) => {
    if (to === from || to === from + 1) return;
    const visibleIds = visibleItems.map(b => b.id);
    const adjustedTo = from < to ? to - 1 : to;
    const nextVisible = visibleIds.slice();
    const [moved] = nextVisible.splice(from, 1);
    nextVisible.splice(adjustedTo, 0, moved);
    const visibleSet = new Set(visibleIds);
    let k = 0;
    const newFull = order.map(id => (visibleSet.has(id) ? nextVisible[k++] : id));
    setSetting('dock', { order: newFull });
  };

  // Toggle `data-dragging` on the dock root imperatively (not via React state)
  // so it applies before DraggableSidebarList's synchronous rect snapshots —
  // collapsing the hover-expand width so measurements use the rest size. Reuses
  // the existing .dock-root[data-dragging] CSS hook.
  const setDragActive = useCallback((active) => {
    const root = dockRootRef.current;
    if (!root) return;
    if (active) root.dataset.dragging = 'true';
    else delete root.dataset.dragging;
    // Drop sticky hover so an icon can't stay expanded across a drag.
    if (hovered.current) { delete hovered.current.dataset.dockHover; hovered.current = null; }
  }, []);

  // ── Right-click menus: insertion + order mutations ────────────────────────
  const writeOrder = (next) => setSetting('dock', { order: next });

  // Full-order index of the gap nearest the cursor, so an inserted divider lands
  // where the user clicked. Walks the live item nodes, finds the first whose
  // horizontal midpoint is right of the cursor, then maps that visible position
  // back onto the persisted order (which also holds hidden ids).
  const insertIndexFromCursor = (clientX) => {
    const root = dockRootRef.current;
    const nodes = root ? root.querySelectorAll('.dock-btn-slot, [data-dock-special]') : [];
    let visIdx = visibleItems.length;
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) { visIdx = i; break; }
    }
    const visibleIds = visibleItems.map(b => b.id);
    if (visIdx >= visibleIds.length) return order.length;
    const full = order.indexOf(visibleIds[visIdx]);
    return full < 0 ? order.length : full;
  };

  const addSpecial = (type, at) => {
    const next = order.slice();
    next.splice(at, 0, makeSpecialId(type, order));
    writeOrder(next);
  };
  const removeSpecial = (id) => writeOrder(order.filter(x => x !== id));
  const hideButton = (id) =>
    setSetting('dock', { hidden: Array.from(new Set([...(dock.hidden || []), id])) });

  const sendToZone = (id, zone) => {
    const next = order.filter(x => x !== id);
    if (zone === 'left') next.unshift(id);
    else if (zone === 'right') next.push(id);
    else {
      const firstSpacer = next.findIndex(isSpacerId);
      const pos = firstSpacer >= 0 ? firstSpacer + 1 : Math.floor(next.length / 2);
      next.splice(pos, 0, id);
    }
    writeOrder(next);
  };

  const applyThreeZone = () => writeOrder(applyThreeZoneOrder(visibleItems.map(b => b.id)));
  const groupByType = () =>
    writeOrder(groupByTypeOrder(visibleItems.filter(b => !b.kind).map(b => ({ id: b.id, group: b.group }))));
  const resetOrder = () => {
    if (dock.defaultLayout === 'three-zone') {
      const defIds = allItems.filter(b => !b.visible || b.visible(ctx)).map(b => b.id);
      writeOrder(applyThreeZoneOrder(defIds));
    } else {
      writeOrder([]);
    }
  };

  const insertItems = (at) => [
    { label: 'Add separator', icon: IconLayers,   onClick: () => addSpecial('sep', at) },
    { label: 'Add spacer',    icon: IconMaximize, onClick: () => addSpecial('spacer', at) },
  ];
  const presetItems = [
    { label: 'Apply 3-zone layout', icon: IconLayoutGrid, onClick: applyThreeZone },
    { label: 'Group by type',       icon: IconLayers,     onClick: groupByType },
    { label: 'Reset order',         icon: IconReset,      onClick: resetOrder },
  ];

  // Menu A — bare dock bar (the right-click missed an icon/divider).
  const onRootContext = (e) => {
    if (e.target.closest('.dock-btn-slot, [data-dock-special]')) return;
    const at = insertIndexFromCursor(e.clientX);
    openContextMenu(e, [...insertItems(at), { sep: true }, ...presetItems], { accent, header: 'Dock' });
  };

  // Menu B — a specific icon (hide / send-to-zone) or divider (remove).
  const onItemContext = (e, id) => {
    e.preventDefault();
    const at = insertIndexFromCursor(e.clientX);
    const items = [];
    if (isSpecial(id)) {
      items.push({ label: 'Remove', icon: IconX, danger: true, onClick: () => removeSpecial(id) });
    } else {
      items.push({ label: 'Hide from dock', icon: IconX, onClick: () => hideButton(id) });
      items.push({ label: 'Send to', icon: IconMove, children: [
        { label: 'Left',   icon: IconChevronLeft,  onClick: () => sendToZone(id, 'left') },
        { label: 'Center', icon: IconLayoutGrid,   onClick: () => sendToZone(id, 'center') },
        { label: 'Right',  icon: IconChevronRight, onClick: () => sendToZone(id, 'right') },
      ] });
    }
    items.push({ sep: true }, ...insertItems(at), ...presetItems);
    openContextMenu(e, items, { accent, header: 'Dock icon' });
  };

  return (
    <div
      className="dock-pos"
      style={{
        position: 'fixed',
        left: 0, right: 0, bottom: 0,
        zIndex: 60,
        pointerEvents: 'none',
      }}
    >
      <div
        ref={dockRootRef}
        className="dock-root"
        data-dock-edge-style={edgeStyle}
        data-dock-bg-shade={bgShade}
        data-dock-icon-style={iconStyle}
        data-quick-capture-open={quickCaptureOpen ? 'true' : undefined}
        onMouseLeave={onDockLeave}
        onMouseOver={onDockOver}
        onContextMenu={onRootContext}
        style={{
          position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: '100%',
          padding: '8px 6px',
          pointerEvents: 'auto',
          '--dock-expand-ms':   `${dock.expandMs ?? DOCK_DEFAULT.expandMs}ms`,
          '--dock-collapse-ms': `${dock.collapseMs ?? DOCK_DEFAULT.collapseMs}ms`,
        }}
      >
        <DraggableSidebarList
          items={visibleItems}
          direction="horizontal"
          dragFromInteractive
          enabled={visibleItems.length > 1}
          onReorder={handleReorder}
          onDragActiveChange={setDragActive}
          keyExtractor={(b) => b.id}
          getItemStyle={(b) => (b.kind === 'spacer' ? { flex: '1 1 0%', minWidth: 8 } : undefined)}
          snapZones={dock.edgeSnap ? { triggerPx: snapStrengthPx(dock.snapStrength), centerIndex } : null}
          style={{ flex: '1 1 auto', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '0 6px' }}
          renderItem={(b) => {
            if (b.kind === 'sep') return <DockSeparator id={b.id} onContextMenu={onItemContext} />;
            if (b.kind === 'spacer') return <DockSpacer id={b.id} onContextMenu={onItemContext} />;
            return b.group === 'modules' ? renderModuleBtn(b) : renderBtn(b);
          }}
        />
      </div>
    </div>
  );
}

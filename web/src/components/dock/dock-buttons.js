// Declarative registry for dock buttons. Each entry:
//   { id, group: 'tools'|'pages'|'dev', Icon, label,
//     onClick(ctx), isActive?(ctx), visible?(ctx), render?(ctx) }
//
// `ctx` carries the app-level state setters, settings, route, and planner-timer
// state. Live-state buttons (Planner mini, Quick Capture popover) override
// rendering via `render(ctx)` and gain wiring in sub-feature 5.

import { IconPlus, IconBookOpen } from '../icons.jsx';

export const DOCK_BUTTONS = [
  // Tools
  // Settings / Notifications / Recycling bin / Downloads used to live here. The
  // Titlebar Overhaul moved the first three into the titlebar's left cluster
  // (TitleBar.jsx), and Downloads followed them 2026-09-11 when all four fused
  // into one .candy-split shell there — one home per button. The vault switcher
  // left the same way: it now lives in the file-tree toolbar as
  // <TreeVaultSwitcher/>. Saved dock orders holding any of those old ids are
  // dropped automatically by effectiveOrder() in Dock.jsx, so no migration is
  // needed.
  //
  // 'palette', 'hints' and 'design-mode' (Agents) took the same trip 2026-09-15,
  // into TWO fused .candy-split runs in the titlebar's RIGHT cluster:
  // [Palette | Agents] and [Keyboard shortcuts | Feedback]. Feedback had no
  // entry here to delete — it is synthesized from the module registry, so
  // module-entries.js skips it instead. That empties the 'tools' group entirely
  // (quick-capture below is still hidden), leaving the Dock to pages + modules.
  // The built-in 'planner' button is GONE (2026-08-27). The planner module
  // registers a left-sidebar slot, so module-entries.js already synthesizes a
  // 'module:planner' dock button with the same IconLayoutGrid and the same
  // label — the two rendered side by side as a duplicate pair. Saved dock
  // orders still holding the bare 'planner' id are dropped by effectiveOrder()
  // in Dock.jsx, so no migration is needed.
  {
    id: 'quick-capture', group: 'tools', Icon: IconPlus, label: 'Quick capture',
    // Sub-feature 5 wires the floating capture popover.
    onClick: (ctx) => ctx.setQuickCaptureOpen?.(true),
    visible: () => false, // hidden until sub-feature 5
  },
  // Pages
  // The 'today' button retired with the Planner Consolidation. Saved dock
  // orders still holding the id are dropped by effectiveOrder() in Dock.jsx,
  // so no migration is needed.
  {
    id: 'docs', group: 'pages', Icon: IconBookOpen, label: 'Docs',
    onClick: (ctx) => ctx.navigate('/docs'),
    isActive: (ctx) => ctx.route?.page === 'docs',
  },
  {
    // 'planner-timer', NOT 'planner' — that id belongs to the planner-modal
    // opener above (collision found in the Planner Overhaul rename).
    id: 'planner-timer', group: 'pages', Icon: null, label: 'Planner',
    visible: (ctx) => !!ctx.plannerTimer?.running,
    onClick: () => { /* sub-feature 5: pause/resume via api */ },
    // sub-feature 5 supplies a `render(ctx)` that mounts <PlannerMiniIndicator/>.
  },
];

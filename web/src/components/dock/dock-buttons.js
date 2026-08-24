// Declarative registry for dock buttons. Each entry:
//   { id, group: 'tools'|'pages'|'dev', Icon, label,
//     onClick(ctx), isActive?(ctx), visible?(ctx), render?(ctx) }
//
// `ctx` carries the app-level state setters, settings, route, and planner-timer
// state. Live-state buttons (Planner mini, Quick Capture popover) override
// rendering via `render(ctx)` and gain wiring in sub-feature 5.

import {
  IconCommand, IconKeyboard, IconPlus,
  IconCalendar, IconBookOpen, IconSparkles, IconLayoutGrid, IconDownload,
} from '../icons.jsx';

export const DOCK_BUTTONS = [
  // Tools
  // Settings / Notifications / Recycling bin used to live here. The Titlebar
  // Overhaul moved all three into the titlebar's left cluster (TitleBar.jsx) —
  // one home per button. The vault switcher left the same way: it now lives in the
  // file-tree toolbar as <TreeVaultSwitcher/>. Saved dock orders holding any of
  // those old ids are dropped automatically by effectiveOrder() in Dock.jsx, so no
  // migration is needed.
  {
    id: 'downloads', group: 'tools', Icon: IconDownload, label: 'Downloads',
    onClick: (ctx) => ctx.setDownloadsOpen?.(o => !o),
    isActive: (ctx) => !!ctx.downloadsOpen,
  },
  {
    id: 'palette', group: 'tools', Icon: IconCommand, label: 'Command palette',
    onClick: (ctx) => ctx.setPaletteOpen(true),
    isActive: (ctx) => !!ctx.paletteOpen,
  },
  {
    id: 'hints', group: 'tools', Icon: IconKeyboard, label: 'Keyboard shortcuts',
    onClick: (ctx) => ctx.setHintsOpen(true),
    isActive: (ctx) => !!ctx.hintsOpen,
  },
  {
    id: 'planner', group: 'tools', Icon: IconLayoutGrid, label: 'Planner',
    // Navigates now — the pop-up window it used to open is deleted and the
    // Planner is a route section (Planner Consolidation).
    onClick: (ctx) => ctx.navigate('/planner'),
    isActive: (ctx) => ctx.route?.page === 'planner',
  },
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
  // Agents
  {
    // Rendered by Dock.jsx's renderBtn special-case → <DockAgentsButton/>, which
    // owns the popover launcher (Atelier → Design Mode, Concierge → chat). Id kept
    // as 'design-mode' to avoid a dock.order migration.
    id: 'design-mode', group: 'dev', Icon: IconSparkles, label: 'Agents',
  },
];

// Declarative registry for dock buttons. Each entry:
//   { id, group: 'tools'|'pages'|'dev', Icon, label,
//     onClick(ctx), isActive?(ctx), visible?(ctx), render?(ctx) }
//
// `ctx` carries the app-level state setters, settings, route, and planner-timer
// state. Live-state buttons (Planner mini, Quick Capture popover) override
// rendering via `render(ctx)` and gain wiring in sub-feature 5.

import {
  IconSettings, IconCommand, IconKeyboard, IconPlus,
  IconCalendar, IconBookOpen, IconSparkles, IconLayoutGrid, IconBell, IconDownload, IconTrash, IconDatabase,
} from '../icons.jsx';

export const DOCK_BUTTONS = [
  // Tools
  {
    // Rendered by Dock.jsx's renderBtn special-case → <DockVaultSwitcher/>, which
    // owns its own popover + onClick (so no onClick here).
    id: 'vault-switcher', group: 'tools', Icon: IconDatabase, label: 'Switch vault',
  },
  {
    id: 'settings', group: 'tools', Icon: IconSettings, label: 'Settings',
    onClick: (ctx) => ctx.setSettingsOpen(true),
    isActive: (ctx) => !!ctx.settingsOpen,
  },
  {
    id: 'notifications', group: 'tools', Icon: IconBell, label: 'Notifications',
    onClick: (ctx) => ctx.setNotifOpen?.(o => !o),
    isActive: (ctx) => !!ctx.notifOpen,
  },
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
    id: 'planner', group: 'tools', Icon: IconLayoutGrid, label: 'Open planner',
    onClick: (ctx) => ctx.setPlannerOpen(true),
    isActive: (ctx) => !!ctx.plannerOpen,
  },
  {
    id: 'recycle-bin', group: 'tools', Icon: IconTrash, label: 'Recycling bin',
    onClick: (ctx) => ctx.setRecycleBinOpen?.(true),
    isActive: (ctx) => !!ctx.recycleBinOpen,
  },
  {
    id: 'quick-capture', group: 'tools', Icon: IconPlus, label: 'Quick capture',
    // Sub-feature 5 wires the floating capture popover.
    onClick: (ctx) => ctx.setQuickCaptureOpen?.(true),
    visible: () => false, // hidden until sub-feature 5
  },
  // Pages
  {
    id: 'today', group: 'pages', Icon: IconCalendar, label: 'Today',
    onClick: (ctx) => ctx.navigate('/pulse/today'),
    isActive: (ctx) => ctx.route?.path?.startsWith('/pulse/today'),
  },
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

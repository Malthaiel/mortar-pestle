// Monitor launcher — the Overlay Host's monitor-picker chip, one slot right of the
// Browser globe (AgentsOverlayLauncher / BrowserOverlayLauncher pattern). Icon-only
// (IconMonitor); on click it opens the context menu as a dropdown (useMenuTrigger)
// listing every monitor with name + resolution, the current one checked. Selecting one invokes `overlay_set_monitor`
// (Rust repositions the overlay-host immediately + persists to overlay_monitor.json).
import { useMenuTrigger } from '../context-menu/useContextMenu.js';
import { invoke } from '@tauri-apps/api/core';
import { IconMonitor } from '@host/components/icons.jsx';

export default function MonitorOverlayChip() {
  // Re-fetch the list each open: a monitor can be hot-plugged between opens.
  const menu = useMenuTrigger(() => invoke('overlay_list_monitors')
    .catch(() => [])
    .then((monitors) => monitors.map((m) => ({
      label: `${m.label} — ${m.width}×${m.height}`,
      icon: IconMonitor,
      checked: !!m.isSelected,
      onClick: () => { invoke('overlay_set_monitor', { name: m.name }).catch(() => {}); },
    }))));

  return (
    <div style={{ position: 'fixed', left: 112, bottom: 16, zIndex: 30 }}>
      <button
        type="button"
        className={`video-cinema candy-btn ov-monitor-chip${menu['aria-expanded'] ? ' is-active' : ''}`}
        data-shape="icon"
        data-no-drag
        title="Monitor"
        aria-label="Monitor"
        {...menu}
      >
        <span className="candy-face"><IconMonitor size={18} /></span>
      </button>
    </div>
  );
}

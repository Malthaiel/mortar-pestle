// Monitor launcher — the Overlay Host's monitor-picker chip, one slot right of the
// Browser globe (AgentsOverlayLauncher / BrowserOverlayLauncher pattern). Icon-only
// (IconMonitor); on click it opens a small candy dropdown that reuses CandySelect's
// .candy-select-menu / .candy-select-option classes — no portal, so it survives the
// overlay-host's fullscreen transparent window — listing every monitor with name +
// resolution, the current one marked. Selecting one invokes `overlay_set_monitor`
// (Rust repositions the overlay-host immediately + persists to overlay_monitor.json).
// CandySelect renders the selected label as its trigger, so it can't be an icon-only
// chip; this dropdown is a minimal inline menu (open / click-outside / Esc) — the same
// inline-not-exported pattern as ViewAllModal in OverlayStudioPanel.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { IconMonitor } from '@host/components/icons.jsx';

export default function MonitorOverlayChip() {
  const [open, setOpen] = useState(false);
  const [monitors, setMonitors] = useState([]);
  const ref = useRef(null);

  // Re-fetch the list each open — a monitor can be hot-plugged between opens, and
  // the dropdown should reflect the live selection marker. Capture-phase mousedown
  // (like CandySelect) so a parent's bubble stopPropagation can't leave it stuck.
  useEffect(() => {
    if (!open) return;
    invoke('overlay_list_monitors').then(setMonitors).catch(() => setMonitors([]));
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (m) => {
    setOpen(false);
    invoke('overlay_set_monitor', { name: m.name }).catch(() => {});
  };

  return (
    <div ref={ref} style={{ position: 'fixed', left: 112, bottom: 16, zIndex: 30 }}>
      <button
        type="button"
        className={`video-cinema candy-btn ov-monitor-chip${open ? ' is-active' : ''}`}
        data-shape="icon"
        data-no-drag
        title="Monitor"
        aria-label="Monitor"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="candy-face"><IconMonitor size={18} /></span>
      </button>
      <div
        role="listbox"
        className="candy-select-menu is-up"
        data-open={open ? 'true' : 'false'}
        style={{ maxHeight: open ? 320 : 0, opacity: open ? 1 : 0, minWidth: 220 }}
      >
        <div style={{ padding: 4 }}>
          {monitors.map((m) => (
            <button
              key={m.label}
              type="button"
              role="option"
              aria-selected={m.isSelected}
              className={`candy-select-option${m.isSelected ? ' is-selected' : ''}`}
              onClick={() => pick(m)}
            >
              <span style={{ flex: 1, textAlign: 'left' }}>{m.label} — {m.width}×{m.height}</span>
              {m.isSelected && <span aria-hidden style={{ fontSize: 11 }}>✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
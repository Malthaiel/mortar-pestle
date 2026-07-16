// Settings launcher — the Overlay Host's open/minimize chip for the Overlay
// Settings panel, one slot right of the Studio chip (StudioOverlayLauncher pattern
// 1-1). Unlike Studio the Settings panel starts CLOSED; the chip toggles and
// reflects it via the shared localStorage + window-event pattern.
import { useEffect, useState } from 'react';
import { IconSettings } from '../components/icons.jsx';
import { OPEN_EVT, isPanelOpen, setPanelOpen } from './OverlaySettingsPanel.jsx';

export default function SettingsOverlayLauncher() {
  const [open, setOpen] = useState(isPanelOpen);
  useEffect(() => {
    const onChange = (e) => setOpen(!!e.detail);
    window.addEventListener(OPEN_EVT, onChange);
    return () => window.removeEventListener(OPEN_EVT, onChange);
  }, []);

  return (
    <button
      type="button"
      className={`video-cinema candy-btn ov-studio-chip${open ? ' is-active' : ''}`}
      data-shape="icon"
      title="Overlay settings"
      aria-label="Overlay settings"
      aria-pressed={open}
      onClick={() => setPanelOpen(!open)}
      style={{ position: 'fixed', left: 256, bottom: 16, zIndex: 30 }}
    >
      <span className="candy-face"><IconSettings size={18} /></span>
    </button>
  );
}

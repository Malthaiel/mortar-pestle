// Browser launcher — the Overlay Host's summon chip for the Browser panel, one
// slot right of the Concierge sparkle (AgentsOverlayLauncher pattern). The panel
// owns its open state via localStorage + the OPEN_EVT window event; the chip
// just toggles and reflects it. No remember-setting gate: the panel restores its
// last state on every show by construction (default open).
import { useEffect, useState } from 'react';
import { IconGlobe } from '../components/icons.jsx';
import { OPEN_EVT, isPanelOpen, setPanelOpen } from './OverlayBrowserPanel.jsx';

export default function BrowserOverlayLauncher() {
  const [open, setOpen] = useState(isPanelOpen);
  useEffect(() => {
    const onChange = (e) => setOpen(!!e.detail);
    window.addEventListener(OPEN_EVT, onChange);
    return () => window.removeEventListener(OPEN_EVT, onChange);
  }, []);

  return (
    <button
      type="button"
      className={`video-cinema candy-btn ov-browser-chip${open ? ' is-active' : ''}`}
      data-shape="icon"
      title="Browser"
      aria-label="Browser"
      aria-pressed={open}
      onClick={() => setPanelOpen(!open)}
      style={{ position: 'fixed', left: 64, bottom: 16, zIndex: 30 }}
    >
      <span className="candy-face"><IconGlobe size={18} /></span>
    </button>
  );
}

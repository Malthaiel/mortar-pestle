// Studio launcher — the Overlay Host's minimize/open chip for the Studio panel,
// one slot right of the Scrim chip (BrowserOverlayLauncher pattern 1-1). The panel
// owns its open state via localStorage + the OPEN_EVT window event; the chip just
// toggles and reflects it. Hiding keeps the panel mounted, so in-flight work
// survives a minimize.
import { useEffect, useState } from 'react';
import { IconClapperboard } from '../components/icons.jsx';
import { OPEN_EVT, isPanelOpen, setPanelOpen } from './OverlayStudioPanel.jsx';

export default function StudioOverlayLauncher() {
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
      title="Studio panel"
      aria-label="Studio panel"
      aria-pressed={open}
      onClick={() => setPanelOpen(!open)}
      style={{ position: 'fixed', left: 208, bottom: 16, zIndex: 30 }}
    >
      <span className="candy-face"><IconClapperboard size={18} /></span>
    </button>
  );
}

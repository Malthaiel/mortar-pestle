// Scrim launcher — the Overlay Host's minimize/open chip for the Scrim panel, one
// slot right of the Monitor chip (BrowserOverlayLauncher pattern 1-1). The panel
// owns its open state via localStorage + the OPEN_EVT window event; the chip just
// toggles and reflects it. Hiding keeps the panel mounted, so the timer, drafts,
// and dictation survive a minimize.
import { useEffect, useState } from 'react';
import { IconFilm } from '../components/icons.jsx';
import { OPEN_EVT, isPanelOpen, setPanelOpen } from './ScrimOverlayPanel.jsx';

export default function ScrimOverlayLauncher() {
  const [open, setOpen] = useState(isPanelOpen);
  useEffect(() => {
    const onChange = (e) => setOpen(!!e.detail);
    window.addEventListener(OPEN_EVT, onChange);
    return () => window.removeEventListener(OPEN_EVT, onChange);
  }, []);

  return (
    <button
      type="button"
      className={`video-cinema candy-btn ov-scrim-chip${open ? ' is-active' : ''}`}
      data-shape="icon"
      title="Scrim panel"
      aria-label="Scrim panel"
      aria-pressed={open}
      onClick={() => setPanelOpen(!open)}
      style={{ position: 'fixed', left: 160, bottom: 16, zIndex: 30 }}
    >
      <span className="candy-face"><IconFilm size={18} /></span>
    </button>
  );
}

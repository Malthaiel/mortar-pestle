// Agents launcher — a host-level candy chip in the Overlay Host that summons the
// Concierge chat over the game. The host has no dock, so this is the overlay's
// equivalent of the main-window DockAgentsButton (same IconBot + the
// openConcierge/closeConcierge helpers). Fixed to the viewport corner (NOT inside a
// CSS-transformed panel, like the host toast) so position:fixed anchors correctly.
//
// "Remember last state": the open/closed flag persists to localStorage
// 'overlay-agents-open'. On each overlay show (visible false→true) it reopens
// Concierge only when settings.agents.overlayRemember is on AND it was last open;
// otherwise it starts closed. Every open/close — launcher, the window's own ×
// (ConciergeChatWindow routes onClose through closeConcierge), remember-restore, a
// recipe re-open — flows through the concierge:open/close events, so the chip's flag
// is driven solely by those listeners and never drifts from the actual window.
import { useEffect, useRef, useState } from 'react';
import { useSettings } from '@host/hooks/useSettings.js';
import { openConcierge, closeConcierge } from '@host/agents/concierge/ConciergeProvider.jsx';
import { IconBot } from '@host/components/icons.jsx';

const OPEN_KEY = 'overlay-agents-open';
const wasOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };
const persist = (v) => { try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* ignore */ } };

export default function AgentsOverlayLauncher({ visible }) {
  const { settings } = useSettings();
  const remember = settings?.agents?.overlayRemember !== false; // default on
  const [open, setOpen] = useState(wasOpen);

  // The concierge:open/close events are the single source of truth for the chip.
  useEffect(() => {
    const onOpen = () => { setOpen(true); persist(true); };
    const onClose = () => { setOpen(false); persist(false); };
    window.addEventListener('concierge:open', onOpen);
    window.addEventListener('concierge:close', onClose);
    return () => {
      window.removeEventListener('concierge:open', onOpen);
      window.removeEventListener('concierge:close', onClose);
    };
  }, []);

  // On each overlay show, restore the last state when remember is on; else force
  // closed. Fires only on the false→true edge so a re-show doesn't thrash it.
  const prevVisible = useRef(false);
  useEffect(() => {
    if (visible && !prevVisible.current) {
      if (remember && wasOpen()) openConcierge();
      else closeConcierge();
    }
    prevVisible.current = visible;
  }, [visible, remember]);

  const toggle = () => { if (open) closeConcierge(); else openConcierge(); };

  return (
    <button
      type="button"
      className={`video-cinema candy-btn ov-agents-chip${open ? ' is-active' : ''}`}
      data-shape="icon"
      title="Concierge"
      aria-label="Concierge"
      aria-pressed={open}
      onClick={toggle}
      style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 30 }}
    >
      <span className="candy-face"><IconBot size={18} /></span>
    </button>
  );
}

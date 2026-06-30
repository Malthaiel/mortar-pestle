// CSS-transform drag for a host overlay panel (NOT a window move). The overlay-
// host is one fullscreen webview; each panel is an absolutely-positioned DOM node
// dragged by translate(). Pure frontend — no async IPC, no devicePixelRatio math
// (contrast the window-move dance the standalone overlay-capture window used).
// Position persists per panel key to localStorage so a panel reopens where it was
// left. onPointerDown bails on interactive children so buttons/inputs still work.
import { useCallback, useRef, useState } from 'react';

export default function useOverlayPanelDrag(key, initial = { x: 0, y: 0 }) {
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
    } catch { /* garbled saved value — fall through to the configured default */ }
    return initial;
  });
  const drag = useRef(null);

  const onPointerDown = useCallback((e) => {
    if (e.target.closest('button,textarea,input,select,a,[data-no-drag]')) return;
    e.preventDefault();
    drag.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
  }, [pos.x, pos.y]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    setPos({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) });
  }, []);

  const end = useCallback((e) => {
    if (!drag.current) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    // Functional update reads the latest pos (the closure's pos may be stale).
    setPos((p) => { try { localStorage.setItem(key, JSON.stringify(p)); } catch {} return p; });
  }, [key]);

  return {
    style: { transform: `translate(${pos.x}px, ${pos.y}px)` },
    dragProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
  };
}

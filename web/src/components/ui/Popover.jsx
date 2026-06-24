// Shared mini-popover chrome — the floating candy panel that anchored pop-ups
// (Downloads, Notifications, the dock Vault-switcher) render through, so they stay
// visually identical and future popovers inherit the look for free. The smaller-
// scale sibling of AppWindow: a candy floating surface (default `.candy-modal`),
// an optional header (title + actions + close), and a scrollable body — but
// POSITIONED BY THE CALLER via the `style` prop (spread onto the panel root)
// rather than centered over a backdrop.
//
// Chrome and positioning are split on purpose: this component owns the surface +
// header + body + Esc + click-outside; the caller computes placement. The
// co-located `useAnchoredRect` hook absorbs the anchor-above-a-dock-button rect
// math that Downloads + Notifications used to duplicate verbatim.
//
// Reuses existing pieces only — `.candy-modal` / `.candy-card` + the candy
// `IconBtn` (Button.jsx). No new CSS. Any entrance animation MUST be passed
// INLINE via `style` (e.g. `animation: 'notifPanelIn …'`) so the
// body[data-anim-*] gates — which match `[style*="<name>"]` — keep working.
//
// Props: open, onClose, title?, headerActions?, showClose=false, accent?,
// style? (positioning seam), panelClassName='candy-modal', bodyStyle?,
// portal=true, role='dialog', ariaLabel?, closeOnOutside=true, outsideExempt?
// (selector the outside-click ignores so the trigger toggles), escToClose=true,
// children.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconBtn } from './Button.jsx';
import { IconX } from '../icons.jsx';

export default function Popover({
  open,
  onClose,
  title,
  headerActions,
  showClose = false,
  accent,
  style,
  panelClassName = 'candy-modal',
  bodyStyle,
  portal = true,
  role = 'dialog',
  ariaLabel,
  closeOnOutside = true,
  outsideExempt,
  escToClose = true,
  children,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (escToClose && e.key === 'Escape') onClose?.(); };
    const onDown = (e) => {
      if (!closeOnOutside) return;
      if (panelRef.current && !panelRef.current.contains(e.target) &&
          !(outsideExempt && e.target.closest?.(outsideExempt))) onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open, escToClose, closeOnOutside, outsideExempt, onClose]);

  if (!open) return null;

  const hasHeader = title || headerActions || showClose;

  const panel = (
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel || (typeof title === 'string' ? title : undefined)}
      className={panelClassName}
      style={{
        ...(accent ? { '--accent': accent } : {}),
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        color: 'var(--text)', fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      {hasHeader && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          {title && <span style={{ fontWeight: 600, fontSize: 13, flex: 1, minWidth: 0 }}>{title}</span>}
          {headerActions}
          {showClose && <IconBtn onClick={onClose} title="Close" size={28}><IconX/></IconBtn>}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', ...bodyStyle }}>
        {children}
      </div>
    </div>
  );

  return portal ? createPortal(panel, document.body) : panel;
}

// Anchor a fixed popover ABOVE a trigger rect, falling back to centered-above-dock
// when the trigger is gone (e.g. the hover-dock collapsed it). Returns a
// `{ left, bottom }` fragment to spread into the Popover `style`, or null while
// closed / before the first measure (caller renders nothing until it resolves).
export function useAnchoredRect(getRect, { open, width, gap = 10, pad = 8 } = {}) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const r = getRect?.();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left, bottom;
    if (r && (r.width || r.height)) {
      left = r.left + r.width / 2 - width / 2;
      bottom = vh - r.top + gap;
    } else {
      left = vw / 2 - width / 2;
      bottom = 64;
    }
    left = Math.max(pad, Math.min(left, vw - width - pad));
    setPos({ left, bottom });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return pos;
}

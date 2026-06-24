// Shared window chrome — the one full-screen modal shell every "big window"
// (Settings, Downloads manager, Recycling bin) renders through, so they stay
// visually identical and future windows inherit the look for free. Mirrors the
// Settings-drawer chrome: a `.candy-modal` panel over a `.candy-backdrop` scrim,
// portaled to <body>, with a title + optional centered content + actions + close
// header, a scrollable body, and an optional footer.
//
// Reuses existing pieces only — `.candy-modal` / `.candy-backdrop` / `fadeIn`
// (styles.css) and the candy `IconBtn` (Button.jsx). No new CSS.
//
// `fadeIn` is kept INLINE on the panel on purpose: the "disable drawer/modal
// animation" setting gates it via `[style*="fadeIn"]` (see styles.css § candy-modal).
//
// Props: open, onClose, title, icon?, accent?, width=960, height='min(680px,85vh)',
// headerContent? (flex-1 middle slot), headerActions? (right of middle, before
// close), footer?, bodyStyle? (merged over the body default), escToClose=true,
// closeOnBackdrop=true, children.

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { IconBtn } from './Button.jsx';
import { IconX } from '../icons.jsx';

export default function AppWindow({
  open,
  onClose,
  title,
  icon,
  accent,
  width = 960,
  height = 'min(680px, 85vh)',
  headerContent,
  headerActions,
  footer,
  bodyStyle,
  escToClose = true,
  closeOnBackdrop = true,
  children,
}) {
  useEffect(() => {
    if (!open || !escToClose) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, escToClose, onClose]);

  if (!open) return null;

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div className="candy-backdrop" onClick={closeOnBackdrop ? onClose : undefined}/>
      <div className="candy-modal" style={{
        ...(accent ? { '--accent': accent } : {}),
        position: 'relative',
        width,
        height,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        animation: 'fadeIn 0.18s ease',
      }}>
        {/* Header */}
        <div className="candy-center-row" style={{
          padding: '18px 22px 14px',
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', gap: 14,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {icon}
            <div style={{
              fontSize: 17, fontWeight: 600,
              letterSpacing: '-0.01em', color: 'var(--text)',
            }}>{title}</div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>{headerContent}</div>
          {headerActions}
          <IconBtn onClick={onClose} title="Close" size={30}><IconX/></IconBtn>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 26px', ...bodyStyle }}>
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div style={{
            padding: '12px 22px',
            borderTop: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

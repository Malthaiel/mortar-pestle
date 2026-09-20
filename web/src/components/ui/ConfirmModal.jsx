// Minimal reusable confirm modal. The app previously had only ModulesTab's
// inline ConfirmDisable; this fills the gap for the vault-switch dirty guard
// (and any future yes/no prompt). Backdrop click / Esc = cancel, Enter =
// confirm. Renders nothing when closed.

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { OutlinedBtn, DangerOutlinedBtn } from './Button.jsx';

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  danger = false,
  width = 360,
  children,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel?.(); }
      else if (e.key === 'Enter') { e.stopPropagation(); onConfirm?.(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;
  // Portalled to body at 1100, the app's standard "modal above a window" layer.
  // Rendered inline at 1000 it tied with AppWindow's own portal and lost on DOM
  // order — the backdrop landed but the box itself painted underneath the window.
  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="candy-section"
        style={{
          width, maxWidth: '90vw',
          padding: '18px 20px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        {title && <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{title}</div>}
        {message && (
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>{message}</div>
        )}
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <OutlinedBtn small onClick={onCancel}>{cancelLabel}</OutlinedBtn>
          {danger
            ? <DangerOutlinedBtn small onClick={onConfirm}>{confirmLabel}</DangerOutlinedBtn>
            : <OutlinedBtn small onClick={onConfirm}>{confirmLabel}</OutlinedBtn>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

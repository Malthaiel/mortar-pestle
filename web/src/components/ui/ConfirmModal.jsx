// Minimal reusable confirm modal. The app previously had only ModulesTab's
// inline ConfirmDisable; this fills the gap for the vault-switch dirty guard
// (and any future yes/no prompt). Backdrop click / Esc = cancel, Enter =
// confirm. Renders nothing when closed.

import { useEffect } from 'react';
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
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="candy-section"
        style={{
          width: 360, maxWidth: '90vw',
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
    </div>
  );
}

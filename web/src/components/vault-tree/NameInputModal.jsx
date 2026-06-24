// Text-prompt modal for the vault tree's New note / New folder / Rename ops.
// Mirrors ConfirmModal's shell (backdrop click / Esc = cancel) but adds a single
// autofocused + preselected text input; Enter submits when non-empty. The value
// is trimmed and stripped of path separators before submit so a name can't nest
// or escape (resolve_in on the Rust side also enforces root containment).

import { useEffect, useRef, useState } from 'react';
import { OutlinedBtn } from '../ui/Button.jsx';

export default function NameInputModal({
  open,
  title,
  label,
  placeholder,
  initialValue = '',
  confirmLabel = 'Create',
  onSubmit,
  onCancel,
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef(null);

  useEffect(() => { if (open) setValue(initialValue); }, [open, initialValue]);
  useEffect(() => {
    if (!open) return;
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
  }, [open]);

  if (!open) return null;

  const clean = value.trim().replace(/[/\\]/g, '');
  const submit = () => { if (clean) onSubmit?.(clean); };

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)', backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="candy-section"
        style={{ width: 360, maxWidth: '90vw', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {title && <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{title}</div>}
        {label && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{label}</div>}
        <input
          ref={inputRef}
          className="candy-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
            else if (e.key === 'Escape') { e.stopPropagation(); onCancel?.(); }
          }}
          style={{
            width: '100%', padding: '8px 12px', fontSize: 13,
            color: 'var(--text)', fontFamily: 'var(--font-body)', outline: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <OutlinedBtn small onClick={onCancel}>Cancel</OutlinedBtn>
          <OutlinedBtn small onClick={submit}>{confirmLabel}</OutlinedBtn>
        </div>
      </div>
    </div>
  );
}

// Text input and select primitives. Both follow the design language:
//   - --surface-2 background, 1px --border
//   - On focus: border becomes accent
//   - 8px 10px padding, 13px body font, --radius-md (8)

import { useState } from 'react';

export function TextInput({
  value, onChange, placeholder, type = 'text', accent, style,
  onKeyDown, onFocus, onBlur, autoFocus, disabled, invalid,
}) {
  const [focus, setFocus] = useState(false);
  const borderColor = invalid
    ? '#e07b7b'
    : focus
      ? (accent || 'var(--text)')
      : 'var(--border)';
  return (
    <input
      className="candy-input"
      type={type}
      value={value ?? ''}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
      disabled={disabled}
      onFocus={(e) => { setFocus(true); onFocus?.(e); }}
      onBlur={(e) => { setFocus(false); onBlur?.(e); }}
      style={{
        padding: '8px 10px',
        color: 'var(--text)',
        border: `1px solid ${borderColor}`,
        fontSize: 13, fontFamily: 'var(--font-body)',
        outline: 'none',
        opacity: disabled ? 0.5 : 1,
        transition: 'border-color 80ms ease',
        ...style,
      }}
    />
  );
}

export function Select({ value, onChange, options, accent, style, disabled }) {
  const [focus, setFocus] = useState(false);
  return (
    <select
      className="candy-input"
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        width: '100%',
        padding: '8px 10px',
        color: 'var(--text)',
        border: `1px solid ${focus ? (accent || 'var(--text)') : 'var(--border)'}`,
        fontSize: 13, fontFamily: 'var(--font-body)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        outline: 'none',
        opacity: disabled ? 0.5 : 1,
        transition: 'border-color 80ms ease',
        ...style,
      }}
    >
      {options.map(o => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
    </select>
  );
}

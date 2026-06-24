// Shared accent-picker primitives. Used by both the host Settings drawer
// (global accent + per-page accent) and the Planner module's Settings tab
// (Planner/timer accent). Was inlined inside SettingsDrawer.jsx until the
// Planner accent moved into the module's own tab.

import { useEffect, useState } from 'react';
import { TextInput } from './index.js';

export const ACCENT_PRESETS = [
  '#7c2d2d', '#9c4a1a', '#a0552b', '#b8860b',
  '#5d3a4a', '#2f5d3a', '#3d5a4a', '#475569',
  '#3d2e26', '#1f2937', '#52525b', '#312e81',
];

export const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function AccentGrid({ value, onChange, defaultColor }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 28px)',
      gap: 10,
    }}>
      {/* Optional theme-default swatch, leading the row. A plain candy swatch
          (no marker) — its job is a guaranteed reset-to-default target even when
          the theme default isn't one of the presets; the title carries the
          affordance. Omitted when defaultColor is not passed. */}
      {defaultColor && (() => {
        const active = value?.toLowerCase() === defaultColor.toLowerCase();
        return (
          <button
            key="__default"
            type="button"
            onClick={() => onChange(defaultColor)}
            title="Theme default — click to reset"
            data-own-press
            className={`candy-btn${active ? ' is-active' : ''}`}
            data-shape="swatch"
            style={{ '--accent': defaultColor }}
          >
            <span className="candy-face" style={{ background: defaultColor }} />
          </button>
        );
      })()}
      {ACCENT_PRESETS.map(c => {
        const active = value?.toLowerCase() === c.toLowerCase();
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            title={c}
            data-own-press
            className={`candy-btn${active ? ' is-active' : ''}`}
            data-shape="swatch"
            style={{ '--accent': c }}
          >
            <span className="candy-face" style={{ background: c }} />
          </button>
        );
      })}
    </div>
  );
}

export function HexInput({ value, onChange, accent }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const valid = HEX_RE.test(text);
  const dirty = text !== value;
  return (
    <div style={{ position: 'relative', width: 120 }}>
      <TextInput
        value={text}
        onChange={(v) => {
          const trimmed = v.trim();
          setText(trimmed);
          if (HEX_RE.test(trimmed)) onChange(trimmed);
        }}
        onBlur={() => { if (!valid) setText(value); }}
        placeholder="#rrggbb"
        accent={accent}
        invalid={dirty && !valid}
        style={{
          width: '100%',
          paddingRight: 28,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.04em',
          textAlign: 'left',
        }}
      />
      <span aria-hidden style={{
        position: 'absolute', right: 10, top: 0, bottom: 0,
        display: 'flex', alignItems: 'center', pointerEvents: 'none',
        color: valid
          ? (dirty ? (accent || 'var(--text-muted)') : 'var(--text-faint)')
          : '#e07b7b',
        fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
      }}>{valid ? '✓' : '!'}</span>
    </div>
  );
}

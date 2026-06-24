// Sounds settings tab. Three host toggles, master OFF, preset chips
// (Full / Silent), search input. Each row has a ▶ audition button
// that plays the sound once via { force: true } so it previews even when muted.

import { useMemo, useState } from 'react';
import EnableToggle from '../ui/EnableToggle.jsx';
import { Seg } from '../ui/Pill.jsx';
import { SOUND_KEYS, SOUND_PRESETS } from '../../hooks/useSettings.js';
import {
  playTactileThock,
  playReorderPickup,
  playReorderDrop,
} from '../../hooks/useTactileSound.js';

const ROWS = [
  { key: 'tactile-button-thock', label: 'Button thock',        description: 'Subtle size-aware click on every button press. Pitch scales with button size: larger buttons play lower.', kind: 'host' },
  { key: 'reorder-pickup-thock', label: 'Drag pickup thock',   description: 'Low, rounded tap when lifting a sidebar pill to begin a drag-reorder.', kind: 'host' },
  { key: 'reorder-drop-thock',   label: 'Drag drop thock',     description: 'Crisper, slightly higher tap when releasing a sidebar pill into its new slot.', kind: 'host' },
];

const PRESET_OPTIONS = [
  { value: 'full',    label: 'Full' },
  { value: 'silent',  label: 'Silent' },
];

function audition(key) {
  // Force-play bypasses the gating check.
  switch (key) {
    case 'tactile-button-thock':
      // Synthesize against a fake medium-sized button rect.
      playTactileThock({ getBoundingClientRect: () => ({ width: 64, height: 28 }) }, { force: true });
      break;
    case 'reorder-pickup-thock': playReorderPickup({ force: true }); break;
    case 'reorder-drop-thock':   playReorderDrop({ force: true });   break;
    default: break;
  }
}

export default function SoundsTab({ settings, setSetting, accent }) {
  const sounds = settings.sounds || {};
  // 'tactile' retired (≡ 'full' once the Planner sounds left) — show stored
  // legacy values as 'full'; the stored key self-heals on the next sounds edit.
  const rawPreset = settings.soundsPreset || 'silent';
  const preset = rawPreset === 'tactile' ? 'full' : rawPreset;
  const masterOn = SOUND_KEYS.some(k => sounds[k] === true);
  const [query, setQuery] = useState('');
  const accentColor = accent || 'var(--text)';

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ROWS;
    return ROWS.filter(r =>
      r.label.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  }, [query]);

  const applyPreset = (name) => {
    const bag = SOUND_PRESETS[name];
    if (!bag) return;
    setSetting({ sounds: { ...bag }, soundsPreset: name });
  };

  const masterToggle = () => {
    if (masterOn) applyPreset('silent');
    else          applyPreset('full');
  };

  const toggleRow = (key) => {
    setSetting('sounds', { [key]: sounds[key] !== true });
  };

  return (
    <div>
      {/* Master + presets header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, marginBottom: 16,
        padding: '10px 12px',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <EnableToggle enabled={masterOn} accent={accentColor} onChange={masterToggle} title="Master switch"/>
          <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)' }}>
            All sounds
          </span>
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em', color: 'var(--text-faint)',
            textTransform: 'uppercase',
          }}>{masterOn ? 'on' : 'off'}</span>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Seg value={preset} options={PRESET_OPTIONS} onChange={applyPreset} accent={accentColor}/>
          {preset === 'custom' && (
            <span style={{
              fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
              color: 'var(--text-faint)', textTransform: 'uppercase',
            }}>custom</span>
          )}
        </div>
      </div>

      {/* Search */}
      <input
        type="search"
        placeholder="Search sounds…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{
          width: '100%',
          marginBottom: 14,
          padding: '8px 12px',
          fontSize: 12,
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          fontFamily: 'var(--font-body)',
          outline: 'none',
        }}
      />

      {/* Row list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filteredRows.length === 0 && (
          <div style={{
            padding: '14px 16px', fontSize: 12,
            color: 'var(--text-muted)',
            background: 'var(--surface-2)',
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius-md)',
          }}>No sounds match "{query}".</div>
        )}
        {filteredRows.map(row => (
          <Row
            key={row.key}
            row={row}
            on={sounds[row.key] === true}
            accent={accentColor}
            onToggle={() => toggleRow(row.key)}
            onAudition={() => audition(row.key)}
          />
        ))}
      </div>

    </div>
  );
}

function Row({ row, on, accent, onToggle, onAudition }) {
  return (
    <div
      data-search-anchor={`set-sound-${row.key}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 12px',
        borderRadius: 'var(--radius-md)',
        background: 'transparent',
        transition: 'background 80ms ease',
      }}
      onMouseOver={(e) => e.currentTarget.style.background = 'var(--hover)'}
      onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)' }}>{row.label}</span>
          {row.kind === 'planner' && (
            <span style={{
              fontSize: 9, fontFamily: 'var(--font-mono)',
              letterSpacing: '0.08em', textTransform: 'uppercase',
              padding: '1px 5px',
              borderRadius: 'var(--radius-sm)',
              background: `color-mix(in oklch, ${accent} 18%, transparent)`,
              color: accent,
            }}>Planner</span>
          )}
        </div>
        <div style={{
          fontSize: 11, color: 'var(--text-muted)',
          marginTop: 2, lineHeight: 1.45,
        }}>{row.description}</div>
      </div>
      <AuditionButton accent={accent} onClick={onAudition}/>
      <EnableToggle enabled={on} accent={accent} onChange={onToggle} title={row.label}/>
    </div>
  );
}

function AuditionButton({ accent, onClick }) {
  return (
    <button
      onClick={onClick}
      type="button"
      title="Audition"
      style={{
        appearance: 'none',
        width: 26, height: 26,
        borderRadius: 13,
        border: `1px solid color-mix(in oklch, ${accent} 50%, transparent)`,
        background: 'transparent',
        color: accent,
        display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
        transition: 'background 120ms ease, transform 80ms ease',
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = `color-mix(in oklch, ${accent} 12%, transparent)`}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="6 4 20 12 6 20 6 4"/>
      </svg>
    </button>
  );
}

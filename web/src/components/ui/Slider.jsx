// Shared slider primitive — accent-tinted native range + monospace value
// readout. Promoted from SettingsDrawer so the drawer and AgentsTab (Atelier
// edge-magnetism) share one styled control.

// `readout` replaces the value display outright — for a value a bare number reads badly
// as (a position in a recording is `1:41:08`, not `6068`), or one worth making typeable.
// Omitted = the plain `value + unit` span.
export function Slider({ value, min, max, step = 1, unit = '', onChange, accent, readout }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: accent }}
      />
      {readout ?? (
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)', width: 44, textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}>{value}{unit}</span>
      )}
    </div>
  );
}

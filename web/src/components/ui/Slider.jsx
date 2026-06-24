// Shared slider primitive — accent-tinted native range + monospace value
// readout. Promoted from SettingsDrawer so the drawer and AgentsTab (Atelier
// edge-magnetism) share one styled control.

export function Slider({ value, min, max, step = 1, unit = '', onChange, accent }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: accent }}
      />
      <span style={{
        fontSize: 11, fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)', width: 44, textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      }}>{value}{unit}</span>
    </div>
  );
}

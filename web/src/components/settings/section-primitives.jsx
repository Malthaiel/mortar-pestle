// Shared section primitives for Settings drawer tabs and module settings
// pages: a titled candy-section band, a single-line label/control row, and a
// stacked label-above-control row. `anchor` stamps data-search-anchor so the
// header search can jump to + flash the exact row. Moved verbatim out of
// SettingsDrawer.jsx so module pages and extracted tabs share one copy.

export function SectionBand({ title, anchor, children }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600,
        marginBottom: 12,
      }}>{title}</div>
      <div className="candy-section" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px' }}>
        {children}
      </div>
    </div>
  );
}

export function Row({ label, anchor, children }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 16, minHeight: 32,
    }}>
      <span style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>{label}</span>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

export function StackedRow({ label, hint, anchor, children }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

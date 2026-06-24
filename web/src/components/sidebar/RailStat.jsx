// Primitive for one statistic in the collapsed sidebar rail. Label + value
// render as a single rotated string (`ALBUMS 11`) reading bottom-to-top —
// tilt your head LEFT to read. Achieved via `writing-mode: vertical-rl`
// (natural vertical layout box) + a 180° rotation that flips chars to face
// the other direction. Label is muted, value picks up the module's accent.

export default function RailStat({ label, value, accent }) {
  const accentColor = accent || 'var(--text)';
  const display = formatValue(value);
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <span style={{
        writingMode: 'vertical-rl',
        textOrientation: 'mixed',
        transform: 'rotate(180deg)',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.15,
        color: 'var(--text-muted)',
      }}>
        {label}
        {' '}
        <span style={{ color: accentColor, fontWeight: 700 }}>{display}</span>
      </span>
    </div>
  );
}

function formatValue(v) {
  if (v === null || v === undefined || v === '—') return '—';
  if (typeof v === 'string') return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

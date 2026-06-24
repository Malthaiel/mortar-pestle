// Stat / chip primitives.
//   - Dot: small inline colored circle, optional 22% box-shadow glow ring
//   - StatTile: block stat — 9px mono caption above 15-18px weight 600 value
//   - StatChip: inline outlined chip with label + value + optional dot/sub
//   - FrontmatterChip: key:value pill used in PageView frontmatter rows
// Status palette: Plan = --text-muted, Current = accent, Completed = #6fb56f,
// On-Hold = #d9a55a, Dropped/Failed = #e07b7b.

export function Dot({ color, glow, size = 6 }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%',
      background: color,
      boxShadow: glow ? `0 0 0 3px color-mix(in oklch, ${color} 22%, transparent)` : 'none',
      flexShrink: 0,
      display: 'inline-block',
    }}/>
  );
}

export function StatTile({ label, value, accent }) {
  return (
    <div style={{
      background: 'var(--surface-2)', borderRadius: 'var(--radius-md)',
      padding: '8px 14px', border: '1px solid var(--border)',
    }}>
      <div style={{
        fontSize: 9, color: 'var(--text-faint)',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.06em', textTransform: 'uppercase',
        marginBottom: 4,
      }}>{label}</div>
      <div style={{
        fontSize: 18, fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
        color: accent || 'var(--text)',
        lineHeight: 1.15,
      }}>{value}</div>
    </div>
  );
}

export function StatChip({ label, value, sub, dot }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 10,
      padding: '6px 12px',
      borderRadius: 'var(--radius-md)',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
    }}>
      {dot && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: dot,
          flexShrink: 0,
        }}/>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{
          fontSize: 9, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--text-faint)', fontWeight: 600,
        }}>{label}</span>
        <span style={{
          fontSize: 13, fontFamily: 'var(--font-body)',
          color: 'var(--text)', fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.1,
        }}>{value}</span>
      </div>
      {sub && (
        <span style={{
          fontSize: 10, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em', textTransform: 'lowercase',
          color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
          marginLeft: 2,
        }}>{sub}</span>
      )}
    </div>
  );
}

export function FrontmatterChip({ field, value }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 6,
      padding: '3px 10px',
      borderRadius: 999,
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      fontSize: 11, fontFamily: 'var(--font-body)',
      color: 'var(--text-2)',
      maxWidth: 320,
      overflow: 'hidden',
    }}>
      <span style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600,
      }}>{field}</span>
      <span style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</span>
    </span>
  );
}

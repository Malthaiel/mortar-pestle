// Page-level section header + matching state primitives.
//   - SectionHeader: 30px title, optional subtitle, optional right-side action,
//     optional 2px progress sliver pinned to the bottom edge
//   - EmptyState: centered, faint dot prefix + 13px --text-muted message + optional CTA
//   - LoadingState: caption-treated loading text with a small leading dot

import { HeaderChip } from './Button.jsx';

export function SectionHeader({ title, subtitle, action, progress, accent }) {
  return (
    <header className="candy-chip-row" style={{
      position: 'relative',
      padding: '32px 32px 18px',
      borderBottom: '1px solid var(--border)',
      alignItems: 'flex-end', '--candy-gap': '16px',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={{
          margin: 0, fontSize: 30, fontWeight: 700,
          color: 'var(--text)', lineHeight: 1.12,
          letterSpacing: '-0.015em',
        }}>{title}</h2>
        {subtitle && (
          <div style={{
            fontSize: 13, color: 'var(--text-muted)',
            marginTop: 6,
            fontVariantNumeric: 'tabular-nums',
          }}>{subtitle}</div>
        )}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
      {progress != null && accent && (
        <div aria-hidden style={{
          position: 'absolute', left: 0, right: 0, bottom: -1, height: 2,
          background: `color-mix(in oklch, ${accent} 14%, transparent)`,
          pointerEvents: 'none',
        }}>
          <div style={{
            width: `${Math.min(100, Math.max(0, progress * 100))}%`,
            height: '100%', background: accent,
            transition: 'width 200ms ease',
          }}/>
        </div>
      )}
    </header>
  );
}

export function EmptyState({ message, ctaLabel, ctaHref, ctaOnClick, accent }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 14, padding: '48px 24px',
      color: 'var(--text-faint)',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: 'var(--text-faint)', opacity: 0.5,
      }}/>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{message}</div>
      {ctaLabel && (ctaHref || ctaOnClick) && (
        <HeaderChip href={ctaHref} onClick={ctaOnClick} accent={accent}>{ctaLabel}</HeaderChip>
      )}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '32px 32px',
      color: 'var(--text-muted)', fontSize: 12,
      fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
      textTransform: 'uppercase',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: 'var(--text-faint)',
      }}/>
      <span>{label}</span>
    </div>
  );
}

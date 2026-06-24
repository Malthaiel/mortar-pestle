// Fallback shown in the collapsed sidebar rail when the active module
// doesn't define a `renderRail` callback. Renders the module's display
// name as a single rotated label (tilt head LEFT to read), top-anchored
// directly under the brand-pill divider to match modules that DO define
// rail stats.

export default function RailEmptyState({ manifest, accent }) {
  if (!manifest) return null;
  const name = manifest.name || manifest.label || manifest.id || '';
  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingTop: 12,
      overflow: 'hidden',
    }}>
      <span style={{
        writingMode: 'vertical-rl',
        textOrientation: 'mixed',
        transform: 'rotate(180deg)',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-muted)',
      }}>
        {name}
      </span>
    </div>
  );
}

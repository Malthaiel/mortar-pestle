// Sideways version chip pinned to the bottom of the collapsed sidebar rail.
// Mirrors RailEmptyState's writingMode + rotate(180deg) technique so it reads
// in the same head-tilt-left orientation as the module-name label above it.
// Display-only; no hover tooltip.

export default function VersionChip() {
  const version = import.meta.env.PACKAGE_VERSION || '0.0.0';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 10,
        flexShrink: 0,
      }}
    >
      <span style={{
        writingMode: 'vertical-rl',
        textOrientation: 'mixed',
        transform: 'rotate(180deg)',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.18em',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-faint)',
        userSelect: 'none',
      }}>
        v{version}
      </span>
    </div>
  );
}

// Full-pane loading pre-screen for the anime detail / character / voice-actor
// pages. Shown ALONE while a page's data loads — no partial content behind it —
// so navigation always lands on a clean spinner, then the whole page appears at
// once. Uses the shared `ftvSpin` keyframe (styles.css).

export default function LoadingScreen({ accent, label = 'Loading…' }) {
  const a = accent || 'var(--accent)';
  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column', gap: 14,
      alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-faint)',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: '50%',
        border: '3px solid var(--border)',
        borderTopColor: a,
        animation: 'ftvSpin 0.8s linear infinite',
      }} />
      <div style={{
        fontSize: 12, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.06em', color: 'var(--text-faint)',
      }}>{label}</div>
    </div>
  );
}

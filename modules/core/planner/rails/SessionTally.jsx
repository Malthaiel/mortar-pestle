// Session Tally: vertical column of session glyphs — filled circles for
// completed pomCount, an animated ring for the running session, faint
// empties for the next-up. MM:SS at the bottom.

import { usePlanner } from '../PlannerProvider.jsx';

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

const SLOTS = 5;

export default function SessionTally({ accent }) {
  const { phase, secsLeft, running, pomCount } = usePlanner();
  const phaseColor = phase === 'focus' ? accent : '#27ae60';
  const completed = Math.min(pomCount || 0, SLOTS);
  const currentIsRunning = !!running && phase === 'focus';
  const slots = Array.from({ length: SLOTS }, (_, i) => {
    if (i < completed) return 'done';
    if (i === completed && currentIsRunning) return 'now';
    return 'empty';
  });

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 8, padding: '10px 4px',
      overflow: 'hidden',
    }}>
      <span style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        letterSpacing: '0.14em',
        lineHeight: 1.15,
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        flexShrink: 0,
      }}>TODAY</span>

      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column-reverse',
        alignItems: 'center', justifyContent: 'center',
        gap: 5,
      }}>
        {slots.map((kind, i) => {
          const base = {
            width: 10, height: 10, borderRadius: '50%',
            flexShrink: 0,
            color: phaseColor,
          };
          if (kind === 'done') {
            return <div key={i} style={{ ...base, background: phaseColor }}/>;
          }
          if (kind === 'now') {
            return <div key={i} style={{
              ...base,
              background: 'transparent',
              boxShadow: `inset 0 0 0 2px ${phaseColor}`,
            }}/>;
          }
          return <div key={i} style={{
            ...base,
            background: 'transparent',
            boxShadow: 'inset 0 0 0 1px var(--border)',
            opacity: 0.6,
          }}/>;
        })}
      </div>

      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.14em',
        lineHeight: 1.15,
        color: phaseColor,
        flexShrink: 0,
      }}>{fmt(secsLeft)}</span>
    </div>
  );
}

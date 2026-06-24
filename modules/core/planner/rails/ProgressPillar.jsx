// Progress Pillar: phase chip at top, full-height pillar drains as
// secsLeft decreases, phase-tinted gradient. Rotated MM:SS overlaid
// at the pillar's vertical center.

import { usePlanner } from '../PlannerProvider.jsx';

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

export default function ProgressPillar({ accent }) {
  const { phase, secsLeft, focusSecs, breakSecs } = usePlanner();
  const phaseColor = phase === 'focus' ? accent : '#27ae60';
  const total = phase === 'focus' ? focusSecs : breakSecs;
  const frac = total > 0 ? Math.max(0, Math.min(1, secsLeft / total)) : 0;

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 8, padding: '10px 4px',
      overflow: 'hidden',
    }}>
      <span style={{
        fontSize: 8.5,
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        letterSpacing: '0.14em',
        lineHeight: 1.15,
        textTransform: 'uppercase',
        color: phaseColor,
        padding: '2px 6px',
        borderRadius: 999,
        background: `color-mix(in oklch, ${phaseColor} 14%, transparent)`,
        flexShrink: 0,
      }}>{phase === 'focus' ? 'FOCUS' : 'BREAK'}</span>

      <div style={{
        flex: 1, minHeight: 0, width: 18,
        position: 'relative',
        borderRadius: 999,
        background: 'color-mix(in oklch, var(--text) 6%, transparent)',
        overflow: 'hidden',
        boxShadow: 'inset 0 0 0 1px var(--border)',
      }}>
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          height: `${frac * 100}%`,
          background: `linear-gradient(180deg,
            color-mix(in oklch, ${phaseColor} 90%, transparent) 0%,
            ${phaseColor} 100%)`,
          transition: 'height 800ms linear',
          borderRadius: 999,
        }}/>
        <span style={{
          position: 'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.14em',
          lineHeight: 1.15,
          color: 'white',
          whiteSpace: 'nowrap',
          textShadow: '0 1px 2px rgba(0,0,0,0.55)',
          pointerEvents: 'none',
        }}>{fmt(secsLeft)}</span>
      </div>
    </div>
  );
}

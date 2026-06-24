// Sand Timer: animated hourglass via SVG — top bulb drains as the phase
// elapses, bottom bulb fills. Phase chip rotated alongside. On phase
// change the visual reads as a fresh top-fill (handled implicitly by
// secsLeft resetting to the new phase's total).

import { usePlanner } from '../PlannerProvider.jsx';

export default function SandTimer({ accent }) {
  const { phase, secsLeft, focusSecs, breakSecs } = usePlanner();
  const phaseColor = phase === 'focus' ? accent : '#27ae60';
  const total = phase === 'focus' ? focusSecs : breakSecs;
  const frac = total > 0 ? Math.max(0, Math.min(1, secsLeft / total)) : 0;
  // Hourglass: top bulb fill = frac. Bottom bulb fill = 1 - frac.
  // Each bulb is drawn as a triangle clipping a fill rect.

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 8, padding: '10px 4px',
      overflow: 'hidden',
    }}>
      <svg width={28} height={56} viewBox="0 0 36 72" style={{ flexShrink: 0 }}>
        <defs>
          <clipPath id="hg-top">
            <polygon points="4,4 32,4 18,32"/>
          </clipPath>
          <clipPath id="hg-bot">
            <polygon points="18,40 32,68 4,68"/>
          </clipPath>
        </defs>
        {/* Top bulb outline */}
        <polygon points="4,4 32,4 18,32" fill="none"
          stroke="var(--border)" strokeWidth={1}/>
        {/* Top bulb fill — drains from top */}
        <rect x={0} y={4 + (1 - frac) * 28} width={36} height={frac * 28}
          fill={phaseColor} clipPath="url(#hg-top)"
          style={{ transition: 'y 800ms linear, height 800ms linear' }}/>
        {/* Neck */}
        <rect x={16} y={32} width={4} height={8} fill={phaseColor} opacity={0.7}/>
        {/* Bottom bulb outline */}
        <polygon points="4,68 32,68 18,40" fill="none"
          stroke="var(--border)" strokeWidth={1}/>
        {/* Bottom bulb fill — fills from bottom */}
        <rect x={0} y={40 + frac * 28} width={36} height={(1 - frac) * 28}
          fill={phaseColor} clipPath="url(#hg-bot)"
          style={{ transition: 'y 800ms linear, height 800ms linear' }}/>
      </svg>

      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.14em',
          lineHeight: 1.15,
          textTransform: 'uppercase',
          color: phaseColor,
          whiteSpace: 'nowrap',
        }}>{phase === 'focus' ? 'FOCUS' : 'BREAK'}</span>
      </div>
    </div>
  );
}

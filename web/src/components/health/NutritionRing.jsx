// Radial calorie ring for the Nutrition ledger (Health Column epic, sub-plan 3
// preview — Foundation ships the empty/zero state). `value`/`goal` in kcal; the
// arc is clamp(value/goal). Over goal, the arc shifts to the error token. Exact
// diameter, stroke, and over-goal treatment are tuned live in the NUT-SF4
// DESIGN pass; this is a sane default, not the final spec.
//
// The arc transitions via an INLINE style (not a CSS class) so the Settings
// animation toggles keep matching it.
export default function NutritionRing({
  value = 0,
  goal = 0,
  size = 132,
  stroke = 11,
  accent = 'var(--accent)',
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const frac = goal > 0 ? Math.min(1, Math.max(0, value / goal)) : 0;
  const over = goal > 0 && value > goal;
  const arc = circ * frac;
  const ringColor = over ? 'var(--error)' : accent;

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: 'rotate(-90deg)' }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="color-mix(in oklch, var(--text) 12%, transparent)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={ringColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circ - arc}`}
          style={{ transition: 'stroke-dasharray 220ms cubic-bezier(0.16, 1, 0.3, 1), stroke 200ms ease' }}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        fontFamily: 'var(--font-mono)',
      }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>
          {Math.round(value)}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 3, letterSpacing: '0.04em' }}>
          {goal > 0 ? `/ ${Math.round(goal)} kcal` : 'kcal'}
        </span>
      </div>
    </div>
  );
}

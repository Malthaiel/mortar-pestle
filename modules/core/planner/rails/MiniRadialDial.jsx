// Minimal: a single rounded sideways-rendered box in the 56 px
// collapsed-right-sidebar rail showing the phase chip (right, bold) and the
// MM:SS time (left, muted) via writing-mode: vertical-rl. Whole tile taps
// to toggle the timer. No dial, no stats, no motion.

import { usePlanner } from '../PlannerProvider.jsx';

const PHASE_HUE = { focus: 28, break: 125 };
function colorsForHue(hue) {
  return `oklch(0.72 0.13 ${hue})`;
}

function fmt(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

export default function MiniRadialDial({ accent: _appAccent }) {
  const { phase, secsLeft, focusSecs, running, idle, toggleTimer } = usePlanner();

  const hue = PHASE_HUE[phase] ?? PHASE_HUE.focus;
  const phaseColor = colorsForHue(hue);

  const isIdle = idle;
  const displaySecs = isIdle ? focusSecs : secsLeft;
  const phaseLabel = isIdle ? 'READY' : (phase === 'focus' ? 'FOCUS' : 'BREAK');
  const timeColor = isIdle ? 'var(--text-faint)' : 'var(--text-muted)';

  return (
    <button
      type="button"
      onClick={() => toggleTimer()}
      aria-label={running ? 'Pause timer' : 'Start timer'}
      title={`${phaseLabel} · ${fmt(displaySecs)}`}
      style={{
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '10px 4px',
        background: 'transparent', border: 'none',
        cursor: 'pointer',
        color: 'var(--text)',
        overflow: 'hidden',
      }}
    >
      <div style={{
        flex: 1, minHeight: 120,
        width: 40,
        borderRadius: 6,
        background: 'var(--surface-2, rgba(255,255,255,0.04))',
        padding: '8px 4px',
        display: 'flex', flexDirection: 'row-reverse',
        alignItems: 'stretch', justifyContent: 'center',
        gap: 4,
        overflow: 'hidden',
      }}>
        <span style={{
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          maxHeight: '100%',
          fontFamily: 'var(--font-mono)',
          fontSize: 12, fontWeight: 600,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          lineHeight: 1.15,
          color: phaseColor,
          transition: 'color 240ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}>{phaseLabel}</span>
        <span style={{
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          maxHeight: '100%',
          fontFamily: 'var(--font-mono)',
          fontSize: 10, fontWeight: 500,
          letterSpacing: '0.14em', textTransform: 'uppercase',
          lineHeight: 1.15,
          color: timeColor,
          transition: 'color 240ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}>{fmt(displaySecs)}</span>
      </div>
    </button>
  );
}

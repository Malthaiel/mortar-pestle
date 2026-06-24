// Adaptive tick ruler (SF6) — plain DOM ticks, virtualized to the padded
// render window (winA..winB: the same 384 px-quantized window LaneArea uses)
// and memoized, so per-scroll-frame renders bail entirely; ticks re-render
// only on window boundary crossings and zoom changes. Major step picked so
// labels sit ≥64 px apart; minor ticks at step/5 appear once ≥9 px apart.

import { memo } from 'react';

const STEPS = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800];
const mono = { fontFamily: '"DM Mono", monospace' };

function fmt(t) {
  const s = Math.round(t);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
}

export default memo(function TimeRuler({ pps, winA, winB, contentW }) {
  const step = STEPS.find(s => s * pps >= 64) || 3600;
  const minor = step / 5;
  const showMinor = minor * pps >= 9;
  const x0 = Math.max(0, winA);
  const x1 = Math.min(contentW, winB);
  const first = Math.max(0, Math.floor(x0 / (step * pps)));
  const last = Math.ceil(x1 / (step * pps));

  const ticks = [];
  for (let i = first; i <= last; i++) {
    const t = i * step;
    const x = t * pps;
    ticks.push(
      <div key={`M${t}`} style={{ position: 'absolute', left: x, bottom: 0, width: 1, height: 10, background: 'var(--border)' }} />,
      <div key={`L${t}`} style={{ ...mono, position: 'absolute', left: x + 4, top: 2, fontSize: 10, color: 'var(--text-faint)', userSelect: 'none' }}>
        {fmt(t)}
      </div>,
    );
    if (showMinor) {
      for (let m = 1; m < 5; m++) {
        const mt = t + m * minor;
        ticks.push(
          <div key={`m${mt}`} style={{ position: 'absolute', left: mt * pps, bottom: 0, width: 1, height: 5, background: 'var(--border)' }} />,
        );
      }
    }
  }
  return <>{ticks}</>;
});

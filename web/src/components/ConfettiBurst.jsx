// ConfettiBurst — full-viewport celebration layer, mounted once in App beside
// BreakOverlay. Listens for the `app:confetti` window event (the Planner day
// pane dispatches it when today's LAST open task is checked off) and throws a
// one-shot radial burst of candy-colored particles from just below viewport
// center, self-removing ~1.4s later. JS-driven flair: it bails up front when
// the task-celebration Animations toggle is off (read straight from
// focus_settings like useTactileSound — no settings context this far up), and
// each particle carries its keyframe INLINE so the
// body[data-anim-task-celebration="off"] kill rule also stops an in-flight
// burst (base opacity 0 keeps gated particles invisible, not frozen).

import { useEffect, useState } from 'react';

const CANDY = ['#d9a05b', '#7fb069', '#6ea8d8', '#c77fb0', '#e0c068'];
const LIFE_MS = 1450;

function celebrationEnabled() {
  try {
    const raw = JSON.parse(localStorage.getItem('focus_settings') || '{}');
    return (raw.animations || {})['task-celebration'] !== false;
  } catch {
    return true;
  }
}

let seq = 0;

function makeParticles(accent) {
  const palette = [accent || CANDY[0], ...CANDY];
  return Array.from({ length: 24 }, (_, i) => {
    const theta = Math.PI * Math.random(); // upper arc — the burst reads upward
    const dist = 130 + Math.random() * 250;
    return {
      id: i,
      color: palette[i % palette.length],
      w: 5 + Math.round(Math.random() * 4),
      h: 8 + Math.round(Math.random() * 5),
      x: Math.round(Math.cos(theta) * dist),
      y: -Math.round(Math.sin(theta) * dist * 0.9),
      spin: Math.round((Math.random() - 0.5) * 1080),
      dur: 950 + Math.round(Math.random() * 350),
      delay: Math.round(Math.random() * 70),
    };
  });
}

export default function ConfettiBurst({ accent }) {
  const [bursts, setBursts] = useState([]);

  useEffect(() => {
    const onConfetti = () => {
      if (!celebrationEnabled()) return;
      const id = ++seq;
      setBursts(bs => [...bs, { id, particles: makeParticles(accent) }]);
      setTimeout(() => setBursts(bs => bs.filter(b => b.id !== id)), LIFE_MS);
    };
    window.addEventListener('app:confetti', onConfetti);
    return () => window.removeEventListener('app:confetti', onConfetti);
  }, [accent]);

  if (!bursts.length) return null;
  return (
    <div aria-hidden style={{
      position: 'fixed', inset: 0, zIndex: 1290,
      pointerEvents: 'none', overflow: 'hidden',
    }}>
      {bursts.map(b => (
        <div key={b.id} style={{ position: 'absolute', left: '50%', top: '58%' }}>
          {b.particles.map(p => (
            <i key={p.id} style={{
              position: 'absolute', left: 0, top: 0, opacity: 0,
              width: p.w, height: p.h, background: p.color, borderRadius: 2,
              '--cf-x': `${p.x}px`, '--cf-y': `${p.y}px`, '--cf-spin': `${p.spin}deg`,
              animation: `confettiBurstFly ${p.dur}ms cubic-bezier(0.16, 1, 0.3, 1) ${p.delay}ms both`,
            }}/>
          ))}
        </div>
      ))}
    </div>
  );
}

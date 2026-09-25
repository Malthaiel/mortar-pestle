// Liquid Split Hover — Dev-tab test rig. THROWAWAY.
//
// Delete this file, its mount in DevTab.jsx and the .candy-split.is-liquid rules
// in styles.css once a style is chosen or dropped.
// Plan: Knowledge/Mortar & Pestle/Plans/Liquid Split Hover.md
//
// Hovering from one part of a .candy-split to the next moves the accent across
// like liquid instead of switching it off in one part and on in the other.
//
// How (Emil Kowalski's clip-path tabs): each liquid row is TWO copies of the same
// run. The real one underneath takes the pointer and never lights (.is-liquid).
// The copy on top is lit end to end — every part wears the real hover rule
// through [data-dock-hover], so no colour is restated here — and is cut to a
// window whose two edges ride springs. The window IS the liquid: face, frame,
// lip and white label flow together because they all live in the copy.
// Stretch/Plain follow the Material "elastic" tab indicator (the edge that grows
// the window leads, the one that shrinks it trails); Pinch adds the gooey
// metaball neck, drawn straight into the clip since the parts already touch.
import { useEffect, useRef } from 'react';
import { eyebrowStyle } from '../ui/Eyebrow.jsx';

const PARTS = ['Day', '3-Day', 'Week', 'Month'];
const ROWS = [['stretch', 'Stretch'], ['pinch', 'Pinch'], ['plain', 'Plain slide'], ['today', "Today's hover"]];

// Every knob in one object so the dev bridge can tune it live, no HMR reset:
//   (await import('/src/components/settings/LiquidSplitTestPanel.jsx')).TUNE.time = 0.15
export const TUNE = {
  time: 1,                       // 1 = real time; lower it to film the motion
  front: { k: 900, zeta: 0.9 },  // the edge that grows the window
  back: { k: 260, zeta: 0.55 },  // the edge that shrinks it: soft, overshoots into a squash
  plain: { k: 420, zeta: 1 },    // Plain slide, both edges
  fill: { k: 300, zeta: 0.8 },   // first-entry fill: the blob's radius, from the pointer's entry point
  bulge: 0.012,                  // px of edge bulge per px/s of edge speed
  pinch: 0.25,                   // px of waist per px of stretch past the target width
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f = (n) => n.toFixed(2);

// One spring step (semi-implicit Euler). Settles EXACTLY on the target in
// pixels, or a decelerating tail creeps for seconds and never reads as rest.
function step(x, v, t, key, dt) {
  const { k, zeta } = TUNE[key];
  v += (k * (t - x) - 2 * zeta * Math.sqrt(k) * v) * dt;
  x += v * dt;
  return Math.abs(t - x) < 0.05 && Math.abs(v) < 1 ? [t, 0] : [x, v];
}

// copy = the moving window (outer clip); fill = the lit run inside it, which
// carries the entry/exit blob as a second clip. Nested clips intersect, so the
// blob never lights past the window.
function useLiquid(mode, runRef, copyRef, fillRef) {
  useEffect(() => {
    const run = runRef.current, copy = copyRef.current, fill = fillRef.current;
    copy.inert = true;
    copy.style.clipPath = 'inset(50%)';   // an HMR remount must not keep the last frame's window
    fill.style.clipPath = 'none';
    // i = hovered part (kept while shrinking out; -1 = unlit); kL/kR = which TUNE spring each edge rides.
    // fx/fy/rad = the blob's centre and radius while `filling` (growing in, or
    // shrinking out when `out`); radT its goal. bL/bR = each edge's bulge this frame.
    const s = {
      L: 0, R: 0, vL: 0, vR: 0, bL: 0, bR: 0, i: -1, lit: false, kL: 'plain', kR: 'plain', raf: 0, last: 0,
      fx: 0, fy: 0, rad: 0, vrad: 0, radT: 0, filling: false, out: false,
    };
    const depth = () => parseFloat(getComputedStyle(run.children[0]).getPropertyValue('--cbtn-depth')) || 0;
    // The blob radius that just covers the span l..r (lip included) from its centre.
    const cover = (l, r) => Math.hypot(Math.max(s.fx - l, r - s.fx), Math.max(s.fy + 1, copy.offsetHeight + depth() + 1 - s.fy));

    // Everything in copy-local px, read off the live rects every time. A part's
    // painted edges snap to whole device pixels; a window left on the fraction
    // lit one extra half-red column each side (photographed 2026-09-25), so the
    // targets snap the same way. Only the resting edges -- in flight they glide.
    const left = () => copy.getBoundingClientRect().left;
    const snap = (x) => Math.round(x * devicePixelRatio) / devicePixelRatio;
    const rectOf = (i) => {
      const r = run.children[i].getBoundingClientRect(), o = left();
      return { l: snap(r.left) - o, r: snap(r.right) - o };
    };
    const target = () => rectOf(s.i);

    const retarget = () => {
      if (mode === 'plain') { s.kL = s.kR = 'plain'; return; }
      const t = target();
      s.kL = t.l < s.L ? 'front' : 'back';
      s.kR = t.r > s.R ? 'front' : 'back';
    };

    const draw = (t) => {
      const h = copy.offsetHeight;
      const y0 = -1, y1 = h + depth() + 1, ym = (y0 + y1) / 2, xm = (s.L + s.R) / 2;
      // Outward speed bows each side out (a droplet front) or in (a dragged back).
      s.bL = mode === 'plain' ? 0 : clamp(-s.vL * TUNE.bulge, -h / 2, h / 2);
      s.bR = mode === 'plain' ? 0 : clamp(s.vR * TUNE.bulge, -h / 2, h / 2);
      const p = mode === 'pinch' ? Math.min(0.3 * h, Math.max(0, s.R - s.L - (t.r - t.l)) * TUNE.pinch) : 0;
      // Quadratic control points sit at twice the wanted peak.
      copy.style.clipPath = `path('M${f(s.L)} ${y0} Q${f(xm)} ${f(y0 + 2 * p)} ${f(s.R)} ${y0} `
        + `Q${f(s.R + 2 * s.bR)} ${f(ym)} ${f(s.R)} ${f(y1)} Q${f(xm)} ${f(y1 - 2 * p)} ${f(s.L)} ${f(y1)} `
        + `Q${f(s.L - 2 * s.bL)} ${f(ym)} ${f(s.L)} ${y0}Z')`;
    };

    const tick = (now) => {
      const dt = (Math.min(now - (s.last || now), 32) / 1000) * TUNE.time;
      s.last = now;
      const t = target();
      [s.L, s.vL] = step(s.L, s.vL, t.l, s.kL, dt);
      [s.R, s.vR] = step(s.R, s.vR, t.r, s.kR, dt);
      if (s.R < s.L) {   // two soft edges overshooting through each other collide instead
        const m = (s.L + s.R) / 2, v = (s.vL + s.vR) / 2;
        s.L = s.R = m; s.vL = s.vR = v;
      }
      const settled = s.L === t.l && s.R === t.r && !s.vL && !s.vR;
      if (s.filling) {
        // In: grow until the blob covers the hovered part's farthest corner, from
        // its fixed centre; moving on mid-fill re-aims it at the new part. Covered
        // = done, the clip comes off. Out: the same blob run backwards, shrinking
        // into where the pointer left. Gone = unlit THAT frame -- the old sideways
        // drain waited ~0.5s for its springs to settle after it was already
        // invisible, and a quick re-entry slid it open instead of filling.
        s.radT = s.out ? 0 : cover(t.l, t.r);
        [s.rad, s.vrad] = step(s.rad, s.vrad, s.radT, 'fill', dt);
        if (s.out && s.rad <= 0) {
          s.lit = s.filling = s.out = false;
          s.i = -1;
          copy.style.clipPath = 'inset(50%)';
          fill.style.clipPath = 'none';
          s.raf = 0;
          return;
        }
        if (!s.out && s.rad >= s.radT) s.filling = false;
        fill.style.clipPath = s.filling ? `circle(${f(Math.max(0, s.rad))}px at ${f(s.fx)}px ${f(s.fy)}px)` : 'none';
      }
      draw(t);
      s.raf = settled && !s.filling ? 0 : requestAnimationFrame(tick);
    };
    const kick = () => { if (!s.raf) { s.last = 0; s.raf = requestAnimationFrame(tick); } };

    const onMove = (e) => {
      const i = [...run.children].indexOf(e.target.closest('.candy-btn'));
      if (i < 0 || (i === s.i && !s.out)) return;
      if (!s.lit) {   // first entry: a blob fills the part from where the pointer came in; mid-shrink it just turns round
        const r = rectOf(i), o = copy.getBoundingClientRect();
        s.L = r.l; s.R = r.r; s.vL = s.vR = 0;
        s.fx = clamp(e.clientX - o.left, r.l, r.r);
        s.fy = clamp(e.clientY - o.top, 0, o.height);
        s.rad = s.vrad = 0;
        s.filling = s.lit = true;
        fill.style.clipPath = `circle(0px at ${f(s.fx)}px ${f(s.fy)}px)`;
      }
      s.out = false;
      s.i = i; retarget(); kick();
    };
    const onLeave = (e) => {   // the fill run backwards: shrink into where the pointer left
      if (!s.lit) return;
      if (!s.filling) {   // mid-fill it just turns round on its own centre
        const o = copy.getBoundingClientRect();
        s.fx = clamp(e.clientX - o.left, s.L, s.R);
        s.fy = clamp(e.clientY - o.top, 0, o.height);
        // Start exactly covering what is lit now, bulges included, so nothing pops.
        s.rad = cover(s.L - Math.max(0, s.bL), s.R + Math.max(0, s.bR));
        s.vrad = 0;
        s.filling = true;
      }
      s.out = true; kick();
    };

    // The global press hold (useGlobalCandyPressHold) marks the REAL part; the lit
    // copy's face has to sink with it or the white label floats above the press.
    const mo = new MutationObserver(() => {
      [...run.children].forEach((el, i) => fill.children[i].toggleAttribute('data-candy-pressed', el.hasAttribute('data-candy-pressed')));
    });
    mo.observe(run, { subtree: true, attributes: true, attributeFilter: ['data-candy-pressed'] });
    run.addEventListener('pointermove', onMove);
    run.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(s.raf);
      mo.disconnect();
      run.removeEventListener('pointermove', onMove);
      run.removeEventListener('pointerleave', onLeave);
    };
  }, [mode, runRef, copyRef, fillRef]);
}

const parts = (extra) => PARTS.map((label) => (
  <button key={label} type="button" className="candy-btn" data-shape="chip" {...extra}>
    <span className="candy-face">{label}</span>
  </button>
));

// display:flex, not block: a block wrapper puts the inline-flex run on a line box
// whose strut makes the wrapper taller than the run, and the absolute copy would
// then centre its parts a pixel off the real ones.
const WRAP = { position: 'relative', display: 'flex', justifySelf: 'start', '--cbtn-size': '27px' };

function LiquidRow({ mode }) {
  const runRef = useRef(null), copyRef = useRef(null), fillRef = useRef(null);
  useLiquid(mode, runRef, copyRef, fillRef);
  // The lit run sits in a flex box at the copy's origin, laid out exactly like
  // the real run inside WRAP, so the two stay pixel-identical.
  return (
    <div style={WRAP}>
      <div ref={runRef} className="candy-split is-liquid">{parts()}</div>
      <div ref={copyRef} aria-hidden style={{
        position: 'absolute', inset: 0, display: 'flex', pointerEvents: 'none', zIndex: 3, clipPath: 'inset(50%)',
      }}>
        <div ref={fillRef} className="candy-split">{parts({ tabIndex: -1, 'data-dock-hover': 'true' })}</div>
      </div>
    </div>
  );
}

export default function LiquidSplitTestPanel() {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ ...eyebrowStyle, margin: '0 0 10px' }}>Liquid split hover</div>
      <div style={{ display: 'grid', gridTemplateColumns: '110px auto', alignItems: 'center', rowGap: 16, justifyContent: 'start' }}>
        {ROWS.map(([mode, label]) => [
          <div key={`${mode}-label`} style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>{label}</div>,
          mode === 'today'
            ? <div key={mode} style={WRAP}><div className="candy-split">{parts()}</div></div>
            : <LiquidRow key={mode} mode={mode} />,
        ])}
      </div>
    </div>
  );
}

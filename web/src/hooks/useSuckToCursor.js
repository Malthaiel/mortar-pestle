/**
 * Suck-to-cursor close.
 *
 * `transform-origin` is the ONE point of an element that stays nailed to the
 * screen while it scales. Write the LIVE cursor position there every frame and
 * scale toward zero, and the element collapses into the pointer exactly — by
 * construction, not by tuning. Move the mouse mid-close and the origin moves
 * with it, so tracking a moving cursor is free: no path, no keyframes, no
 * correction terms. Same lesson FoldPaper already encodes (measure, never
 * predict); a baked @keyframes here could only ever aim at where the pointer
 * WAS on frame one.
 *
 * The macOS genie proper (shearing the body along a curve) needs a shader or a
 * chopped-up mesh — wrong tool, and nothing like this app's paper-fold
 * language. Rejected 2026-08-21.
 */
import { useEffect } from 'react';

export const SUCK_DUR = 440;
// How far AHEAD of its end-anchored slot the suck starts, so it bites into the
// fold earlier. A fraction of the duration, not a fixed number of ms, so the
// two stay in proportion if the duration is retuned. User-directed 2026-08-21.
export const SUCK_LEAD = 0.25;

// One live pointer for the whole app: a module-level listener, not one per
// fold. Capture phase so a surface that stops propagation cannot blind it.
const cursor = { x: 0, y: 0 };
if (typeof window !== 'undefined') {
  const read = (e) => { cursor.x = e.clientX; cursor.y = e.clientY; };
  // pointerdown as well as move: a right-click in a window the mouse has not
  // moved in yet would otherwise suck toward 0,0.
  window.addEventListener('pointermove', read, { passive: true, capture: true });
  window.addEventListener('pointerdown', read, { passive: true, capture: true });
}

/**
 * Pure per-frame maths, exported so it can be asserted without a DOM.
 * `rect` is the element's UNTRANSFORMED box, cached the frame the suck starts —
 * transform-origin resolves in that frame, so the corner must come from it.
 */
export function suckFrame(t, rect, cx, cy) {
  // Ease IN, not out. Things falling down a hole accelerate; an ease-out reads
  // as a polite shrink. ~cubic-bezier(.55,0,1,.45).
  const e = Math.pow(t, 2.4);
  // Anticipation: a 1.02 inhale over the first 8%, back to 1 before the drop.
  const puff = t < 0.08 ? 1 + 0.02 * Math.sin((t / 0.08) * Math.PI) : 1;
  const s = (1 - e) * puff;

  // Directional squash — narrow ACROSS the pull axis, long ALONG it, so it
  // reads as pulled through a straw rather than shrunk in place. The amount
  // rides on how far the cursor actually is: a menu opened AT the pointer has no
  // meaningful axis and the squash correctly vanishes; it appears once the
  // cursor has travelled, which is the tracking case.
  //
  // This is only SAFE because FoldPaper switches this transform off for the
  // length of each of its measurements. A rect is the axis-aligned bounding box
  // of the transformed element, so nothing downstream can recover the real
  // geometry from it once a rotated non-uniform scale is in play — dividing by
  // a measured scale was tried on 2026-08-21 and left the paper still reversing.
  // If a new consumer starts measuring through this, it strips the transform
  // too; it does not try to invert it.
  const dx = cx - (rect.left + rect.width / 2);
  const dy = cy - (rect.top + rect.height / 2);
  const pull = Math.min(1, Math.hypot(dx, dy) / 240);
  const across = 1 - 0.4 * t * pull;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;

  return {
    // Every transform shares the origin, so the rotate pair cannot move the
    // fixed point — it only chooses which axis the squash lands on.
    transform: `rotate(${deg}deg) scale(${s.toFixed(4)}, ${(s * across).toFixed(4)}) rotate(${-deg}deg)`,
    origin: `${(cx - rect.left).toFixed(2)}px ${(cy - rect.top).toFixed(2)}px`,
    // NO fade. It goes down the hole at full opacity and is gone when the
    // scale reaches the floor — user-directed 2026-08-21, a fade read as the
    // menu dissolving rather than being pulled in.
    done: s <= 0.02,
  };
}

/**
 * @param {{current: HTMLElement}} ref  the node to suck (measured untransformed)
 * @param {{active: boolean, startAt?: number, duration?: number}} o
 *   `active` — the close is playing. `startAt` — ms to wait first, so the suck
 *   can overlap the TAIL of a fold instead of replacing it.
 */
export default function useSuckToCursor(ref, { active, startAt = 0, duration = SUCK_DUR }) {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return undefined;
    let raf = 0;
    let t0 = 0;
    let rect = null;

    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / duration);
      const f = suckFrame(t, rect, cursor.x, cursor.y);
      el.style.transformOrigin = f.origin;
      el.style.transform = f.transform;
      if (t < 1 && !f.done) raf = requestAnimationFrame(tick);
    };

    const timer = setTimeout(() => {
      // Measured BEFORE our first transform lands.
      rect = el.getBoundingClientRect();
      el.style.willChange = 'transform';
      t0 = performance.now();
      raf = requestAnimationFrame(tick);
    }, startAt);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      // React never wrote these four, so it will never clear them for us.
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.style.willChange = '';
    };
  }, [active, startAt, duration]);
}

// The one runnable check: the maths, both directions, all four quadrants.
if (import.meta.env?.DEV) {
  const box = { left: 100, top: 100, width: 200, height: 80 };
  const ok = (c, m) => { if (!c) throw new Error(`useSuckToCursor self-check: ${m}`); };
  for (const [cx, cy] of [[0, 0], [500, 0], [500, 500], [0, 500], [200, 140]]) {
    let prev = Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const f = suckFrame(t, box, cx, cy);
      // The origin IS the cursor, every frame — that is the whole mechanism.
      ok(f.origin === `${(cx - box.left).toFixed(2)}px ${(cy - box.top).toFixed(2)}px`, 'origin drifted off the cursor');
      const s = parseFloat(f.transform.match(/scale\(([-\d.]+)/)[1]);
      ok(s <= prev + 0.021, 'scale grew beyond the anticipation puff');
      ok(s >= -1e-9 && s <= 1.021, `scale out of range: ${s}`);
      prev = s;
    }
    ok(suckFrame(1, box, cx, cy).done, 'never reached done at t=1');
    ok(!('opacity' in suckFrame(0.9, box, cx, cy)), 'a fade came back');
  }
}

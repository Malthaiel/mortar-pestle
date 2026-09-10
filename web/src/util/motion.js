// The app's ONE glide. Every dragged thing and every wheel-scrolled thing
// arrives on this curve, at this duration — user-directed 2026-08-13, after the
// resize seam's trail was tuned by hand and he asked for it everywhere:
// "i want every singular drag in the app to be the same default... that
// includes scrolling".
//
// Why a module and not a CSS variable alone: scrolling is not a CSS transition.
// A wheel glide is JS setting `scrollTop` frame by frame, so it needs the curve
// as NUMBERS, while a dragged pane needs it as a transition STRING. Restating
// the same four control points in both places is the "restated constant" bug
// with a delay on it, so both are derived here from one array, and the CSS
// custom property is WRITTEN from these numbers at import rather than typed
// into styles.css to match.
//
// Tuning history: 120ms `ease` measured as a trail but read as a snap — the
// arrival was over in a twelfth of a second. 260ms on a hard ease-out spends
// most of its time near the end, which is the part the eye actually watches.

// Control points of the CSS cubic-bezier. The source of everything below.
export const GLIDE_BEZIER = [0.22, 1, 0.36, 1];
export const GLIDE_MS = 260;

export const GLIDE_TIMING = `cubic-bezier(${GLIDE_BEZIER.join(', ')})`;
// Property-less, so a caller applies it to whatever it animates — `width`,
// `flex-basis`, `transform`. Usage: `transition: width ${GLIDE}`.
export const GLIDE = `${GLIDE_MS}ms ${GLIDE_TIMING}`;

/**
 * The same curve, evaluated. Returns eased progress 0..1 for linear time 0..1.
 *
 * A CSS cubic-bezier is a parametric curve, not y = f(x): both x (time) and y
 * (progress) are driven by an unknown parameter t, so the x that matches a
 * given elapsed fraction has to be SOLVED for before y can be read. Newton
 * converges in a handful of steps on a curve this smooth; the bisection
 * fallback is there because Newton stalls where the derivative is ~0, which
 * this curve's flat tail is full of.
 */
export function glideEase(x) {
  return bezierEase(GLIDE_BEZIER, x);
}

/**
 * The same solver, for ANY four control points — so a surface animating in JS
 * against a curve it READ off the stylesheet (getComputedStyle's
 * `transitionTimingFunction`) can evaluate that curve instead of restating it.
 * The planner tube's liquid does exactly that: it chases the pointer on the
 * calendar's own transition, whatever that transition currently is.
 */
export function bezierEase([x1, y1, x2, y2], x) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const cx = (t) => ((1 - t) ** 3 * 0 + 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3);
  const cy = (t) => ((1 - t) ** 3 * 0 + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3);
  const dx = (t) => (3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2));

  let t = x;
  for (let i = 0; i < 6; i++) {
    const err = cx(t) - x;
    if (Math.abs(err) < 1e-5) return cy(t);
    const d = dx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0, hi = 1;
  t = x;
  for (let i = 0; i < 24; i++) {
    const v = cx(t);
    if (Math.abs(v - x) < 1e-5) break;
    if (v > x) hi = t; else lo = t;
    t = (lo + hi) / 2;
  }
  return cy(t);
}

// Published to CSS so a stylesheet rule can use the same glide as the JS
// (`transition: transform var(--glide)`), still from this one definition.
if (typeof document !== 'undefined') {
  const r = document.documentElement.style;
  r.setProperty('--glide', GLIDE);
  r.setProperty('--glide-ms', `${GLIDE_MS}ms`);
  r.setProperty('--glide-timing', GLIDE_TIMING);
}

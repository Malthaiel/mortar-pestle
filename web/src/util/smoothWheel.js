// Global smooth mouse-wheel scrolling.
//
// The app shell is overflow:hidden — all real scrolling happens in inner
// containers (main content, sidebars, modals). A single delegated, non-passive
// wheel listener eases the nearest scrollable ancestor of the event target
// toward a target offset via requestAnimationFrame.
//
// Axis-aware (added 2026-05-30): the listener resolves the innermost scrollable
// ancestor and its axis. Vertical containers ease scrollTop as before. A
// horizontal-only container (a rail: overflow-x scrolls, overflow-y doesn't —
// e.g. the Anime homepage poster rows / season-tab strips) maps the vertical
// wheel delta onto scrollLeft, so hovering a rail and turning the wheel glides
// it sideways. At a rail's horizontal edge the resolver walks past it to a
// scrollable vertical ancestor, so the page keeps scrolling (edge fall-through).
//
// Scope (decided 2026-05-29): mouse wheels (discrete notches / line-mode) get
// smoothed; trackpads and precise devices stay native — they are already smooth
// and re-smoothing them feels laggy (so a trackpad swipe over a rail is left to
// the browser; horizontal-tilt wheels with no vertical delta stay native too).
// CodeMirror (.cm-scroller) and xterm (.xterm-viewport) own their
// scroll/selection, so we never intercept inside them. prefers-reduced-motion
// disables smoothing entirely.
//
// Smoothness is user-adjustable (Settings → Animations → Scrolling). The level
// maps to a per-frame approach factor (lower = floatier / longer glide); 'off'
// disables easing so the wheel scrolls natively. useSettings.js calls
// setSmoothness() live whenever settings.scrollSmoothness changes.
//
// Separately, a JS-driven scrollbar "glow": each scrollable element gets a
// --sb-glow custom property (0 grey … 1 accent) that styles.css feeds into a
// grey→accent color-mix on its ::-webkit-scrollbar-thumb. We ease --sb-glow per
// frame — quick fade-in, slow fade-out — toward 1 while the element is scrolling
// (any wheel / glide / trackpad scroll; holds SCROLL_HOLD ms after the last) OR
// while the cursor is over its scrollbar gutter, else toward 0. This replaces a
// CSS :hover/.is-scrolling color swap because WebKitGTK does NOT animate
// `transition` on scrollbar pseudo-elements (the color snaps) — but it DOES
// repaint the thumb when a custom property it reads changes, so the fade is
// driven frame-by-frame in JS. Independent of the smoothness level;
// prefers-reduced-motion snaps without easing.

// Smoothness levels → { enabled, lerp }. lerp is the per-frame approach factor
// toward the target; 'off' bypasses easing entirely (native wheel scroll).
const SMOOTHNESS_PRESETS = {
  off:    { enabled: false, lerp: 1    },
  light:  { enabled: true,  lerp: 0.30 },
  medium: { enabled: true,  lerp: 0.18 },
  heavy:  { enabled: true,  lerp: 0.10 },
};
// Live config; mirrors 'medium' until useSettings applies the stored level.
const config = { enabled: true, lerp: 0.18 };

// Apply a smoothness level (off | light | medium | heavy). Unknown → medium.
export function setSmoothness(level) {
  const p = SMOOTHNESS_PRESETS[level] || SMOOTHNESS_PRESETS.medium;
  config.enabled = p.enabled;
  config.lerp = p.lerp;
}

const SETTLE = 0.5;       // px threshold to snap-and-stop the rAF loop
const WHEEL_MIN = 48;     // |deltaY| below this in pixel-mode ⇒ treat as trackpad
const EXCLUDE = '.cm-scroller, .cm-editor, .xterm, .xterm-viewport, .xterm-screen';
const SCROLL_HOLD = 420;  // ms the glow stays lit after the last scroll, then fades
const GLOW_IN = 0.28;     // per-frame approach when brightening (~120ms fade-in)
const GLOW_OUT = 0.28;    // per-frame approach when dimming (~115ms fade-out)
const GLOW_DONE = 0.005;  // |target − cur| below this snaps and stops the loop

// Per-element wheel-easing state; WeakMap so detached nodes are GC'd.
const state = new WeakMap(); // el -> { axis, target, raf }
// Per-element scrollbar-glow state (see the glow subsystem below).
const glow = new WeakMap();  // el -> { cur, scrolling, hovering, raf, idle }

function reduceMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function canScrollY(el) {
  if (!(el instanceof Element)) return false;
  if (el.scrollHeight <= el.clientHeight) return false;
  const oy = getComputedStyle(el).overflowY;
  return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
}

function canScrollX(el) {
  if (!(el instanceof Element)) return false;
  if (el.scrollWidth <= el.clientWidth) return false;
  const ox = getComputedStyle(el).overflowX;
  return ox === 'auto' || ox === 'scroll' || ox === 'overlay';
}

// Resolve the innermost scrollable ancestor that can consume a wheel of the
// given pixel `delta` (signed; the wheel's deltaY), plus which axis to drive.
// A horizontal-only container (scrolls X, not Y — a rail) maps the vertical
// wheel onto scrollLeft; anything that scrolls Y eases scrollTop as before.
// An element already at the pushing edge for its axis is skipped, so we walk to
// the parent — that's the edge fall-through (rail → page) and the old vertical
// edge-chaining, unified. Falls back to the document's vertical scroller.
function resolveScroll(node, delta) {
  let el = node instanceof Element ? node : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (canScrollX(el) && !canScrollY(el)) {
      const max = el.scrollWidth - el.clientWidth;
      if (!((el.scrollLeft <= 0 && delta < 0) ||
            (el.scrollLeft >= max - SETTLE && delta > 0)))
        return { el, axis: 'x', max };
    } else if (canScrollY(el)) {
      const max = el.scrollHeight - el.clientHeight;
      if (!((el.scrollTop <= 0 && delta < 0) ||
            (el.scrollTop >= max - SETTLE && delta > 0)))
        return { el, axis: 'y', max };
    }
    el = el.parentElement;
  }
  const root = document.scrollingElement;
  return canScrollY(root)
    ? { el: root, axis: 'y', max: root.scrollHeight - root.clientHeight }
    : null;
}

function animate(el) {
  const s = state.get(el);
  if (!s) return;
  const prop = s.axis === 'x' ? 'scrollLeft' : 'scrollTop';
  const cur = el[prop];
  if (Math.abs(s.target - cur) < SETTLE) {
    el[prop] = s.target;
    s.raf = 0;
    return;
  }
  el[prop] = cur + (s.target - cur) * config.lerp;
  s.raf = requestAnimationFrame(() => animate(el));
}

function onWheel(e) {
  if (!config.enabled) return;           // smoothness 'off' — leave native
  if (e.ctrlKey) return;                 // zoom gesture — leave native
  if (e.deltaY === 0) return;            // no vertical signal to map — native
  if (reduceMotion()) return;

  // Trackpad / precise scroll: pixel-mode with small deltas. Leave native.
  if (e.deltaMode === 0 && Math.abs(e.deltaY) < WHEEL_MIN) return;

  const tgt = e.target instanceof Element ? e.target : null;
  if (tgt && tgt.closest(EXCLUDE)) return;

  // Resolve the innermost scrollable + axis that can consume this wheel. The
  // resolver skips elements at their pushing edge, so a rail falls through to
  // the page once it bottoms out horizontally (and vertical edge-chaining is
  // preserved). A rail (scrolls X, not Y) drives scrollLeft from deltaY.
  const found = resolveScroll(tgt, Math.sign(e.deltaY));
  if (!found || (found.el.closest && found.el.closest(EXCLUDE))) return;
  const { el, axis, max } = found;

  // Normalize line/page delta modes to pixels (page-mode uses the resolved
  // element's extent along its scroll axis).
  const client = axis === 'x' ? el.clientWidth : el.clientHeight;
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? client : 1;
  const delta = e.deltaY * unit;

  e.preventDefault();
  let s = state.get(el);
  const midGlide = !!(s && s.raf && s.axis === axis);
  const cur = axis === 'x' ? el.scrollLeft : el.scrollTop;
  const base = midGlide ? s.target : cur;
  const target = Math.max(0, Math.min(max, base + delta));
  if (!s) { s = { axis, target, raf: 0 }; state.set(el, s); }
  else { s.axis = axis; s.target = target; }
  if (!s.raf) s.raf = requestAnimationFrame(() => animate(el));
}

// ── Scrollbar glow ──────────────────────────────────────────────────────────
// Drives --sb-glow (0 grey … 1 accent) on each scrollable element; styles.css
// mixes the thumb color from it. Target is 1 while the element is scrolling or
// its gutter is hovered, else 0; we ease toward it each frame — fast in, slow
// out — so the bar reddens promptly and lingers, then drifts back to grey.

function glowState(el) {
  let g = glow.get(el);
  if (!g) { g = { cur: 0, scrolling: false, hovering: false, raf: 0, idle: 0 }; glow.set(el, g); }
  return g;
}

function tickGlow(el) {
  const g = glow.get(el);
  if (!g) return;
  const target = (g.scrolling || g.hovering) ? 1 : 0;
  const k = reduceMotion() ? 1 : (target > g.cur ? GLOW_IN : GLOW_OUT);
  g.cur += (target - g.cur) * k;
  const done = Math.abs(target - g.cur) < GLOW_DONE;
  if (done) g.cur = target;
  if (g.cur <= 0.0005) el.style.removeProperty('--sb-glow');
  else el.style.setProperty('--sb-glow', g.cur.toFixed(3));
  g.raf = done ? 0 : requestAnimationFrame(() => tickGlow(el));
}

function kickGlow(el) {
  const g = glow.get(el);
  if (g && !g.raf) g.raf = requestAnimationFrame(() => tickGlow(el));
}

// Any scroll on any element lights its glow and (re)arms the fade-out timer.
// Fires for eased glides (which set scrollTop/Left each frame), native, and
// trackpad alike, so the glow is independent of the smoothness level.
function onScroll(e) {
  const el = e.target;
  if (!(el instanceof Element)) return;
  const g = glowState(el);
  g.scrolling = true;
  if (g.idle) clearTimeout(g.idle);
  g.idle = setTimeout(() => { g.scrolling = false; g.idle = 0; kickGlow(el); }, SCROLL_HOLD);
  kickGlow(el);
}

// Is the pointer over el's scrollbar gutter? The app uses classic (non-overlay)
// 6px bars, so the gutter is the strip just past the content box: the right
// edge for the vertical bar, the bottom edge for the horizontal one
// (clientWidth/Height exclude the bar; clientLeft/Top are the borders).
function inGutter(el, x, y) {
  const r = el.getBoundingClientRect();
  if (canScrollY(el)) {
    const gx = r.left + el.clientLeft + el.clientWidth;
    if (x >= gx && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  if (canScrollX(el)) {
    const gy = r.top + el.clientTop + el.clientHeight;
    if (y >= gy && y <= r.bottom && x >= r.left && x <= r.right) return true;
  }
  return false;
}

// Gutter-hover tracking, rAF-coalesced so getBoundingClientRect runs at most
// once per frame. Only one element is "gutter-hovered" at a time.
let hovered = null;        // el whose gutter the cursor is over (or null)
let pendingMove = null;    // last mousemove awaiting its frame
let moveScheduled = false;

function applyHover(el) {
  if (el === hovered) return;
  if (hovered) { const g = glow.get(hovered); if (g) { g.hovering = false; kickGlow(hovered); } }
  hovered = el;
  if (hovered) { glowState(hovered).hovering = true; kickGlow(hovered); }
}

function processMove() {
  moveScheduled = false;
  const e = pendingMove;
  pendingMove = null;
  if (!e) return;
  let el = e.target instanceof Element ? e.target : null;
  let found = null;
  while (el && el !== document.body && el !== document.documentElement) {
    if ((canScrollX(el) || canScrollY(el)) && inGutter(el, e.clientX, e.clientY)) { found = el; break; }
    el = el.parentElement;
  }
  applyHover(found);
}

function onMove(e) {
  pendingMove = e;
  if (moveScheduled) return;
  moveScheduled = true;
  requestAnimationFrame(processMove);
}

function onLeaveWindow() {
  applyHover(null);
}

let installed = false;

export function initSmoothWheel() {
  if (installed) return;
  installed = true;
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
  // Scrollbar glow: scroll activity (any element, capture phase) + gutter hover.
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('mousemove', onMove, { passive: true });
  document.documentElement.addEventListener('mouseleave', onLeaveWindow);
}

// Liquid hover — every candy button and candy split in the app lights like liquid
// instead of switching on in one frame. Plan: Knowledge/Mortar & Pestle/Plans/Liquid Candy Hover.md
//
// Coming in, a circle grows from the exact point the pointer entered until the
// part is covered, lip included. Inside a .candy-split the lit window slides from
// part to part, both edges on ONE spring so they leave, bounce and land together.
// Leaving runs the fill backwards: a circle centred on the exit point shrinks to
// nothing. Signed off on the Dev-tab rig 2026-09-25 (Stretch row, k260 zeta 0.5).
//
// How (Emil Kowalski's clip-path tabs, made app-wide): one set of document
// listeners, installed from main.jsx like tooltips.js, so every webview gets it
// and no button is edited. On hover the host (the button, or its whole split) is
// cloned twice into one layer appended to the host's own parent, so every scoped
// rule still matches: a REST copy, and a LIT copy whose parts wear the real hover
// rule through [data-dock-hover] (no colour restated here). The lit copy is cut to
// the moving window. The real host goes see-through ([data-liquid-host] in
// styles.css) but keeps taking the pointer. When the shrink reaches zero the layer
// is thrown away. Only hovered hosts ever have a layer.
//
// Skipped (today's instant hover): the switch in Settings > Appearance >
// Animations, the SKIP list, hosts holding media a copy cannot show, and any part
// whose own hover does not flood the accent (measured, so every neutral hover
// shape opts out with no list to keep).
//
// Typing rows: a copy has no caret, but the caret only exists in the FOCUSED box,
// and focus already lights that box. So a box is copied like any button until you
// type in it; then that one part stays real ([data-liquid-live]) and both copies
// leave a hole for it.

// Every knob in one object; the dev bridge can tune it live:
//   (await import('/src/util/liquidHover.js')).TUNE.time = 0.15
// (after any HMR edit, reload first — the bare import returns the page-load instance).
export const TUNE = {
  time: 1,                        // 1 = real time; lower it to film the motion
  stretch: { k: 260, zeta: 0.5 }, // both window edges: one spring, ~16% overshoot
  fill: { k: 300, zeta: 0.8 },    // the entry/exit circle's radius
  bulge: 0.012,                   // px of edge bulge per px/s of edge speed
};

// Later phases of the plan, each with its own snag: rail tiles (card owns the
// flood, nested controls hover neutral), the dock (sticky hover, widening
// buttons), menus (rows light through .is-active, shared with the arrow keys).
const SKIP = '.rail-tile, .dock-root, [role="menu"], [data-liquid-skip], [data-dragging]';
// A copy cannot show a canvas, a video or a frame (rail tiles, a later phase).
const LIVE = 'canvas, video, iframe';
const TYPING = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const f = (n) => n.toFixed(2);
const snap = (x) => Math.round(x * devicePixelRatio) / devicePixelRatio;
const off = () => document.body.dataset.animLiquidHover === 'off';

// One spring step (semi-implicit Euler). Settles EXACTLY on the target in
// pixels, or a decelerating tail creeps for seconds and never reads as rest.
function step(x, v, t, key, dt) {
  const { k, zeta } = TUNE[key];
  v += (k * (t - x) - 2 * zeta * Math.sqrt(k) * v) * dt;
  x += v * dt;
  return Math.abs(t - x) < 0.05 && Math.abs(v) < 1 ? [t, 0] : [x, v];
}

// Does this element's own hover flood the accent right now?
function floods(el) {
  const cs = getComputedStyle(el), a = cs.getPropertyValue('--accent').trim();
  return !!a && cs.getPropertyValue('--cbtn-band').trim() === a;
}

const layers = new Map();   // host -> state
let hot = null;             // host under the pointer
let raf = 0, last = 0;

const hostOf = (btn) => (btn.parentElement?.classList.contains('candy-split') ? btn.parentElement : btn);
const partsOf = (root, split) => (split ? [...root.children].filter((el) => el.classList.contains('candy-btn')) : [root]);
const pathOf = (root, node) => { const p = []; for (; node !== root; node = node.parentElement) p.unshift([...node.parentElement.children].indexOf(node)); return p; };
const at = (root, path) => path.reduce((el, i) => el?.children[i], root);

function copy(s, lit) {
  const c = s.host.cloneNode(true);
  c.removeAttribute('data-liquid-host');
  for (const el of [c, ...c.querySelectorAll('[id], [title], [data-tip]')]) {
    el.removeAttribute('id'); el.removeAttribute('title'); el.removeAttribute('data-tip');
  }
  if (lit) for (const p of partsOf(c, s.split)) p.dataset.dockHover = 'true';
  return c;
}

// The clones and the layer take the host's own used size; the layer is moved
// until the REST COPY's rect sits exactly on the host's. Measured every frame, never kept.
// transition none: a copied inline glide (SearchRun's `transition: width`) would
// ease every pinned width in and leave the copy chasing the host.
function pin(s) {
  const { width, height } = getComputedStyle(s.host);
  for (const c of [s.rest, s.lit]) Object.assign(c.style, { width, height, margin: '0', flex: 'none', transition: 'none' });
  Object.assign(s.layer.style, { width, height });
}
function place(s) {
  const hr = s.host.getBoundingClientRect();
  if (hr.width !== s.w || hr.height !== s.h) { s.w = hr.width; s.h = hr.height; pin(s); }
  // The copy, not the layer: a copy carries the host's own offset (candyCenterOffset's
  // inline top: -2.5px) and the host's rect already includes it, so lining up the
  // layer counted it twice (the titlebar brand chip rose 2.5px while lit).
  // (ox, oy) is where the copies sit inside the layer, so the clips follow them.
  const cr = s.rest.getBoundingClientRect(), lr = s.layer.getBoundingClientRect();
  s.ox = cr.left - lr.left; s.oy = cr.top - lr.top;
  const dx = hr.left - cr.left, dy = hr.top - cr.top;
  if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
    s.x += dx; s.y += dy;
    s.layer.style.left = `${s.x}px`; s.layer.style.top = `${s.y}px`;
  }
  return hr;
}

// Host-local px. A part's painted edges snap to whole device pixels; a window
// left on the fraction lit an extra half-red column (photographed 2026-09-25).
function rectOf(s, i, hr) {
  const r = s.parts[i].getBoundingClientRect();
  return { l: snap(r.left) - hr.left, r: snap(r.right) - hr.left };
}
// The lip's paint below the box, off the RESOLVED box-shadow (y + blur + spread):
// --cbtn-depth itself can read back as an unresolved "calc(7px * 0.85)" (tree
// rows), which parsed to 0 and cut the lit lip off at the box edge.
const depth = (s) => Math.max(0, ...[...getComputedStyle(s.parts[0]).boxShadow
  .matchAll(/-?[\d.]+px (-?[\d.]+)px (-?[\d.]+)px(?: (-?[\d.]+)px)?/g)].map((m) => +m[1] + +m[2] + (+m[3] || 0)));
const circle = (s, r) => `circle(${f(Math.max(0, r))}px at ${f(s.fx + s.ox)}px ${f(s.fy + s.oy)}px)`;
// The circle radius that just covers the span l..r (lip included) from its centre.
const cover = (s, l, r, hr) => Math.hypot(Math.max(s.fx - l, r - s.fx), Math.max(s.fy + 1, hr.height + depth(s) + 1 - s.fy));

function clip(s, key, el, v) { if (s[key] !== v) { s[key] = v; el.style.clipPath = v; } }

function draw(s, hr) {
  // Host-local, shifted onto the clip box by where the copies sit in it.
  const h = hr.height, L = s.L + s.ox, R = s.R + s.ox;
  const y0 = s.oy - 1, y1 = s.oy + h + depth(s) + 1, ym = (y0 + y1) / 2;
  // Outward speed bows each side out (a droplet front) or in (a dragged back).
  s.bL = clamp(-s.vL * TUNE.bulge, -h / 2, h / 2);
  s.bR = clamp(s.vR * TUNE.bulge, -h / 2, h / 2);
  // Quadratic control points sit at twice the wanted peak.
  clip(s, 'cw', s.win, `path('M${f(L)} ${f(y0)} L${f(R)} ${f(y0)} Q${f(R + 2 * s.bR)} ${f(ym)} ${f(R)} ${f(y1)} `
    + `L${f(L)} ${f(y1)} Q${f(L - 2 * s.bL)} ${f(ym)} ${f(L)} ${f(y0)}Z')`);
}

function build(host, btn) {
  const parent = host.parentElement;
  if (!parent) return null;
  const split = host !== btn;
  const s = {
    host, split, parts: partsOf(host, split), x: 0, y: 0, ox: 0, oy: 0, w: -1, h: -1,
    L: 0, R: 0, vL: 0, vR: 0, bL: 0, bR: 0, i: -1, on: false, live: -1,
    fx: 0, fy: 0, rad: 0, vrad: 0, filling: false, out: false, checked: -1,
  };
  s.layer = document.createElement('div');
  s.layer.dataset.liquidLayer = '';
  s.layer.setAttribute('aria-hidden', 'true');
  s.layer.inert = true;
  // display:flex, not block: a block box puts an inline-flex run on a line box
  // whose strut makes it taller, and the copies would centre a pixel off.
  Object.assign(s.layer.style, {
    position: 'absolute', left: '0px', top: '0px', display: 'flex', pointerEvents: 'none',
    zIndex: getComputedStyle(host).zIndex, isolation: 'isolate',
  });
  s.win = document.createElement('div');   // the moving window (outer clip)
  s.fill = document.createElement('div');  // the entry/exit circle (inner clip); nested clips intersect
  // z-index 3: a split part raised for seam ownership (z 1-2) in the rest copy
  // must not paint over the window.
  Object.assign(s.win.style, { position: 'absolute', inset: '0', display: 'flex', zIndex: '3' });
  s.fill.style.display = 'flex';
  s.rest = copy(s, false);
  s.lit = copy(s, true);
  s.fill.append(s.lit);
  s.win.append(s.fill);
  s.layer.append(s.rest, s.win);
  clip(s, 'cw', s.win, 'inset(50%)');
  pin(s);

  // Appending must not move anything (a parent's :last-child rule would): measure.
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const sibs = [...parent.children], before = sibs.map(box);
  parent.append(s.layer);
  if (sibs.some((el, k) => box(el).some((v, j) => Math.abs(v - before[k][j]) > 0.01))) {
    s.layer.remove();
    host.dataset.liquidSkip = '';
    if (import.meta.env.DEV) console.warn('[liquidHover] appending the layer moved its neighbours; host skipped', host);
    return null;
  }
  // A lone button already lit at rest has nothing to fill; its own hover runs.
  if (!split && floods(s.rest)) { s.layer.remove(); return null; }
  place(s);
  host.setAttribute('data-liquid-host', '');

  // The real host keeps changing under the copies: the global press hold marks a
  // part, a click swaps a label. Attributes are copied node for node, so a press
  // TRANSITION runs on the copies too (a fresh copy would teleport the face);
  // anything structural rebuilds both copies inside the same clip wrappers.
  s.mo = new MutationObserver((recs) => {
    let rebuild = false, repin = false;
    for (const m of recs) {
      if (m.type !== 'attributes') { rebuild = true; continue; }
      const n = m.attributeName;
      if (n === 'id' || n === 'title' || n === 'data-tip' || (m.target === host && n === 'data-liquid-host')) continue;
      const path = pathOf(host, m.target), v = m.target.getAttribute(n);
      for (const c of [s.rest, s.lit]) {
        const el = at(c, path);
        if (!el) { rebuild = true; continue; }
        if (v == null) el.removeAttribute(n); else el.setAttribute(n, v);
      }
      if (m.target === host && n === 'style') repin = true;   // the copied inline style undid the pin
    }
    if (rebuild) {
      const rest = copy(s, false), lit = copy(s, true);
      s.rest.replaceWith(rest); s.lit.replaceWith(lit);
      s.rest = rest; s.lit = lit; repin = true;
    }
    if (repin) pin(s);   // now, not next frame: in between, the unpinned copy's glide would start
  });
  s.mo.observe(host, { subtree: true, attributes: true, childList: true, characterData: true });
  layers.set(host, s);
  return s;
}

// The part holding the focused typing box stays real (it has the caret and is lit
// by its own focus rule). Setting the mark on the real part lets the mirror carry
// it onto both copies, which hide that part (styles.css). Read every frame.
// The copies' boxes must still read what the real ones hold once typing stops
// (Esc, Enter, a click away with the pointer still on the row): text and scroll
// are read off the real boxes every frame.
function typing(s) {
  const a = document.activeElement;
  const live = a?.matches(TYPING) ? s.parts.findIndex((p) => p.contains(a)) : -1;
  if (live !== s.live) {
    s.parts[s.live]?.removeAttribute('data-liquid-live');
    s.parts[live]?.setAttribute('data-liquid-live', '');
    s.live = live;
  }
  for (const el of s.host.querySelectorAll('input:not([type="file"]), textarea')) {
    const path = pathOf(s.host, el);
    for (const c of [s.rest, s.lit]) {
      const t = at(c, path);
      if (!t) continue;
      if (t.value !== el.value) t.value = el.value;
      if (t.scrollLeft !== el.scrollLeft) t.scrollLeft = el.scrollLeft;
      if (t.scrollTop !== el.scrollTop) t.scrollTop = el.scrollTop;
    }
  }
}

function drop(s) {
  s.mo.disconnect();
  s.layer.remove();
  s.parts[s.live]?.removeAttribute('data-liquid-live');
  s.host.removeAttribute('data-liquid-host');
  layers.delete(s.host);
  if (hot === s.host) hot = null;
}

// DEV regression gate: once settled, the lit copy's part must paint exactly like
// the real part, which is still :hover under opacity 0 and so computes the true
// hover paint. A mismatch means a :hover rule is missing [data-dock-hover].
function parity(s) {
  s.checked = s.i;
  const real = s.parts[s.i], twin = partsOf(s.lit, s.split)[s.i];
  if (!real?.matches(':hover') || !twin || s.i === s.live) return;   // a typed-in part is real, its copy hidden
  const face = (el) => el.querySelector(':scope > .candy-face') || el;
  const a = getComputedStyle(face(real)), b = getComputedStyle(face(twin));
  const bad = ['backgroundColor', 'color', 'borderTopColor'].filter((p) => a[p] !== b[p]);
  if (getComputedStyle(real).boxShadow !== getComputedStyle(twin).boxShadow) bad.push('boxShadow');
  // A typing box paints its own text colour (chip-field's white-on-hover rule).
  const box = (el) => el.querySelector('input, textarea');
  if (box(real) && box(twin) && getComputedStyle(box(real)).color !== getComputedStyle(box(twin)).color) bad.push('typing text');
  if (!bad.length) return;
  (window.__liquidParity ||= []).push({ el: real, bad });
  console.warn('[liquidHover] lit copy paints differently from the real hover:', bad.join(', '), real);
}

function advance(s, dt) {
  if (!s.host.isConnected || s.host.closest('[data-dragging]') || off()) return drop(s);
  typing(s);
  const hr = place(s), t = rectOf(s, s.i, hr);
  [s.L, s.vL] = step(s.L, s.vL, t.l, 'stretch', dt);
  [s.R, s.vR] = step(s.R, s.vR, t.r, 'stretch', dt);
  if (s.R < s.L) {   // two edges overshooting through each other collide instead
    const m = (s.L + s.R) / 2, v = (s.vL + s.vR) / 2;
    s.L = s.R = m; s.vL = s.vR = v;
  }
  if (s.filling) {
    // In: grow until the circle covers the part's farthest corner from its fixed
    // centre; moving on mid-fill re-aims it at the new part. Out: the same circle
    // run backwards. Gone = unlit THAT frame (reset on invisible, not on settle),
    // so a quick re-entry fills again instead of sliding open.
    const goal = s.out ? 0 : cover(s, t.l, t.r, hr);
    [s.rad, s.vrad] = step(s.rad, s.vrad, goal, 'fill', dt);
    if (s.out && s.rad <= 0) return drop(s);
    if (!s.out && s.rad >= goal) s.filling = false;
    clip(s, 'cf', s.fill, s.filling ? circle(s, s.rad) : 'none');
  }
  draw(s, hr);
  if (import.meta.env.DEV && !s.filling && !s.out && s.checked !== s.i && s.L === t.l && s.R === t.r) parity(s);
}

// One loop for every live layer. It keeps running while any layer exists, so a
// hovered button that scrolls or shifts after a click is followed every frame.
function tick(now) {
  const dt = (Math.min(now - (last || now), 32) / 1000) * TUNE.time;
  last = now;
  for (const s of [...layers.values()]) advance(s, dt);
  raf = layers.size ? requestAnimationFrame(tick) : 0;
  if (!raf) last = 0;
}
const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

function enter(s, btn, e) {
  const i = s.parts.indexOf(btn);
  if (i < 0 || (i === s.i && !s.out)) return;
  if (!s.on) {   // first entry: the circle fills the part from where the pointer came in
    const hr = place(s), r = rectOf(s, i, hr);
    s.L = r.l; s.R = r.r; s.vL = s.vR = 0;
    s.fx = clamp(e.clientX - hr.left, r.l, r.r);
    s.fy = clamp(e.clientY - hr.top, 0, hr.height);
    s.rad = s.vrad = 0;
    s.filling = s.on = true;
    clip(s, 'cf', s.fill, circle(s, 0));
  }
  s.out = false;   // mid-shrink it just turns round on its own centre
  s.i = i;
  kick();
}

function leave(host, e) {   // the fill run backwards: shrink into where the pointer left
  const s = layers.get(host);
  if (!s?.on) return;
  if (!s.filling) {
    const hr = s.host.getBoundingClientRect();
    s.fx = clamp(e.clientX - hr.left, s.L, s.R);
    s.fy = clamp(e.clientY - hr.top, 0, hr.height);
    // Start exactly covering what is lit now, bulges included, so nothing pops.
    s.rad = cover(s, s.L - Math.max(0, s.bL), s.R + Math.max(0, s.bR), hr);
    s.vrad = 0;
    s.filling = true;
  }
  s.out = true;
  kick();
}

function onOver(e) {
  if (e.pointerType === 'touch') return;
  const btn = e.target.closest?.('.candy-btn');
  const host = btn && hostOf(btn);
  if (hot && hot !== host) { leave(hot, e); hot = null; }
  if (!host) return;
  let s = layers.get(host);
  if (!s) {
    if (off() || host.closest(SKIP) || host.querySelector(LIVE) || !floods(btn)) return;
    s = build(host, btn);
    if (!s) return;
  }
  hot = host;
  enter(s, btn, e);
}
function onOut(e) {   // the pointer left the window altogether
  if (!e.relatedTarget && hot) { leave(hot, e); hot = null; }
}

let installed = false;
export function installLiquidHover() {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
}

// Liquid hover — every candy button and candy split in the app lights like liquid
// instead of switching on in one frame. Plan: Knowledge/Mortar & Pestle/Plans/Liquid Candy Hover.md
//
// Coming in, a circle grows from the exact point the pointer entered until the
// part is covered, lip included. Inside a .candy-split the lit window slides from
// part to part and swings past by the same few px on every slide, both edges
// together, whatever the parts' widths (a plain spring swings a fixed FRACTION of
// its travel, so a wide part -> a tiny one flew ~40px past).
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
// Menus and dropdowns: each row drains and fills on its own, driven by the
// menu's own cursor, so the arrow keys light rows too (from their middle).
//
// The dock: its buttons are lone buttons that widen as they light (the copies
// follow the measured width), and the dock holds the last one lit and open across
// the gap ([data-dock-hover], sticky). The colour holds with it: a held button
// drains only when the dock lets go of it (the next button lights, or the pointer
// leaves the dock). The copies own [data-dock-hover]: never on the rest copy,
// always on the lit one.
//
// Typing rows: a copy has no caret, but the caret only exists in the FOCUSED box,
// and focus already lights that box. So a box is copied like any button until you
// type in it; then that one part stays real ([data-liquid-live]) and both copies
// leave a hole for it.
//
// Rail tiles (music player, clock, day sections, overlay panels): only the colour
// pours. The copies are EMPTY tiles slid in UNDER the real one, which keeps
// everything it shows live (cover, clock, its own buttons and their own liquid)
// and gives up only its own paint (styles.css). A tile is lit by its own hover,
// measured: a music or clock tile stays lit over its grey-hovering buttons, and a
// panel tile hands its red to the button you point at, so it drains toward that
// spot while the button fills from it.

// Every knob in one object; the dev bridge can tune it live:
//   (await import('/src/util/liquidHover.js')).TUNE.time = 0.15
// (after any HMR edit, reload first — the bare import returns the page-load instance).
export const TUNE = {
  time: 1,                        // 1 = real time; lower it to film the motion
  stretch: { k: 260, zeta: 0.5 }, // the slide: one spring, ~15% overshoot of `reach` (zeta 1 = lands with no swing; A/B rig in Settings > Dev)
  reach: 40,                      // px: every slide swings like one this long (~6px past)
  fill: { k: 300, zeta: 0.8 },    // the entry/exit circle's radius
  bulge: 0.012,                   // px of edge bulge per px/s of edge speed
};

const SKIP = '[data-liquid-skip], [data-dragging]';
// Right-click menus and dropdowns (one component): see watchMenu below.
const MENU = '[role="menu"]';
// Rail tiles: see syncTiles below.
const TILE = '.rail-tile';
// A copy cannot show a canvas, a video or a frame (a tile's empty copies never try).
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
  const c = s.host.cloneNode(!s.shell);
  if (s.shell) c.append(s.face.cloneNode(false));   // a tile's copy is its empty face: paint only
  c.removeAttribute('data-liquid-host');
  for (const el of [c, ...c.querySelectorAll('[id], [title], [data-tip]')]) {
    el.removeAttribute('id'); el.removeAttribute('title'); el.removeAttribute('data-tip');
  }
  // The copies own the lit marker: the dock's sticky hold on the real button must
  // never reach the rest copy.
  for (const p of partsOf(c, s.split)) { if (lit) p.dataset.dockHover = 'true'; else delete p.dataset.dockHover; }
  if (!lit && s.menu) c.classList.remove('is-active');   // a menu row's .is-active IS its hover
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
// A tile's real lip is switched off while its copies paint it: read the copy's.
const depth = (s) => Math.max(0, ...[...getComputedStyle(s.shell ? s.rest : s.parts[0]).boxShadow
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
  const shell = host.matches(TILE), face = shell && host.querySelector(':scope > .candy-face');
  if (!parent || (shell ? !face : host.querySelector(LIVE))) return null;
  const split = host !== btn;
  const s = {
    host, split, shell, face, menu: !!host.closest(MENU), parts: partsOf(host, split), x: 0, y: 0, ox: 0, oy: 0, w: -1, h: -1,
    L: 0, R: 0, vL: 0, vR: 0, bL: 0, bR: 0, i: -1, on: false, live: -1,
    p: 0, vp: 0, aL: 0, aR: 0, dir: 1, hit: true,
    fx: 0, fy: 0, rad: 0, vrad: 0, filling: false, out: false, checked: -1, twins: [],
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
  // A tile's copies go BEFORE it, so they paint under its live contents.
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const sibs = [...parent.children], before = sibs.map(box);
  if (shell) host.before(s.layer); else parent.append(s.layer);
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
      // The dock letting go of a button it held lit (the pointer is on the next
      // button, or off the dock) is that button's leave.
      if (n === 'data-dock-hover') { if (m.target === host && !host.hasAttribute(n) && host !== hot) leave(host, pt); continue; }
      if (n === 'id' || n === 'title' || n === 'data-tip' || (m.target === host && n === 'data-liquid-host')) continue;
      const path = s.shell && m.target !== host ? [0] : pathOf(host, m.target), v = m.target.getAttribute(n);
      for (const c of [s.rest, s.lit]) {
        const el = at(c, path);
        if (!el) { rebuild = true; continue; }
        if (v == null) el.removeAttribute(n); else el.setAttribute(n, v);
        if (s.menu && n === 'class' && c === s.rest) el.classList.remove('is-active');
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
  // A tile's contents stay real: only the tile and its face (press, flavour) are copied.
  if (shell) { s.mo.observe(host, { attributes: true }); s.mo.observe(face, { attributes: true }); }
  else s.mo.observe(host, { subtree: true, attributes: true, childList: true, characterData: true });
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

// Bits drawn ON a tile that turn white as it lights (the music wave bars and scrub
// track, the clock's water line) whiten exactly where the liquid has reached:
// while it moves, the real ones keep their rest colour ([data-liquid-dry]) and a
// lit copy of each ([data-liquid-wet]), cut to the circle, sits exactly on top.
// Copied afresh every frame (the bars and the line move); once the liquid stops,
// the copies go and the real ones take their own colour back.
// ponytail: a named list; a new bit that recolours on tile hover joins it, and its
// CSS rule lists the two markers (styles.css: the music rail/meter, .tube-water).
const WET = '.music-tile-meter, .music-tile-rail, .tube-water';
function wet(s, hr) {
  const had = s.twins.length;
  for (const t of s.twins) t.remove();
  s.twins = [];
  const moving = s.filling && !(s.out && s.rad <= 0);
  if (!moving && !had) return;
  // A line in a drawing is copied with its drawing: the drawing has a box to cut.
  const roots = new Set([...s.host.querySelectorAll(WET)].map((el) => (el instanceof SVGElement ? el.ownerSVGElement : el)));
  for (const o of roots) {
    if (!moving) { o.removeAttribute('data-liquid-dry'); continue; }
    const t = o.cloneNode(true);
    t.removeAttribute('data-liquid-dry');
    t.setAttribute('data-liquid-wet', '');
    t.setAttribute('aria-hidden', 'true');
    o.setAttribute('data-liquid-dry', '');
    // Out of the flow at the real one's used size, then moved onto it (measured).
    const { width, height } = getComputedStyle(o);
    Object.assign(t.style, { position: 'absolute', left: '0px', top: '0px', width, height, margin: '0', pointerEvents: 'none' });
    o.after(t);
    s.twins.push(t);
    const a = o.getBoundingClientRect(), b = t.getBoundingClientRect();
    t.style.left = `${a.left - b.left}px`; t.style.top = `${a.top - b.top}px`;
    t.style.clipPath = `circle(${f(Math.max(0, s.rad))}px at ${f(hr.left + s.fx - a.left)}px ${f(hr.top + s.fy - a.top)}px)`;
  }
}

function drop(s) {
  s.mo.disconnect();
  s.layer.remove();
  if (s.shell) {
    for (const t of s.twins) t.remove();
    for (const o of s.host.querySelectorAll('[data-liquid-dry]')) o.removeAttribute('data-liquid-dry');
  }
  s.parts[s.live]?.removeAttribute('data-liquid-live');
  s.host.removeAttribute('data-liquid-host');
  layers.delete(s.host);
  if (hot === s.host) hot = null;
}

// Drained: hand back to the real host only once it paints like the rest copy and
// has stopped moving. A dock button shrinks as it drains, its word still fading
// out; until it has stopped, the rest copy stands in for it.
// The part being typed in is real either way (lit by its own focus).
// A tile's own paint fading back in is on the tile and its face alone (its
// contents may animate forever: the music meter).
const still = (s) => s.parts.every((p, k) => k === s.live || floods(p) === floods(partsOf(s.rest, s.split)[k]))
  && !(s.shell ? [s.host, s.face].flatMap((el) => el.getAnimations()) : s.host.getAnimations({ subtree: true }))
    .some((a) => a instanceof CSSTransition);

// DEV regression gate: once settled, the lit copy's part must paint exactly like
// the real part, which is still :hover under opacity 0 and so computes the true
// hover paint. A mismatch means a :hover rule is missing [data-dock-hover].
function parity(s) {
  s.checked = s.i;
  const real = s.parts[s.i], twin = partsOf(s.lit, s.split)[s.i];
  // A typed-in part is real, its copy hidden; a tile's real paint is switched off.
  if (s.shell || !real?.matches(':hover') || !twin || s.i === s.live) return;
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
  if (!s.shell) typing(s);   // a tile's boxes are real already
  const hr = place(s), t = rectOf(s, s.i, hr);
  // ONE spring p runs every slide as if it were TUNE.reach px long (p: -reach -> 0),
  // so the swing past 0 is the same on every slide. Until p first arrives, each
  // edge covers its OWN travel on a bent copy of p, t + dir*(p + a*p^2) (a set in
  // enter): it starts where it was and arrives with p's own speed, so from then on
  // both edges ride p exactly and swing together, with no kink.
  [s.p, s.vp] = step(s.p, s.vp, 0, 'stretch', dt);
  if (s.p >= 0) s.hit = true;
  const bent = (a) => (s.hit ? s.p : s.p + a * s.p * s.p);
  s.L = t.l + s.dir * bent(s.aL); s.R = t.r + s.dir * bent(s.aR);
  s.vL = s.vR = s.dir * s.vp;   // the bulge reads the same fixed-size slide, not the real travel
  if (s.R < s.L) s.L = s.R = (s.L + s.R) / 2;   // a retarget folding the window through itself
  if (s.filling) {
    // In: grow until the circle covers the part's farthest corner from its fixed
    // centre; moving on mid-fill re-aims it at the new part. Out: the same circle
    // run backwards. Gone = unlit THAT frame (reset on invisible, not on settle),
    // so a quick re-entry fills again instead of sliding open.
    const goal = s.out ? 0 : cover(s, t.l, t.r, hr);
    if (s.out) s.fx = Math.min(s.fx, hr.width);   // a button shrinking under the drain keeps its centre inside
    [s.rad, s.vrad] = step(s.rad, s.vrad, goal, 'fill', dt);
    if (s.out && s.rad <= 0) {
      s.on = false;   // unlit: coming back fills afresh from the new entry point
      // A tile takes its own paint back first; it fades in over the identical
      // rest copy, which leaves once the fade is done.
      if (s.shell) s.host.removeAttribute('data-liquid-host');
      if (still(s)) return drop(s);
    }
    if (!s.out && s.rad >= goal) s.filling = false;
    clip(s, 'cf', s.fill, s.filling ? circle(s, s.rad) : 'none');
  }
  if (s.shell) wet(s, hr);
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
  const hr = place(s), r = rectOf(s, i, hr);
  if (!s.on) {   // first entry: the circle fills the part from where the pointer came in
    s.host.setAttribute('data-liquid-host', '');   // a tile back mid hand-back gives its paint up again
    s.L = r.l; s.R = r.r;
    s.fx = clamp(e.clientX - hr.left, r.l, r.r);
    s.fy = clamp(e.clientY - hr.top, 0, hr.height);
    s.rad = s.vrad = 0;
    s.filling = s.on = true;
    clip(s, 'cf', s.fill, circle(s, 0));
  } else if (i !== s.i) {   // a slide: p restarts a reach away; each edge's bend spans its real travel
    const n = TUNE.reach, dir = Math.sign(r.l + r.r - s.L - s.R) || 1;
    // bent(-n) must land on the edge's current spot: a = (n - travel) / n^2.
    // ponytail: an edge travelling under n/2 dips the wrong way first (~2px at 20px);
    // candy parts are wider than that today.
    s.aL = (n - dir * (r.l - s.L)) / (n * n);
    s.aR = (n - dir * (r.r - s.R)) / (n * n);
    s.vp = Math.max(0, (dir === s.dir ? 1 : -1) * s.vp);   // keep only speed already heading there
    s.dir = dir; s.p = -n; s.hit = false;
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

// Menus (right-click menus and dropdowns, one component). A row is lit by the
// menu's own cursor (.is-active: the mouse AND the arrow keys move it), so rows
// are not driven by the pointer: every panel is watched from the moment it
// mounts, and whenever a row's MEASURED lit state flips it fills or drains on
// its own like a lone button, at the pointer, or at its middle after a keypress.
const menus = new Map();   // panel -> { mo, seen: Map(row -> lit) }
let keyed = false, pt = { clientX: 0, clientY: 0 };
const rowsOf = (panel) => [...panel.querySelectorAll('.candy-btn[role^="menuitem"]')].filter((r) => !r.closest('[data-liquid-layer]'));
const middle = (el) => { const r = el.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };

function watchMenu(panel) {
  if (menus.has(panel)) return;
  const m = { seen: new Map(rowsOf(panel).map((r) => [r, floods(r)])) };
  m.mo = new MutationObserver(() => syncMenu(panel));
  m.mo.observe(panel, { subtree: true, attributes: true, attributeFilter: ['class'] });
  menus.set(panel, m);
}
function unwatchMenu(panel) { menus.get(panel)?.mo.disconnect(); menus.delete(panel); }

// A menu row or a tile whose measured lit state flipped: fill or drain it on its own.
function flip(r, lit, at) {
  let s = layers.get(r);
  if (!s) {
    if (off() || r.closest(SKIP) || !(s = build(r, r))) return;
    // Lit with no layer yet (a submenu opens with its first row lit): start full.
    if (!lit) { enter(s, r, at); s.filling = false; clip(s, 'cf', s.fill, 'none'); }
  }
  if (lit) enter(s, r, at); else leave(r, at);
}

function syncMenu(panel) {
  const m = menus.get(panel);
  if (!panel.isConnected) return unwatchMenu(panel);
  for (const r of rowsOf(panel)) {
    const lit = floods(r);
    if (!m.seen.has(r)) { m.seen.set(r, lit); continue; }   // a row that just appeared is as it paints
    if (lit === m.seen.get(r)) continue;
    m.seen.set(r, lit);
    flip(r, lit, keyed ? middle(r) : pt);
  }
}

// Rail tiles are lit by their own hover, re-read on every pointerover rather than
// followed: a music or clock tile stays lit over its own (grey-hovering) buttons,
// and a panel tile gives its red up to the button you point at (styles.css
// :has(.candy-btn:hover)), so it drains toward that spot as the button fills.
const tiles = new Map();   // tile -> lit, as last read
function syncTiles(under) {
  if (under && !tiles.has(under)) tiles.set(under, false);
  for (const [t, was] of tiles) {
    const lit = t.isConnected && floods(t);
    if (lit !== was) flip(t, lit, pt);
    if (lit || t === under) tiles.set(t, lit); else tiles.delete(t);
  }
}

function onOver(e) {
  if (e.pointerType === 'touch') return;
  keyed = false; pt = { clientX: e.clientX, clientY: e.clientY };
  const btn = e.target.closest?.('.candy-btn');
  const host = btn && !btn.closest(MENU) && !btn.matches(TILE) && hostOf(btn);
  // A button the dock still holds lit drains when the dock lets go (the mirror).
  if (hot && hot !== host) { if (!hot.hasAttribute('data-dock-hover')) leave(hot, e); hot = null; }
  for (const p of menus.keys()) syncMenu(p);   // :hover flips no class, so read it here
  syncTiles(e.target.closest?.(TILE));
  if (!host) return;
  let s = layers.get(host);
  if (!s) {
    if (off() || host.closest(SKIP) || !floods(btn)) return;
    s = build(host, btn);
    if (!s) return;
  }
  hot = host;
  enter(s, btn, e);
}
function onOut(e) {   // the pointer left the window altogether
  if (e.relatedTarget) return;
  if (hot) { leave(hot, e); hot = null; }
  for (const t of tiles.keys()) leave(t, e);
  tiles.clear();
}

let installed = false;
export function installLiquidHover() {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('keydown', () => { keyed = true; }, true);
  // Menu panels portal straight into <body>.
  // ponytail: a menu portalled into a fullscreen element is not seen and keeps the instant hover.
  new MutationObserver((recs) => {
    for (const rec of recs) {
      for (const n of rec.addedNodes) if (n.nodeType === 1 && n.matches(MENU)) watchMenu(n);
      for (const n of rec.removedNodes) if (menus.has(n)) unwatchMenu(n);
    }
  }).observe(document.body, { childList: true });
}

// App-wide scroll-position memory — every scroll box in the app remembers where
// it was left, with no per-surface wiring.
//
// Why delegated instead of a hook: there are 100+ scroll containers across 80+
// files (plus class-based ones in styles.css). A per-surface hook means an edit
// per container now and a ritual on every new page forever — the earlier
// `useScrollMemory(key)` shipped exactly that way and ended up with ZERO
// consumers. So this mirrors smoothWheel.js: one delegated document listener
// that resolves scroll boxes generically.
//
// Identity comes free from the aos-component-id Vite plugin, which stamps
// data-aos-component on every JSX element in dev AND prod. A box's key is:
//
//   <component>#<index>@<scope>      e.g.  LibraryNav#0@library
//
//   component — the element's own data-aos-component
//   index     — its position among elements sharing that component name, so a
//               component holding two scroll boxes keeps them apart
//   scope     — which *instance* of the surface this is:
//                 in a .candy-modal  → '' (a dialog's position is route-agnostic)
//                 in .page-tx        → the route path (opening note B must not
//                                      inherit note A's position)
//                 otherwise          → the active module id, so the four
//                                      TreeSidebar consumers (Library, Docs,
//                                      Broadcast, Deadlock) don't share one
//                                      position through the shared shell
//
// Positions live in localStorage, not memory: the overlay's Shift+C HIDE runs
// location.reload() on that webview (lib.rs hide_overlay_host, dev builds), which
// re-executes all JS. The overlay and the main window share one origin, which is
// what the scope half of the key guards against.

import { GLIDE_MS, glideEase } from './motion.js';

const PREFIX = 'scroll-pos:';
const MODULE_KEY = 'dock:active-module:v1';   // owned by hooks/useActiveModule.jsx
// CodeMirror and xterm own their own scrolling (same exclusions smoothWheel.js
// uses); the command palette must always open at the top or the first result is
// off-screen.
const SKIP = '.cm-scroller, .xterm-viewport, [data-aos-component="CommandPalette"]';

const ids = new WeakMap();      // el -> 'Component#index' (scope is resolved per call)
const touched = new WeakSet();  // boxes the user has scrolled this mount — never re-restore
const timers = new Map();       // key -> debounce timeout
const applied = new WeakMap();  // el -> the last position WE wrote (clamped, read back)
const chasing = new WeakMap();  // el -> the position we are still trying to reach
const glides = new WeakMap();   // el -> in-flight animation frame

function routeScope() {
  const h = typeof window === 'undefined' ? '' : (window.location.hash || '');
  return h.startsWith('#') ? h.slice(1) : h;
}

function moduleScope() {
  try { return localStorage.getItem(MODULE_KEY) || ''; } catch { return ''; }
}

function scopeOf(el) {
  if (el.closest('.candy-modal')) return '';
  if (el.closest('.page-tx')) return routeScope();
  return moduleScope();
}

// 'Component#index', cached — the querySelectorAll is the only expensive part and
// an element's identity never changes while it is mounted.
function idOf(el) {
  let id = ids.get(el);
  if (id !== undefined) return id;
  id = null;
  const comp = el.dataset?.aosComponent;
  if (comp && !el.closest(SKIP)) {
    const all = document.querySelectorAll(`[data-aos-component="${CSS.escape(comp)}"]`);
    const i = Array.prototype.indexOf.call(all, el);
    if (i >= 0) id = `${comp}#${i}`;
  }
  ids.set(el, id);
  return id;
}

function keyOf(el) {
  const id = idOf(el);
  return id == null ? null : `${id}@${scopeOf(el)}`;
}

function save(key, el) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    // Both axes — sideways rails (anime poster rows, season strips) scroll too.
    const v = `${Math.round(el.scrollTop)},${Math.round(el.scrollLeft)}`;
    try { localStorage.setItem(PREFIX + key, v); } catch { /* private mode / quota */ }
  }, 150));
}

// ── restoring ──────────────────────────────────────────────────────────────
// Arriving at a remembered position is a scroll, so it rides the app's ONE glide
// (util/motion.js) rather than teleporting — same curve and duration as every
// dragged thing and every wheel scroll.
function reduceMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function put(el, top, left) {
  el.scrollTop = top;
  el.scrollLeft = left;
  // Read BACK: the browser clamps to the content that exists right now, and the
  // clamped value is what the scroll event will carry.
  applied.set(el, { top: el.scrollTop, left: el.scrollLeft });
}

// How long we keep re-aiming at a saved position while content streams in.
// ponytail: a deadline instead of watching each box's size — the chase is only
// ever a few passes, and an abandoned one must not outlive the surface.
const CHASE_MS = 5000;

function glideTo(el, top, left) {
  cancelAnimationFrame(glides.get(el));
  const prior = chasing.get(el);
  chasing.set(el, { top, left, until: prior?.until ?? (performance.now() + CHASE_MS) });
  if (reduceMotion()) { put(el, top, left); return; }
  const from = { top: el.scrollTop, left: el.scrollLeft };
  const t0 = performance.now();
  const step = () => {
    if (!chasing.has(el)) { glides.delete(el); return; }   // the user took over
    const x = Math.min(1, (performance.now() - t0) / GLIDE_MS);
    const e = glideEase(x);
    put(el, from.top + (top - from.top) * e, from.left + (left - from.left) * e);
    if (x < 1) { glides.set(el, requestAnimationFrame(step)); return; }
    glides.delete(el);
    const c = chasing.get(el);
    if (!c) return;
    if (el.scrollTop >= c.top - 1) { chasing.delete(el); return; }
    // Landed short — the content was still filling in. Re-aim shortly. Content
    // can grow without a childList mutation (an image loading, a row measuring),
    // so the chase drives its own retry rather than waiting on the observer.
    if (performance.now() < c.until) setTimeout(() => { budget = PASS_BUDGET; schedule(); }, 120);
    else chasing.delete(el);
  };
  glides.set(el, requestAnimationFrame(step));
}

// Scroll events don't bubble, but the capture phase still runs down through
// document to the target — so one capture listener sees every box in the app.
function onScroll(e) {
  const el = e.target;
  if (!el || el.nodeType !== 1) return;   // document/window scroll, not a box
  const mine = applied.get(el);
  const ours = mine && Math.abs(el.scrollTop - mine.top) <= 2 && Math.abs(el.scrollLeft - mine.left) <= 2;
  if (ours) return;   // our own restore — and NEVER save it: a restore clamped
                      // short would otherwise overwrite the real saved position
                      // with the short one, which is how a memory quietly dies.
  touched.add(el);
  chasing.delete(el);
  cancelAnimationFrame(glides.get(el));
  glides.delete(el);
  const key = keyOf(el);
  if (key) save(key, el);
}

function entries() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out.push([k.slice(PREFIX.length), localStorage.getItem(k)]);
    }
  } catch { /* private mode */ }
  return out;
}

// Put every saved position back onto whichever boxes are currently mounted.
// Elements are found by the same identity that saved them, so nothing has to be
// registered or tracked between passes.
function restoreAll() {
  const route = routeScope();
  const mod = moduleScope();
  let moved = false;
  for (const [key, raw] of entries()) {
    const m = /^(.+)#(\d+)@(.*)$/.exec(key);
    if (!m) continue;
    const [, comp, idx, scope] = m;
    // A box can hold several saved positions (one per route / per module). Only
    // the one matching where we are now may be applied.
    if (scope !== '' && scope !== route && scope !== mod) continue;
    let el;
    try { el = document.querySelectorAll(`[data-aos-component="${CSS.escape(comp)}"]`)[+idx]; }
    catch { continue; }
    if (!el || touched.has(el)) continue;   // never fight the user
    const [top, left] = String(raw).split(',').map(Number);
    let chase = chasing.get(el);
    if (chase && performance.now() > chase.until) { chasing.delete(el); chase = null; }
    // A box already positioned by something else (VaultTree's Reveal-current
    // button) is left alone — unless it is one WE are still chasing.
    if (!chase && (el.scrollTop || el.scrollLeft)) continue;
    // Keep chasing until the saved position is actually reached. A lazily
    // filled tree (the vault tree, deepest and slowest in the app) is still
    // short when the first pass runs, so the browser clamps that restore
    // hundreds of pixels above where the user left it. One shot lands short;
    // this re-aims as the rows arrive.
    if (chase && el.scrollTop >= top - 1) continue;
    if ((top > 0 && el.scrollHeight > el.clientHeight) || (left > 0 && el.scrollWidth > el.clientWidth)) {
      glideTo(el, top, left);
      moved = true;
    }
  }
  return moved;
}

// Content arrives late (fetches, lazy chunks, cascade-revealing trees), so one
// pass at mount isn't enough — we re-run on DOM changes.
// ponytail: budget-capped instead of tracking which keys are still outstanding.
// A busy surface (streaming terminal, agent chat) mutates forever, and an
// uncapped observer would re-scan on every batch for the life of the session.
// The budget refills whenever we arrive somewhere new — a route change, or a
// dialog opening (dialogs mount with no route change of their own).
const PASS_BUDGET = 30;
let budget = PASS_BUDGET;
let pending = null;

function schedule() {
  if (budget <= 0 || pending) return;
  pending = setTimeout(() => {
    pending = null;
    budget--;
    // A pass that actually moved something is progress, not spin — refill, so a
    // slow tree filling in over several seconds keeps being chased.
    if (restoreAll()) budget = PASS_BUDGET;
  }, 120);
}

function refill() {
  budget = PASS_BUDGET;
  schedule();
}

export function installScrollMemory() {
  if (typeof window === 'undefined') return;
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('hashchange', refill);
  new MutationObserver((records) => {
    let added = false;
    for (const r of records) {
      if (!r.addedNodes.length) continue;
      added = true;
      for (const n of r.addedNodes) {
        // A dialog opening is arriving somewhere new, even though the route didn't change.
        if (n.nodeType === 1 && (n.matches?.('.candy-modal') || n.querySelector?.('.candy-modal'))) {
          refill();
          return;
        }
      }
    }
    if (added) schedule();
  }).observe(document.body, { childList: true, subtree: true });
  refill();
}

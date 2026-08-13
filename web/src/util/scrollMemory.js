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
//                                      Broadcast, GameWiki) don't share one
//                                      position through the shared shell
//
// Positions live in localStorage, not memory: the overlay's Shift+C HIDE runs
// location.reload() on that webview (lib.rs hide_overlay_host, dev builds), which
// re-executes all JS. The overlay and the main window share one origin, which is
// what the scope half of the key guards against.

const PREFIX = 'scroll-pos:';
const MODULE_KEY = 'dock:active-module:v1';   // owned by hooks/useActiveModule.jsx
// CodeMirror and xterm own their own scrolling (same exclusions smoothWheel.js
// uses); the command palette must always open at the top or the first result is
// off-screen.
const SKIP = '.cm-scroller, .xterm-viewport, [data-aos-component="CommandPalette"]';

const ids = new WeakMap();      // el -> 'Component#index' (scope is resolved per call)
const touched = new WeakSet();  // boxes the user has scrolled this mount — never re-restore
const timers = new Map();       // key -> debounce timeout

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

// Scroll events don't bubble, but the capture phase still runs down through
// document to the target — so one capture listener sees every box in the app.
function onScroll(e) {
  const el = e.target;
  if (!el || el.nodeType !== 1) return;   // document/window scroll, not a box
  touched.add(el);
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
    // Never fight the user, and never fight an explicit scroll like VaultTree's
    // Reveal-current button: only an untouched box still sitting at 0 is restored.
    if (!el || touched.has(el) || el.scrollTop || el.scrollLeft) continue;
    const [top, left] = String(raw).split(',').map(Number);
    if (top > 0 && el.scrollHeight > el.clientHeight) el.scrollTop = top;
    if (left > 0 && el.scrollWidth > el.clientWidth) el.scrollLeft = left;
  }
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
  pending = setTimeout(() => { pending = null; budget--; restoreAll(); }, 120);
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

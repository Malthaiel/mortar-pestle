// Self-check for util/scrollMemory.js + util/pageMemory.js — the two memory
// defaults. Runs the REAL modules against a stub DOM, no browser, no deps.
//
//   node web/scripts/scrollmem-check.mjs
//
// Bundles both modules with the repo's own esbuild first, so it exercises the
// shipped code rather than a copy of it.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollmem-'));
const entry = path.join(tmp, 'entry.js');
const bundle = path.join(tmp, 'bundle.mjs');
fs.writeFileSync(entry, [
  `export { installScrollMemory } from ${JSON.stringify(path.join(WEB, 'src/util/scrollMemory.js'))};`,
  `export { recordRoute, lastRoute, lastRouteFor, moduleKeyFor } from ${JSON.stringify(path.join(WEB, 'src/util/pageMemory.js'))};`,
].join('\n'));
await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: bundle, logLevel: 'silent' });
const BUNDLE = 'file://' + bundle.split(path.sep).join('/');

// ── stub DOM ────────────────────────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.CSS = { escape: (s) => s };

const registry = [];  // DOM order
class El {
  constructor(comp, { parent = null, cls = '', scrollHeight = 1000, clientHeight = 200 } = {}) {
    this.dataset = comp ? { aosComponent: comp } : {};
    this.parent = parent;
    this.cls = cls;
    this.nodeType = 1;
    this._top = 0;
    this.scrollLeft = 0;
    this.scrollHeight = scrollHeight; this.clientHeight = clientHeight;
    this.scrollWidth = 0; this.clientWidth = 0;
    registry.push(this);
  }
  // The browser CLAMPS scrollTop to the content that exists right now. This is
  // the whole point of check 8: a lazily-filled tree is short at restore time.
  get scrollTop() { return this._top; }
  set scrollTop(v) { this._top = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - this.clientHeight))); }
  // Real closest()/matches() take a selector LIST and understand attribute
  // selectors; the stub supports the two forms scrollMemory.js actually uses.
  matches(sel) {
    return sel.split(',').map(s => s.trim()).some((s) => {
      const attr = /^\[data-aos-component="(.+)"\]$/.exec(s);
      if (attr) return this.dataset.aosComponent === attr[1];
      return s === '.' + this.cls;
    });
  }
  closest(sel) {
    for (let n = this; n; n = n.parent) if (n.matches(sel)) return n;
    return null;
  }
  querySelector() { return null; }
}
globalThis.document = {
  body: {},
  // motion.js publishes the glide to CSS custom properties at import time.
  documentElement: { style: { setProperty() {} } },
  addEventListener: (type, fn) => { if (type === 'scroll') document._onScroll = fn; },
  querySelectorAll: (sel) => {
    const comp = /\[data-aos-component="(.+)"\]/.exec(sel)?.[1];
    return registry.filter(e => e.dataset.aosComponent === comp);
  },
};
globalThis.MutationObserver = class { observe() {} };
const winHandlers = {};
globalThis.window = {
  location: { hash: '#/tools/library' },
  addEventListener: (t, fn) => { winHandlers[t] = fn; },
};

globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const scroll = (el, top) => { el.scrollTop = top; document._onScroll({ target: el }); };
const setModule = (id) => localStorage.setItem('dock:active-module:v1', id);
const keys = () => [...store.keys()].filter(k => k.startsWith('scroll-pos:'));

// ── run ─────────────────────────────────────────────────────────────────────
const { installScrollMemory } = await import(BUNDLE);
const { recordRoute, lastRoute, lastRouteFor, moduleKeyFor } = await import(BUNDLE);

setModule('library');
installScrollMemory();

// 1. a sidebar box saves under its module scope
const sidebar = new El('LibraryNav');
scroll(sidebar, 420);
await sleep(200);
assert.deepStrictEqual(keys(), ['scroll-pos:LibraryNav#0@library'], 'sidebar key shape/scope');
assert.strictEqual(store.get('scroll-pos:LibraryNav#0@library'), '420,0');
console.log('1 OK  saves under module scope:', keys()[0]);

// 2. the SAME shared shell under a different module is a different position
registry.length = 0;
setModule('docs');
const docsTree = new El('LibraryNav');
scroll(docsTree, 90);
await sleep(200);
assert.ok(store.has('scroll-pos:LibraryNav#0@docs'), 'docs scope key written');
assert.strictEqual(store.get('scroll-pos:LibraryNav#0@library'), '420,0', 'library position untouched');
console.log('2 OK  same shell, two modules, two positions');

// 3. remount under library restores 420 — and NOT the docs 90
registry.length = 0;
setModule('library');
const remounted = new El('LibraryNav');
winHandlers.hashchange();          // refills the pass budget
await sleep(600);           // > GLIDE_MS — the restore is now an eased glide
assert.strictEqual(remounted.scrollTop, 420, 'restored the library position');
console.log('3 OK  restored on remount:', remounted.scrollTop);

// 4. a box the user has scrolled is never overwritten by a later pass
scroll(remounted, 12);
winHandlers.hashchange();
await sleep(600);
assert.strictEqual(remounted.scrollTop, 12, 'user scroll survives a restore pass');
console.log('4 OK  user scroll wins over restore');

// 5. page-body boxes are scoped per route, so note B never inherits note A
registry.length = 0;
const pageTx = new El(null, { cls: 'page-tx' });
window.location.hash = '#/page/A.md';
const bodyA = new El('PageView', { parent: pageTx });
scroll(bodyA, 777);
await sleep(200);
registry.length = 0;
window.location.hash = '#/page/B.md';
const pageTx2 = new El(null, { cls: 'page-tx' });
const bodyB = new El('PageView', { parent: pageTx2 });
winHandlers.hashchange();
await sleep(600);
assert.strictEqual(bodyB.scrollTop, 0, 'note B did not inherit note A');
assert.ok(store.has('scroll-pos:PageView#0@/page/A.md'), 'route-scoped key: ' + [...store.keys()].join(' '));
console.log('5 OK  page bodies scoped per route');

// 6. the command palette is excluded (must always open at the top)
registry.length = 0;
const palette = new El('CommandPalette', { cls: 'candy-modal' });
scroll(palette, 300);
await sleep(200);
assert.ok(!keys().some(k => k.includes('CommandPalette')), 'palette not remembered');
console.log('6 OK  command palette excluded');

// 7. pageMemory — longest routeBase wins, non-module paths fall back to segment
const bases = ['/tools', '/tools/library', '/vault'];
assert.strictEqual(moduleKeyFor('/tools/library/anime/x', bases), '/tools/library');
assert.strictEqual(moduleKeyFor('/tools/terminal/skills', bases), '/tools');
assert.strictEqual(moduleKeyFor('/docs/releases', bases), '/docs');
assert.strictEqual(moduleKeyFor('/vault', bases), '/vault');
recordRoute('/tools/library/anime/x', '/tools/library');
recordRoute('/vault/knowledge/Plans/Broadcast', '/vault');
assert.strictEqual(lastRouteFor('/tools/library'), '/tools/library/anime/x');
assert.strictEqual(lastRoute(), '/vault/knowledge/Plans/Broadcast');
console.log('7 OK  page memory: per-module + global');

// 8. THE VAULT CASE: a lazily-filled tree is short when the restore pass runs,
// so the browser clamps the restore. The position must keep being chased as the
// rows arrive, or the tree lands hundreds of pixels above where it was left.
registry.length = 0;
setModule('vault');
const deep = new El('VaultTree', { scrollHeight: 9000, clientHeight: 600 });
scroll(deep, 4200);
await sleep(200);
assert.strictEqual(store.get('scroll-pos:VaultTree#0@vault'), '4200,0');

registry.length = 0;
const lazy = new El('VaultTree', { scrollHeight: 900, clientHeight: 600 });  // rows still loading
winHandlers.hashchange();
await sleep(200);
const clampedTo = lazy.scrollTop;
lazy.scrollHeight = 9000;                                                    // rows arrive
await sleep(800);
assert.ok(clampedTo < 4200, 'the first restore really was clamped short (' + clampedTo + ')');
assert.strictEqual(lazy.scrollTop, 4200, `chased to the real position, got ${lazy.scrollTop}`);
assert.strictEqual(store.get('scroll-pos:VaultTree#0@vault'), '4200,0', 'the clamped value never overwrote the saved one');
console.log(`8 OK  lazy tree: clamped to ${clampedTo}, chased to ${lazy.scrollTop}`);

// 9. the glide is the app default curve, not a jump
registry.length = 0;
setModule('library');
const glideBox = new El('LibraryNav', { scrollHeight: 5000, clientHeight: 500 });
scroll(glideBox, 3000);
await sleep(200);
registry.length = 0;
const glideBox2 = new El('LibraryNav', { scrollHeight: 5000, clientHeight: 500 });
winHandlers.hashchange();
await sleep(200);   // 120ms restore debounce + ~80ms into the 260ms glide
const mid = glideBox2.scrollTop;
await sleep(600);
assert.ok(mid > 0 && mid < 3000, `mid-glide sample should be between 0 and 3000, got ${mid}`);
assert.strictEqual(glideBox2.scrollTop, 3000, 'glide finished on the saved position');
console.log(`9 OK  glided (sampled ${Math.round(mid)} mid-flight, landed ${glideBox2.scrollTop})`);

console.log('\nALL PASS');

fs.rmSync(tmp, { recursive: true, force: true });

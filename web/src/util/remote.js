// DEV remote — the RETURN half of the audit bridge (Planner Button Sizing, 2026-08-10).
//
// auditBridge.js carries measurements OUT of the window to web/.audit/<label>.json.
// This carries an instruction IN, so a surface can be OPENED and MEASURED without
// the user driving the mouse and describing the result in prose. That prose loop
// is what killed the Planner sizing chat: six edits, zero measurements, three
// rounds of eyeballing — because the modal under edit was never on screen when an
// audit ran, so every reading on disk was of a different page and looked clean.
//
// Protocol, deliberately dumb (server half: vite.config.js cmdSlot):
//   GET /__cmd -> { id, js }   id = the command file's mtime, js = its text
//   run it, then postAudit('cmd', …) — the result lands in the SAME file Claude
//   already reads, under `cmd`.
// An id runs exactly once. Rewriting web/.audit/cmd.txt is what makes a new one.
//
// PRIMING: a command file already on disk at startup is recorded WITHOUT running.
// Otherwise every window reload would re-fire the last command — a stray click on
// each HMR reload, from a file the user never touched this session.
//
// EVERY webview polls — main, overlay host, and the player controls layer. Each
// runs the command against its own DOM and reports to its own label file
// (main.json / overlay-host.json / player-controls.json), so a selector that only
// exists in one window simply errors in the others. That is information, not a
// bug — but a MUTATING command fires once per window, so scope it by checking
// `location.hash` inside the command when that matters.
//
// Limits worth knowing before trusting a reading: :hover and :focus-visible cannot
// be synthesised (see dragAudit.js), animations need an explicit `await sleep(ms)`
// before measuring, and this returns numbers — never whether something looks good.
//
// Never shipped to prod: imported only behind import.meta.env.DEV in main.jsx, and
// /__cmd exists only in Vite's serve mode.

import { postAudit } from './auditBridge.js';

const POLL_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const r1 = (n) => (typeof n === 'number' ? +n.toFixed(1) : n);

// A DOM node cannot cross JSON, and a bare "<button>" names nothing greppable.
// Collapse one to the two things a measurement is ever for: a locator (tag +
// classes + visible label) and its geometry.
function el2json(el) {
  const r = el.getBoundingClientRect();
  const cls = typeof el.className === 'string' && el.className.trim()
    ? '.' + el.className.trim().split(/\s+/).join('.')
    : '';
  const shape = el.getAttribute?.('data-shape');
  return {
    el: el.tagName.toLowerCase() + cls + (shape ? `[${shape}]` : ''),
    label: (el.getAttribute?.('aria-label') || el.title || el.textContent || '')
      .trim().replace(/\s+/g, ' ').slice(0, 40),
    x: r1(r.x), y: r1(r.y), w: r1(r.width), h: r1(r.height),
  };
}

// DOMRect's fields live on the prototype, so a plain key walk serialises it as {}.
const isRect = (v) => typeof DOMRect !== 'undefined' && v instanceof DOMRect;

function plain(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'function') return '[fn]';
  if (typeof v !== 'object') return typeof v === 'number' ? r1(v) : v;
  if (v instanceof Element) return el2json(v);
  if (isRect(v)) return { x: r1(v.x), y: r1(v.y), w: r1(v.width), h: r1(v.height), top: r1(v.top), bottom: r1(v.bottom) };
  if (depth > 5) return '[deep]';
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  if (typeof v[Symbol.iterator] === 'function') return [...v].map((x) => plain(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = plain(v[k], depth + 1);
  return out;
}

// The command body is an async function body. `sleep` is handed in because
// waiting for an animation to settle is the one helper every command needs and
// the platform has no equivalent; everything else is already on window.
function run(js) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('sleep', `return (async () => {\n${js}\n})();`);
  return fn(sleep);
}

let lastId = null;
let primed = false;
let busy = false;

async function tick() {
  if (busy) return;
  let msg;
  try { msg = await (await fetch('/__cmd', { cache: 'no-store' })).json(); } catch { return; }
  // First successful poll only records what is already there — a command file left
  // from a previous session must not fire on this window's load. No file yet
  // (id null) leaves lastId null, so the NEXT file written is a new id and runs.
  if (!primed) { primed = true; lastId = msg?.id ?? null; return; }
  if (!msg || msg.id == null || msg.id === lastId) return;
  lastId = msg.id;
  busy = true;
  const t0 = performance.now();
  try {
    const value = await run(msg.js);
    postAudit('cmd', { id: msg.id, ok: true, ms: Math.round(performance.now() - t0), value: plain(value) });
  } catch (e) {
    postAudit('cmd', { id: msg.id, ok: false, error: String((e && e.stack) || e).slice(0, 800) });
  } finally {
    busy = false;
  }
}

export function startRemote() {
  if (!import.meta.env.DEV || typeof fetch === 'undefined') return;
  window.mpRun = run;          // manual re-run from the console during verification
  setInterval(tick, POLL_MS);
}

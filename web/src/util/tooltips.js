// App-wide tooltips — every `title="…"` in the app shows the app tooltip instead
// of the native Windows box, with no per-surface wiring.
//
// Why delegated instead of a component: there are ~700 `title` attributes across
// ~200 files. This mirrors scrollMemory.js / smoothWheel.js — one set of document
// listeners installed from main.jsx, which runs in EVERY webview (main, popouts,
// overlay host, player controls), so every window gets it for free.
//
// Authoring: keep writing plain `title="…"`. Optional extras on the same element:
//   data-tip-desc="…"          a second, plain-words line under the name
//   data-tip-keybind="<id>"    a keybind registry id; the CURRENT binding is read
//                              at show time, so a rebind in Settings shows at once
//   data-tip-key="…"           a literal key label, for keys outside the registry
//   data-tip-img="<url>"       a portrait above the text (cast/crew headshots)
//   data-tip-img2="<url>"      a second portrait beside it (the character played)
//   data-tip-cap="…"           a caption UNDER the first portrait (the person)
//   data-tip-cap2="…"          a caption under the second one (the character).
//                              Any caption replaces the text row — the names are
//                              already under their own faces.
//
// Harvest: on hover the `title` moves to `data-tip` and is removed, which kills
// the native box before its own timer fires; on leave it goes straight back. So
// the DOM stays as authored everywhere except under the pointer — audit scripts
// that select `[title="…"]` keep working, and a title React changes meanwhile
// simply wins. While harvested, an icon-only control with no other accessible
// name borrows the text as aria-label (removed again on release).
//
// Placement is measured, never predicted: the element's live rect plus its live
// candy lip (--cbtn-depth), flipped above when there is no room below, clamped
// inside the window. Look + motion live in tooltips.css.

import './tooltips.css';
import { getLiveKeybinds, KEYBINDS_DEFAULT } from '../keybinds/registry.js';
import { formatBinding } from '../keybinds/format.js';

const DWELL_MS = 500;   // wait before the first tip shows
const HOP_MS = 400;     // after a tip hides, the next one within this window skips the wait
const GAP = 8;          // space between the element's painted bottom and the tip
const EDGE = 8;         // minimum distance from the window edge
const TARGET = '[title], [data-tip]';

let tip = null;
let cur = null;         // element the pointer/focus is on
let shown = false;
let timer = 0;
let lastHide = -Infinity;

function harvest(el) {
  const t = el.getAttribute('title');
  if (t == null) return;
  el.removeAttribute('title');
  if (!t.trim()) return;
  el.dataset.tip = t;
  if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.textContent.trim()) {
    el.setAttribute('aria-label', t);
    el.dataset.tipAria = '';
  }
}

function release(el) {
  if (!el || el.dataset.tip == null) return;
  if (!el.hasAttribute('title')) el.setAttribute('title', el.dataset.tip);
  delete el.dataset.tip;
  if (el.dataset.tipAria != null) { el.removeAttribute('aria-label'); delete el.dataset.tipAria; }
}

function keyLabel(el) {
  const id = el.dataset.tipKeybind;
  if (id) {
    const live = getLiveKeybinds();
    const binding = id in live ? live[id] : KEYBINDS_DEFAULT[id];
    return binding ? formatBinding(binding).join(' ') : '';   // unbound = no key
  }
  return el.dataset.tipKey || '';
}

function fill(el) {
  tip.textContent = '';
  const arrow = document.createElement('i');
  arrow.className = 'tooltip-arrow';
  const row = document.createElement('div');
  row.className = 'tooltip-row';
  const name = document.createElement('span');
  name.className = 'tooltip-name';
  name.textContent = el.dataset.tip;
  row.append(name);
  const key = keyLabel(el);
  if (key) {
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    row.append(kbd);
  }
  tip.append(arrow);
  // The boxes are sized by CSS, not by the files, so place() measures the right
  // height on the first hover — before the images have loaded.
  // Pair each picture with its caption BEFORE dropping the blanks: a chip can
  // have a character picture and no actor photo, and filtering first would slide
  // the actor's name under the character's face.
  const shots = [
    [el.dataset.tipImg, el.dataset.tipCap],
    [el.dataset.tipImg2, el.dataset.tipCap2],
  ].filter(([src]) => src);
  if (shots.length) {
    const strip = document.createElement('div');
    strip.className = 'tooltip-imgs';
    for (const [src, cap] of shots) {
      const fig = document.createElement('figure');
      fig.className = 'tooltip-fig';
      const img = document.createElement('img');
      img.className = 'tooltip-img';
      img.src = src;
      img.alt = '';
      fig.append(img);
      if (cap) {
        const c = document.createElement('figcaption');
        c.className = 'tooltip-cap';
        c.textContent = cap;
        fig.append(c);
      }
      strip.append(fig);
    }
    tip.append(strip);
  }
  // A captioned tip already says every name under its own face, so the text row
  // would only repeat it. ponytail: the kbd path and the captioned path never
  // meet (a keybound control has no portraits), so one flag covers both.
  if (!shots.some(([, cap]) => cap)) tip.append(row);
  if (el.dataset.tipDesc) {
    const desc = document.createElement('span');
    desc.className = 'tooltip-desc';
    desc.textContent = el.dataset.tipDesc;
    tip.append(desc);
  }
}

function place(el) {
  const r = el.getBoundingClientRect();
  const lip = parseFloat(getComputedStyle(el).getPropertyValue('--cbtn-depth')) || 0;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const below = r.bottom + lip + GAP;
  const side = below + th + EDGE <= innerHeight ? 'below' : 'above';
  const left = Math.min(Math.max(r.left + r.width / 2 - tw / 2, EDGE), innerWidth - tw - EDGE);
  tip.dataset.place = side;
  tip.style.left = `${left}px`;
  tip.style.top = `${side === 'below' ? below : r.top - GAP - th}px`;
  tip.firstChild.style.left = `${Math.min(Math.max(r.left + r.width / 2 - left, 12), tw - 12)}px`;
}

function show(el, hop) {
  if (!el.isConnected || !el.dataset.tip) return;
  tip.classList.toggle('is-hop', hop && shown);
  fill(el);
  place(el);
  if (!shown) {
    // Restart the pop from its resting-small state, then grow in.
    tip.classList.remove('is-shown');
    void tip.offsetWidth;
  }
  tip.classList.add('is-shown');
  shown = true;
}

// Put the tip away but keep the element harvested: the pointer is still on it,
// and a title restored under a still pointer would bring back the grey box.
function dismiss() {
  clearTimeout(timer);
  if (shown) {
    tip.classList.remove('is-shown', 'is-hop');
    lastHide = performance.now();
  }
  shown = false;
}

function hide() {
  dismiss();
  release(cur);
  cur = null;
}

function enter(el) {
  if (el === cur) return;
  harvest(el);
  if (!el.dataset.tip) return;
  clearTimeout(timer);
  release(cur);
  cur = el;
  const hop = shown || performance.now() - lastHide < HOP_MS;
  if (hop) show(el, true);
  else timer = setTimeout(() => cur === el && show(el, false), DWELL_MS);
}

function onOver(e) {
  if (e.buttons) return;                       // never while dragging / holding
  const el = e.target.closest?.(TARGET);
  if (el) enter(el);
}

function onOut(e) {
  if (!cur) return;
  const el = e.target.closest?.(TARGET);
  if (el !== cur || cur.contains(e.relatedTarget)) return;
  clearTimeout(timer);
  release(cur);
  cur = null;
  // Brief grace so sliding onto a neighbour keeps the tip up and it glides over.
  if (shown) timer = setTimeout(hide, 80);
}

function onFocusIn(e) {
  const el = e.target.closest?.(TARGET);
  if (el && el.matches(':focus-visible')) { hide(); enter(el); }
}

export function installTooltips() {
  if (typeof window === 'undefined' || tip) return;
  tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  // Element unmounted under a still pointer: pointerout never fires.
  document.addEventListener('pointermove', () => { if (cur && !cur.isConnected) hide(); }, { passive: true });
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', () => { if (cur && !cur.matches(':hover')) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(); }, true);
  document.addEventListener('scroll', () => { if (shown) dismiss(); }, { capture: true, passive: true });
  window.addEventListener('blur', hide);
}

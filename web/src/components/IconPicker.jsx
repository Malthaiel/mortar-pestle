// TEMPORARY icon picker. Right-click any candy button with an icon → Change Icon;
// overrides live in localStorage under ICON_OVERRIDE_KEY.
//
// This is a staging tool, NOT a feature. Once the icon set is final the chosen
// values get baked into source, and this file plus its call-site hooks are deleted:
//   App.jsx, main.jsx, Dock.jsx, ContextMenuProvider.jsx, styles.css ([data-icon-swapped])
// (ConfirmModal's `width` prop can stay — it's generally useful.)
//
// Keys and where to bake them:
//   dock:<id>  → dock-buttons.js `Icon:` / the module manifest's `iconKey`
//   btn:<Component>|<label>|<icon hash> → grep <Component> for the button whose
//     title/tooltip is <label>, swap its icon import. The hash only tells two icons
//     of one button apart (play vs pause); the value is what to bake.
//
// An override value is either a pack export name ('IconStar') or raw <svg> markup
// (a pick from the full Boxicons folder, or pasted — add it to icons.jsx first).

import { useEffect, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as icons from './icons.jsx';
import ConfirmModal from './ui/ConfirmModal.jsx';
import { useIconLibrary, svgComponent, sizeSvg, isMarkup, iconWords } from './iconLibrary.jsx';
import { TextInput, OutlinedBtn } from './ui';

export const ICON_OVERRIDE_KEY = 'iconOverrides:v1';

// ── store ────────────────────────────────────────────────────────────────────
// Cached so useSyncExternalStore gets a referentially stable snapshot; the cache
// is replaced wholesale on write, which is what wakes every subscriber.
let cache = null;
const subs = new Set();

function readMap() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(ICON_OVERRIDE_KEY)) || {}; } catch { cache = {}; }
  return cache;
}
function writeMap(next) {
  cache = next;
  try { localStorage.setItem(ICON_OVERRIDE_KEY, JSON.stringify(next)); } catch {}
  subs.forEach(f => f());
}
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };

const setOverride = (key, value) => {
  const next = { ...readMap() };
  if (value) next[key] = value; else delete next[key];
  writeMap(next);
};

// ── resolving an override to a component ─────────────────────────────────────
function resolve(value, Fallback) {
  if (!value) return Fallback;
  if (isMarkup(value)) return svgComponent(value.trim());
  return icons[value] || Fallback;
}

// A surface subscribes ONCE, then resolves each of its buttons off the snapshot —
// a hook per button is illegal inside a render loop.
export function useIconOverrides() {
  return useSyncExternalStore(subscribe, readMap);
}

// → an icon COMPONENT (the dock's buttons take `Icon`).
export const resolveIcon = (map, key, Fallback) => resolve(map[key], Fallback);

// ── every other candy button: btn: keys, swapped in the DOM ──────────────────
// No call site renders these, so the swap happens after React: the original svg
// is hidden ([data-icon-swapped], styles.css) and the pick sits right after it.
// React's own nodes are never removed, so a re-render can't break. The liquid
// hover rebuilds its copies on any child change, so they carry the pick too.
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
// Tree rows keep their own per-file picker; the dock has its own row.
const SKIP = new Set(['CandyHeader', 'TreeRow']);
const labelOf = (btn) => btn.getAttribute('title') || btn.getAttribute('data-tip') || btn.getAttribute('aria-label') || '';
const faceSvg = (btn) => [...btn.querySelectorAll('.candy-face svg:not([data-icon-override])')]
  .find((s) => s.closest('.candy-btn') === btn);
const svgHash = new WeakMap();
// ponytail: two untitled buttons with the same icon in one component share a key.
function btnKey(btn, svg) {
  if (!svgHash.has(svg)) svgHash.set(svg, hash(svg.innerHTML));
  return `btn:${btn.getAttribute('data-aos-component') || ''}|${labelOf(btn)}|${svgHash.get(svg)}`;
}

// The Change Icon row for a right-clicked candy icon button (ContextMenuProvider), or null.
export function iconRowFor(target) {
  const btn = target?.closest?.('.candy-btn');
  if (!btn || btn.closest('[role="menu"], [data-liquid-layer]') || SKIP.has(btn.getAttribute('data-aos-component'))) return null;
  const svg = faceSvg(btn);
  return svg ? changeIconItem(btnKey(btn, svg), labelOf(btn) || btn.getAttribute('data-aos-component') || 'Button') : null;
}

// A pack name is drawn once, off-screen, to get its markup.
const packMarkup = new Map();
function markupOf(value) {
  if (isMarkup(value)) return value.trim();
  if (!packMarkup.has(value)) {
    const C = icons[value], el = document.createElement('div'), root = createRoot(el);
    flushSync(() => root.render(C ? <C/> : null));
    packMarkup.set(value, el.innerHTML);
    root.unmount();
  }
  return packMarkup.get(value);
}

// The pick takes the original's own size attributes (or its painted size).
function pickSvg(value, orig, id) {
  const t = document.createElement('template');
  t.innerHTML = sizeSvg(markupOf(value), 1);
  const ov = t.content.querySelector('svg');
  if (!ov) return null;
  const r = orig.getBoundingClientRect();
  ov.setAttribute('width', orig.getAttribute('width') || r.width);
  ov.setAttribute('height', orig.getAttribute('height') || r.height);
  if (orig.hasAttribute('style')) ov.setAttribute('style', orig.getAttribute('style'));
  ov.setAttribute('data-icon-override', id);
  return ov;
}

function applyOverrides() {
  const map = readMap();
  if (!Object.keys(map).some((k) => k.startsWith('btn:')) && !document.querySelector('[data-icon-override]')) return;
  for (const btn of document.querySelectorAll('.candy-btn')) {
    if (btn.closest('[data-liquid-layer]')) continue;
    const svg = faceSvg(btn), value = svg && map[btnKey(btn, svg)];
    const id = value ? hash(value) : null;
    const ovs = [...btn.querySelectorAll('[data-icon-override]')].filter((o) => o.closest('.candy-btn') === btn);
    const keep = id && ovs.find((o) => o.getAttribute('data-icon-override') === id && o.previousElementSibling === svg);
    for (const o of ovs) if (o !== keep) o.remove();
    const ov = id && !keep && pickSvg(value, svg, id);
    if (svg) svg.toggleAttribute('data-icon-swapped', !!(keep || ov));
    if (ov) svg.after(ov);
  }
}

// Once, at boot (main.jsx). Re-runs on a pick and after any DOM change, batched per
// frame; a pass that changes nothing ends the loop its own inserts start.
// ponytail: every pass scans every candy button; scope it to the mutated subtrees if hover lags.
export function installIconOverrides() {
  let raf = 0;
  const run = () => { raf ||= requestAnimationFrame(() => { raf = 0; applyOverrides(); }); };
  subscribe(run);
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  run();
}

// ── the picker itself ────────────────────────────────────────────────────────
let openFn = null;
export const openIconPicker = (key, label) => openFn?.(key, label);

// Context-menu entry, so a call site adds the item in one line.
export const changeIconItem = (key, label) => ({
  label: 'Change Icon',
  icon: icons.IconPalette,
  onClick: () => openIconPicker(key, label),
});

const NAMES = Object.keys(icons).filter(n => n.startsWith('Icon')).sort();

export function IconPickerHost() {
  const [target, setTarget] = useState(null);
  const [paste, setPaste] = useState('');
  const [q, setQ] = useState('');
  const map = useSyncExternalStore(subscribe, readMap);
  const folder = useIconLibrary(!!target);

  useEffect(() => { openFn = (key, label) => { setPaste(''); setQ(''); setTarget({ key, label }); }; return () => { openFn = null; }; }, []);

  if (!target) return null;
  const current = map[target.key];
  const close = () => setTarget(null);
  const pick = (v) => { setOverride(target.key, v); close(); };
  // ConfirmModal binds Enter on WINDOW in the capture phase and stopPropagation()s
  // it, so an Enter-to-apply handler on the paste input can never fire. Route both
  // Enter and the confirm button through onConfirm instead: apply the paste when
  // there is one, otherwise reset.
  const pasted = paste.trim();
  const hasPaste = pasted.startsWith('<');
  // [title, search words, saved value, Component]: the app's own icons (saved by
  // name), then the whole folder (saved as markup, drawn on demand).
  const term = q.trim().toLowerCase();
  const cells = [
    ...NAMES.map((n) => [n, iconWords(n), n, icons[n]]),
    ...folder.map(([stem, svg]) => [stem, iconWords(stem), svg, null]),
  ];
  const list = term ? cells.filter(([, w]) => w.includes(term)) : cells;

  return (
    <ConfirmModal
      open
      width={560}
      title={`Icon for "${target.label}"`}
      message={`Key: ${target.key}`}
      cancelLabel="Close"
      confirmLabel="Use pasted icon"
      onCancel={close}
      onConfirm={() => (hasPaste ? pick(pasted) : close())}
    >
      <TextInput value={q} onChange={setQ} placeholder="Search" autoFocus/>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 320, overflowY: 'auto', padding: 2 }}>
        {/* ponytail: every cell renders unfiltered; window the grid if opening lags. */}
        {list.map(([title, , value, Cell]) => {
          const C = Cell || svgComponent(value);
          return (
            <button
              key={title} type="button" data-own-press title={title} onClick={() => pick(value)}
              className={`candy-btn${current === value ? ' is-active' : ''}`} data-shape="icon"
              style={{ width: 30, height: 30, '--corner-max': '15px', '--cbtn-depth': 'var(--candy-depth-nav)' }}
            >
              <span className="candy-face"><C size={17}/></span>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <TextInput
          value={paste}
          onChange={setPaste}
          placeholder="Or paste <svg> markup here, then press Enter"
          style={{ flex: 1, minWidth: 0 }}
        />
        <OutlinedBtn small onClick={() => pick(null)} disabled={!current}>Reset to Default</OutlinedBtn>
      </div>
    </ConfirmModal>
  );
}

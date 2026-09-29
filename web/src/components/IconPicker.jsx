// TEMPORARY icon picker. Right-click any dock button or file-tree toolbar button
// to swap its icon; overrides live in localStorage under ICON_OVERRIDE_KEY.
//
// This is a staging tool, NOT a feature. Once the icon set is final the chosen
// values get baked into icons.jsx / dock-buttons.js / the module manifests / the
// TreeToolbar call sites, and this file plus its five call-site hooks are deleted:
//   Dock.jsx, DownloadsDockButton.jsx, DockAgentsButton.jsx, TreeToolbar.jsx, App.jsx
// (ConfirmModal's `width` prop can stay — it's generally useful.)
//
// An override value is either a pack export name ('IconStar') or raw <svg> markup
// (a pick from the full Boxicons folder, or pasted).

import { useEffect, useState, useSyncExternalStore } from 'react';
import * as icons from './icons.jsx';
import ConfirmModal from './ui/ConfirmModal.jsx';
import { useIconLibrary, svgComponent, isMarkup, iconWords } from './iconLibrary.jsx';
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

// → an icon ELEMENT (TreeToolbar's buttons take children).
export function resolveIconEl(map, key, fallbackEl) {
  const C = resolve(map[key], null);
  return C ? <C/> : fallbackEl;
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

// Per-row icons for any candy tree — the vault file tree AND every module
// TreeSidebar. One localStorage blob keyed scope → row key → icon EXPORT NAME
// from icons.jsx, or the SVG markup of a pick from the full Boxicons folder (a
// string either way, never a component, so it survives a reload). Same
// storage habit as useTreeExpansion; nothing here knows about the vault.
//
// The icon renders through the rows' EXISTING `leadIcon` slot (treeKit), which
// already sits between the caret and the label on a folder — no row markup
// changes anywhere.

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Icons from '../icons.jsx';
import { NAV_ICON } from './treeKit.jsx';
import { svgComponent, isMarkup } from '../iconLibrary.jsx';

const KEY = 'tree_icons';

// The app's own icons, as [name, Component]. The picker lists these first, then
// the full folder (iconLibrary.jsx).
export const ICON_CATALOG = Object.entries(Icons)
  .filter(([n, v]) => n.startsWith('Icon') && typeof v === 'function')
  .sort((a, b) => a[0].localeCompare(b[0]));

// The nav icon size (treeKit NAV_ICON), not the icons' 18px default.
export const ICON_SIZE = NAV_ICON;

function loadAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

// flexShrink:0 — the label truncates before the icon does.
export function renderTreeIcon(name) {
  const C = isMarkup(name) ? svgComponent(name.trim()) : name && Icons[name];
  if (!C) return null;
  return <span style={{ display: 'inline-flex', flexShrink: 0 }}><C size={ICON_SIZE}/></span>;
}

// scope = one tree's namespace ('vault:<vault id>', '<module>:tree'), so two
// trees never fight over the same row key. Falsy scope = feature off.
export function useTreeIcons(scope) {
  const [map, setMap] = useState(() => (scope ? loadAll()[scope] || {} : {}));

  // The scope can ARRIVE late — the vault id resolves a tick after the tree
  // mounts, so the initial read above ran against a scope that isn't the real
  // one yet. Re-read whenever it changes, or the icons only ever show for the
  // rest of the session in which they were picked.
  useEffect(() => { setMap(scope ? loadAll()[scope] || {} : {}); }, [scope]);

  const set = useCallback((key, name) => {
    if (!scope || !key) return;
    setMap((prev) => {
      const next = { ...prev };
      if (name) next[key] = name; else delete next[key];
      try {
        const all = loadAll();
        if (Object.keys(next).length) all[scope] = next; else delete all[scope];
        localStorage.setItem(KEY, JSON.stringify(all));
      } catch {}
      return next;
    });
  }, [scope]);

  return useMemo(() => ({
    nameOf: (key) => map[key] || null,
    // `fallback` = the export name a row shows until the user picks one.
    leadIcon: (key, fallback) => renderTreeIcon(map[key] || fallback),
    set,
  }), [map, set]);
}

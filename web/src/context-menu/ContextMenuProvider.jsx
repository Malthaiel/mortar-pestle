// App-wide context-menu controller. Owns the single menu instance, exposes the
// useContextMenu() API, and mounts ONE global `contextmenu` suppressor that
// kills the native WebKitGTK menu everywhere and shows a context-appropriate
// default menu when no surface claimed the right-click.
//
// Handled-vs-default detection: openContextMenu marks the native event
// (__agenticCtxHandled) and preventDefaults it. The suppressor runs at the
// window bubble phase — after React's synthetic onContextMenu handlers — so the
// marker is already set if a surface opened a menu. `defaultPrevented` is a
// secondary guard for not-yet-migrated surfaces that suppress the native menu on
// their own (so they never get a duplicate default menu stacked on top).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ContextMenuCtx } from './useContextMenu.js';
import ContextMenuRoot from './ContextMenuRoot.jsx';
import { classifyTarget, buildEditableMenu, buildLinkMenu, buildGenericMenu, buildSelectionMenu } from './defaultMenus.js';
import { invoke } from '../api.js';

// Dev builds append Inspect Element to EVERY menu (custom + default): the
// suppressor above kills the native WebKit menu app-wide, which also kills
// the native Inspect Element — this row is its replacement. Release builds:
// no row (and the open_devtools command no-ops there anyway).
const withDevRows = (items) => {
  if (!import.meta.env.DEV) return items || [];
  return [
    ...(items || []),
    { label: 'Inspect Element', onClick: () => { invoke('open_devtools').catch(() => {}); } },
  ];
};

export function ContextMenuProvider({ openCommandPalette, openSettings, accent, children }) {
  const [menu, setMenu] = useState(null);

  // Mirror the latest chrome handlers/accent so the once-registered window
  // listener never reads a stale closure.
  const ctxRef = useRef({ openCommandPalette, openSettings, accent });
  ctxRef.current = { openCommandPalette, openSettings, accent };

  const openContextMenu = useCallback((evtOrPoint, items, opts = {}) => {
    const accentNow = ctxRef.current.accent;
    let point;
    const isEvent = evtOrPoint && (evtOrPoint.nativeEvent || typeof evtOrPoint.clientX === 'number');
    if (isEvent) {
      const native = evtOrPoint.nativeEvent || evtOrPoint;
      try { evtOrPoint.preventDefault && evtOrPoint.preventDefault(); } catch (e) {}
      try { native.preventDefault && native.preventDefault(); } catch (e) {}
      try { native.__agenticCtxHandled = true; } catch (e) {}
      const x = typeof evtOrPoint.clientX === 'number' ? evtOrPoint.clientX : (native.clientX || 0);
      const y = typeof evtOrPoint.clientY === 'number' ? evtOrPoint.clientY : (native.clientY || 0);
      // Keyboard-invoked contextmenu (Shift+F10 / Menu key) reports (0,0) —
      // anchor at the target element's bottom-left instead.
      if (!x && !y && evtOrPoint.currentTarget && evtOrPoint.currentTarget.getBoundingClientRect) {
        const r = evtOrPoint.currentTarget.getBoundingClientRect();
        point = { x: r.left, y: r.bottom };
      } else {
        point = { x, y };
      }
    } else {
      point = { x: (evtOrPoint && evtOrPoint.x) || 0, y: (evtOrPoint && evtOrPoint.y) || 0 };
    }
    setMenu({ point, items: withDevRows(items), opts: { accent: accentNow, ...opts } });
  }, []);

  const closeContextMenu = useCallback(() => setMenu(null), []);

  // Global native-menu suppressor — mounted once.
  useEffect(() => {
    function onNativeContextMenu(ev) {
      if (ev.__agenticCtxHandled) return;   // a surface opened a custom menu
      if (ev.defaultPrevented) return;       // legacy surface handled it itself
      ev.preventDefault();                   // suppress the native menu everywhere
      const c = ctxRef.current;
      const kind = classifyTarget(ev.target);
      // SF8: a non-editable, non-link right-click over a live text selection gets
      // the selection menu (Copy / Search vault) instead of the generic chrome menu.
      const selText = (typeof window !== 'undefined' && window.getSelection) ? String(window.getSelection() || '').trim() : '';
      let items;
      let source = kind;
      if (kind === 'editable') {
        items = buildEditableMenu(ev.target, { openCommandPalette: c.openCommandPalette });
      } else if (kind === 'link') {
        const anchor = ev.target.closest ? ev.target.closest('a[href], a[data-target]') : null;
        items = buildLinkMenu(anchor);
      } else if (selText) {
        items = buildSelectionMenu(selText, { openCommandPalette: c.openCommandPalette });
        source = 'selection';
      } else {
        items = buildGenericMenu({ openCommandPalette: c.openCommandPalette, openSettings: c.openSettings });
      }
      setMenu({ point: { x: ev.clientX, y: ev.clientY }, items: withDevRows(items), opts: { accent: c.accent, source } });
    }
    window.addEventListener('contextmenu', onNativeContextMenu);
    return () => window.removeEventListener('contextmenu', onNativeContextMenu);
  }, []);

  return (
    <ContextMenuCtx.Provider value={{ openContextMenu, closeContextMenu, menuOpen: !!menu }}>
      {children}
      {menu && (
        <ContextMenuRoot
          point={menu.point}
          items={menu.items}
          opts={menu.opts}
          onClose={closeContextMenu}
        />
      )}
    </ContextMenuCtx.Provider>
  );
}

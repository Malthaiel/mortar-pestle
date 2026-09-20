// App-wide context-menu hook + context. Surfaces opt into a custom right-click
// menu by calling openContextMenu from their onContextMenu handler:
//
//   const { openContextMenu } = useContextMenu();
//   <El onContextMenu={(e) => openContextMenu(e, items, opts)} />
//
// Pass the SYNTHETIC React event (so e.nativeEvent is the same object the
// provider's global suppressor sees — that identity is how the suppressor knows
// a surface claimed the right-click and skips the default menu). Or pass a
// { x, y } point for non-event callers (e.g. a "⋯" button computing its rect).
//
// `items` is an array of the menu-item schema (see ContextMenuRoot). `opts` may
// carry { accent, header, source }. Importable from modules as
// `@host/context-menu/useContextMenu.js`.

import { createContext, useContext, useEffect, useRef } from 'react';

// Safe no-op fallback so a surface rendered outside the provider never crashes.
const EMPTY = {
  openContextMenu: () => {},
  closeContextMenu: () => {},
  menuOpen: false,
};

export const ContextMenuCtx = createContext(null);

export const useContextMenu = () => useContext(ContextMenuCtx) || EMPTY;

// Dropdown = the context menu, opened under a trigger button. Every dropdown in
// the app (CandySelect, icon-button pickers) goes through this, so a dropdown IS
// the right-click menu 1-1. `buildItems()` runs at open time and may return a
// Promise (a list fetched fresh on each open); spread the returned
// props on the trigger. The menu's anchor is the trigger's measured rect: centred
// under it, or flipped above it when the menu would run off the bottom
// (ContextMenuRoot). DROP_GAP is visible air, measured from the trigger's painted
// candy band (--cbtn-depth, read live), not from its rect. 4px user-directed
// 2026-09-18 (was 6px from the rect = 1px of air under a 5px band).
const DROP_GAP = 4;
export function useMenuTrigger(buildItems, opts) {
  const { openContextMenu, closeContextMenu, menuOpen } = useContextMenu();
  const mine = useRef(false);  // the open menu is ours
  const skip = useRef(false);  // this click is the one that just closed it
  // ponytail: a right-click menu opened elsewhere while ours is up keeps `mine`
  // true until it closes; a provider-side owner id fixes that if it ever matters.
  useEffect(() => { if (!menuOpen) mine.current = false; }, [menuOpen]);
  const open = (el) => {
    const r = el.getBoundingClientRect();
    const band = parseFloat(getComputedStyle(el).getPropertyValue('--cbtn-depth')) || 0;
    mine.current = true;
    Promise.resolve(buildItems()).then((items) =>
      openContextMenu({ x: r.left + r.width / 2, y: r.bottom + band + DROP_GAP }, items,
        { ...opts, dropdown: true, align: 'center', aboveY: r.top - DROP_GAP }));
  };
  return {
    // A trigger owns its own toggle: ContextMenuRoot's outside-mousedown
    // deliberately does NOT close the menu when the press lands on a trigger
    // (see its onDown), so `menuOpen` is still true here and the click below
    // closes it. Letting the outside handler close it first raced — the browser
    // runs a microtask checkpoint between listeners on a REAL press, so React
    // had already flushed menuOpen=false by the time this ran and the click
    // re-opened the menu it had just shut (user-reported 2026-09-19). Synthetic
    // dispatch cannot reproduce that: no checkpoint runs mid-script.
    onMouseDown: () => { skip.current = menuOpen && mine.current; },
    onClick: (e) => {
      if (skip.current) { skip.current = false; closeContextMenu(); return; }
      open(e.currentTarget);
    },
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(e.currentTarget); }
    },
    'aria-haspopup': 'menu',
    'aria-expanded': menuOpen && mine.current,
  };
}

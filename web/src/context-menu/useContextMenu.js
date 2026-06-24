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

import { createContext, useContext } from 'react';

// Safe no-op fallback so a surface rendered outside the provider never crashes.
const EMPTY = {
  openContextMenu: () => {},
  closeContextMenu: () => {},
  menuOpen: false,
};

export const ContextMenuCtx = createContext(null);

export const useContextMenu = () => useContext(ContextMenuCtx) || EMPTY;

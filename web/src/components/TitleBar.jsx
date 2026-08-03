// The app's own window titlebar, replacing the native Windows one (the main
// window runs `decorations: false` in tauri.conf.json). No app name — three
// window controls at the right, and the whole remaining strip is the drag
// handle. Rendered only in the main window; the overlay windows return early
// in App.jsx and never mount this.
//
// Dragging and double-click-to-maximize are handled entirely by Tauri via the
// `data-tauri-drag-region` attribute — no pointer handlers here. Only the
// element carrying the attribute is draggable, so the buttons stay clickable.
//
// The four `core:window:` permissions this needs (minimize / toggle-maximize /
// close / start-dragging) are listed in capabilities/default.json; without
// them every control silently no-ops.

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IconMinus, IconSquare, IconRestore, IconX } from './icons.jsx';

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  // Maximized state drives the middle glyph (square vs. two offset frames).
  // onResized fires for maximize, restore, snap, and plain edge-drags alike,
  // so one listener covers every path in and out of the maximized state.
  useEffect(() => {
    const win = getCurrentWindow();
    const sync = () => win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    const un = win.onResized(sync);
    return () => { un.then(f => f()).catch(() => {}); };
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
      <button className="titlebar-btn" title="Minimize" onClick={() => win.minimize()}>
        <IconMinus/>
      </button>
      <button
        className="titlebar-btn"
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => win.toggleMaximize()}
      >{maximized ? <IconRestore/> : <IconSquare/>}</button>
      <button className="titlebar-btn is-close" title="Close" onClick={() => win.close()}>
        <IconX/>
      </button>
    </div>
  );
}

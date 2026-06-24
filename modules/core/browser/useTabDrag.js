// Pointer-based drag for browser tabs (WebKitGTK has no working HTML5 DnD — see
// startPaneDrag in the Planner). Replaces the old HTML5 useDragReorder for the
// tab tree. A pointerdown on a tab row opens a window-level pointer session; once
// past a 4px threshold it tracks a floating ghost + resolves a drop target via
// elementFromPoint: a tab row → reorder before it (joining that row's group); a
// folder header/body → move into that group; the top-level list → ungroup. On
// pointerup it applies the move via the store. A bare click (no movement past the
// threshold) leaves the row's onClick to switch tabs.

import { useCallback, useState } from 'react';
import * as store from './tabStore.js';

export function useTabDrag() {
  const [drag, setDrag] = useState(null);

  const startDrag = useCallback((tab, e) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let started = false;
    let target = null;

    const resolve = (x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const row = el.closest('[data-tab-id]');
      if (row && row.getAttribute('data-tab-id') !== tab.id) {
        return { kind: 'before-tab', beforeId: row.getAttribute('data-tab-id'),
                 folderId: row.getAttribute('data-folder-id') || null };
      }
      const folder = el.closest('[data-folder-drop]');
      if (folder) return { kind: 'into-folder', folderId: folder.getAttribute('data-folder-drop') };
      if (el.closest('[data-top-level-drop]')) return { kind: 'top-level', folderId: null };
      return null;
    };

    const move = (ev) => {
      if (!started) {
        if ((ev.clientX - sx) ** 2 + (ev.clientY - sy) ** 2 < 16) return;
        started = true;
      }
      target = resolve(ev.clientX, ev.clientY);
      setDrag({ tabId: tab.id, label: tab.title || tab.url || 'New tab', x: ev.clientX, y: ev.clientY, target });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (started && target) {
        if (target.kind === 'before-tab') store.moveTab(tab.id, target.folderId, target.beforeId);
        else store.moveTab(tab.id, target.folderId, null); // into-folder / top-level
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  return { drag, startDrag };
}

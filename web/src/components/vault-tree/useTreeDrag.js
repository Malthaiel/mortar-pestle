// Obsidian-style drag-to-move for the file tree. A press that MOVES (ARM_PX) arms
// the drag; a press that doesn't is left completely alone, so a plain tap still
// toggles a folder / opens a note exactly as before. While armed, the grabbed row
// rides a fixed, pointer-events:none ghost under the cursor and the folder under
// the cursor lights up as the drop target.
//
// Drop targets are found by hit-testing the LIVE DOM every move
// (elementFromPoint → the nearest [data-drop-path]) rather than by modelling the
// tree's geometry: the rows shift under the cursor mid-drag (the grabbed folder
// collapses the instant it arms), so any precomputed row map would be wrong by the
// first frame. Measure, never predict.

import { useCallback, useEffect, useRef, useState } from 'react';

// Pointer travel that separates a click from a drag.
const ARM_PX = 4;
// Ghost offset from the cursor — down-right, so the cursor never sits on the pill
// it is carrying (the ghost is pointer-events:none, but it would still hide the
// row underneath).
const GHOST_DX = 12;
const GHOST_DY = 10;

// A node may be dropped into `path` only if that is a REAL relocation: not itself,
// not one of its own descendants (which would move a folder inside itself), and
// not the parent it already lives in.
function canDrop(node, path) {
  if (path == null || !node) return false;
  if (path === node.vaultPath || path.startsWith(node.vaultPath + '/')) return false;
  return path !== node.vaultPath.split('/').slice(0, -1).join('/');
}

// isOpen(vaultPath) / collapse(node) come from useVaultTree; onDrop(node, destVp)
// performs the move. Returns:
//   start(node)  → an onPointerDown handler for that row
//   guard(fn)    → wraps a row's onClick so the click that ends a drag is swallowed
//   node, over   → the row being dragged + the valid drop path under the cursor
//   ghostRef     → attach to the fixed ghost wrapper the caller renders
export function useTreeDrag({ isOpen, collapse, onDrop }) {
  const [node, setNode] = useState(null);
  // Width of the row that was grabbed, measured at pointerdown. The ghost is
  // portalled to <body>, where the row's own `maxWidth: 100%` would resolve against
  // the whole window instead of the sidebar — so a long name would stop ellipsizing
  // and spill across the reader. Pinning the ghost to the SOURCE row's real width
  // reproduces the sidebar's truncation exactly, without restating a rail width
  // that is owned elsewhere.
  const [width, setWidth] = useState(null);
  const [over, setOver] = useState(null);
  const ghostRef = useRef(null);
  const overRef = useRef(null);
  const posRef = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  overRef.current = over;

  // The ghost mounts a frame AFTER the drag arms (React renders async), so the
  // first transform write in the move handler lands on a null ref. Position it
  // once here from the pointer position that armed it — otherwise it paints at
  // 0,0 for one frame.
  useEffect(() => {
    const g = ghostRef.current;
    if (!node || !g) return;
    const { x, y } = posRef.current;
    g.style.transform = `translate(${x + GHOST_DX}px, ${y + GHOST_DY}px)`;
  }, [node]);

  const start = useCallback((n) => (e) => {
    // Left button only. WHICH rows are draggable is the caller's call — it simply
    // does not hand this handler to a row that must stay put (a protected root).
    if (e.button !== 0 || !n) return;
    const s = { armed: false, x0: e.clientX, y0: e.clientY, w: e.currentTarget.getBoundingClientRect().width };

    const move = (ev) => {
      posRef.current = { x: ev.clientX, y: ev.clientY };
      if (!s.armed) {
        if (Math.hypot(ev.clientX - s.x0, ev.clientY - s.y0) < ARM_PX) return;
        s.armed = true;
        document.body.style.userSelect = 'none';
        // Carry the folder, not its whole open subtree.
        if (n.isFolder && isOpen(n.vaultPath)) collapse(n);
        setWidth(s.w);
        setNode(n);
      }
      const g = ghostRef.current;
      if (g) g.style.transform = `translate(${ev.clientX + GHOST_DX}px, ${ev.clientY + GHOST_DY}px)`;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-drop-path]');
      const path = hit ? hit.getAttribute('data-drop-path') : null;
      const next = canDrop(n, path) ? path : null;
      setOver((prev) => (prev === next ? prev : next));
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      document.body.style.userSelect = '';
      const dest = overRef.current;
      const armed = s.armed;
      setNode(null);
      setOver(null);
      setWidth(null);
      if (!armed) return;
      // pointerup still emits a click on the row we started from; swallow exactly
      // one. The timeout runs a task later, after the click has been dispatched.
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      if (dest != null) onDrop(n, dest);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }, [isOpen, collapse, onDrop]);

  const guard = useCallback((fn) => (e) => {
    if (suppressClick.current) return;
    fn?.(e);
  }, []);

  return { node, over, width, start, guard, ghostRef };
}

// ponytail: no drop-onto-vault-root and no drop-between-rows. The tree has no root
// row to aim at, and row order is sort-driven (Settings → sort mode), not
// user-owned, so there is nothing an insertion point could persist.

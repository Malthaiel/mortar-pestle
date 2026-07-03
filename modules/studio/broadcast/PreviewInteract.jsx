// SP3 on-preview transform layer (locked #4) — an invisible event surface
// INSIDE the EngineDisplay holder. It draws NOTHING (the native region
// occludes all DOM; the ENGINE draws selection box/handles/guides) — this
// layer only receives pointer events that fall through the HTTRANSPARENT
// child window, runs the canvasMath mapper, and speaks verbs:
// pointer-rate `set_transform` + `set_snap_guides` (ephemeral, no
// save/push), ONE `transform_commit` on release (save + push + undo).
//
// v1 ceilings (ledgered): rotated items move/crop only on-preview (scale via
// the inspector numerics); grouped children hit as their group.
//
// Keyboard (layer focused): arrows nudge 1px (Shift 10), Del removes the
// selected item, F2 arms rename, Esc aborts a live gesture.

import React, { useEffect, useRef } from 'react';
import {
  HANDLE_SCREEN_PX, SNAP_SCREEN_PX, aabb, handleAt, handleCursor, hitTest,
  scaleOf, snapMove, toCanvas,
} from './canvasMath.js';
import { getBroadcastUi, updateBroadcastUi, verb } from './broadcastStore.js';
import { pushUndo } from './broadcastUndo.js';
import { allItems } from './sceneOps.js';
import { removeItemWithUndo } from './mutations.js';

export default function PreviewInteract({ api, snapshot }) {
  const ref = useRef(null);
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  const gestureRef = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const programScene = () => {
      const s = snapRef.current;
      return (s?.scenes || []).find((sc) => sc.name === s.current_scene) || null;
    };
    const displayItems = (scene) => [...(scene?.sources || [])].reverse();
    const canvas = () => snapRef.current?.canvas || { width: 1920, height: 1080 };
    const findItem = (scene, id) => allItems(scene).find((i) => i.item_id === id);

    const send = (op, args) => verb(api, op, args).catch(() => {});

    const commitGesture = (g, aborted) => {
      send('set_snap_guides', { guides: [] });
      if (aborted) {
        send('set_transform', { scene: g.scene, item: g.itemId, transform: g.startT, crop: g.startC });
        return;
      }
      const t = g.lastT || null;
      const c = g.lastC || null;
      if (!t && !c) return;
      verb(api, 'transform_commit', { scene: g.scene, item: g.itemId, transform: t || {}, crop: c || {} })
        .then(() => pushUndo({
          label: `Transform`,
          undo: [{ op: 'transform_commit', args: { scene: g.scene, item: g.itemId, transform: g.startT, crop: g.startC } }],
          redo: [{ op: 'transform_commit', args: { scene: g.scene, item: g.itemId, transform: t || {}, crop: c || {} } }],
        }))
        .catch((e) => console.warn('[broadcast] transform_commit', e));
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      const scene = programScene();
      if (!scene) return;
      el.focus();
      const rect = el.getBoundingClientRect();
      const cv = canvas();
      const p = toCanvas(e.clientX, e.clientY, rect, cv);
      const items = displayItems(scene);
      const sel = getBroadcastUi().selection;
      const selNode = sel && sel.scene === scene.name ? items.find((i) => i.item_id === sel.itemId) : null;
      const scale = scaleOf(rect, cv);
      const hs = HANDLE_SCREEN_PX * scale;

      // Handle grab on the current selection first (handles overhang the box).
      let mode = null;
      let handle = -1;
      let target = null;
      if (selNode && !selNode.locked && selNode.visible) {
        handle = handleAt(p, selNode.corners, hs);
        if (handle >= 0 && Math.abs(selNode.transform.rot) < 0.01) {
          mode = e.altKey ? 'crop' : 'scale';
          target = selNode;
        }
      }
      if (!mode) {
        const hit = hitTest(p, items);
        if (!hit) {
          updateBroadcastUi({ selection: null });
          send('select_item', { scene: scene.name, item: null });
          return;
        }
        updateBroadcastUi({ selection: { scene: scene.name, itemId: hit.item_id } });
        send('select_item', { scene: scene.name, item: hit.item_id });
        target = hit;
        mode = e.altKey && Math.abs(hit.transform.rot) < 0.01 ? 'crop' : 'move';
        if (mode === 'crop') handle = -1; // nearest-edge crop resolves on first move
      }
      gestureRef.current = {
        mode, handle,
        scene: scene.name,
        itemId: target.item_id,
        startPt: p,
        startT: { ...target.transform },
        startC: { ...target.crop },
        corners: target.corners.map((c) => [...c]),
        lastT: null, lastC: null,
        moved: false,
      };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      const g = gestureRef.current;
      const rect = el.getBoundingClientRect();
      const cv = canvas();
      if (!g) {
        // Hover cursor feedback only.
        const scene = programScene();
        if (!scene) return;
        const p = toCanvas(e.clientX, e.clientY, rect, cv);
        const sel = getBroadcastUi().selection;
        const items = displayItems(scene);
        const selNode = sel && sel.scene === scene.name ? items.find((i) => i.item_id === sel.itemId) : null;
        const scale = scaleOf(rect, cv);
        let cursor = 'default';
        if (selNode && Math.abs(selNode.transform.rot) < 0.01) {
          const h = handleAt(p, selNode.corners, HANDLE_SCREEN_PX * scale);
          if (h >= 0) cursor = handleCursor(h);
        }
        if (cursor === 'default' && hitTest(p, items)) cursor = 'move';
        el.style.cursor = cursor;
        return;
      }
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const p = toCanvas(e.clientX, e.clientY, rect, cv);
        const dx = p[0] - g.startPt[0];
        const dy = p[1] - g.startPt[1];
        if (!g.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        g.moved = true;
        const scale = scaleOf(rect, cv);

        if (g.mode === 'move') {
          let nx = g.startT.pos_x + dx;
          let ny = g.startT.pos_y + dy;
          let guides = [];
          if (!e.shiftKey) {
            const box = aabb(g.corners);
            const moved = { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy };
            const s = snapMove(moved, cv, SNAP_SCREEN_PX * scale);
            nx += s.dx;
            ny += s.dy;
            guides = s.guides;
          }
          g.lastT = { pos_x: nx, pos_y: ny };
          send('set_transform', { scene: g.scene, item: g.itemId, transform: g.lastT });
          send('set_snap_guides', { guides });
        } else if (g.mode === 'scale') {
          // Alignment point (pos) stays fixed; ratio per axis from the
          // pointer's distance to it (locked design — OBS feel without the
          // alignment-math port).
          const px = g.startT.pos_x;
          const py = g.startT.pos_y;
          const sx0 = g.startPt[0] - px;
          const sy0 = g.startPt[1] - py;
          const horiz = g.handle === 5 || g.handle === 7 || g.handle <= 3;
          const vert = g.handle === 4 || g.handle === 6 || g.handle <= 3;
          const fx = horiz && Math.abs(sx0) > 1 ? (p[0] - px) / sx0 : 1;
          const fy = vert && Math.abs(sy0) > 1 ? (p[1] - py) / sy0 : 1;
          g.lastT = {
            scale_x: Math.max(0.01, g.startT.scale_x * fx),
            scale_y: Math.max(0.01, g.startT.scale_y * fy),
          };
          send('set_transform', { scene: g.scene, item: g.itemId, transform: g.lastT });
        } else if (g.mode === 'crop') {
          // Crop deltas are SOURCE px: canvas delta ÷ item scale.
          const sxs = Math.max(0.01, Math.abs(g.startT.scale_x));
          const sys = Math.max(0.01, Math.abs(g.startT.scale_y));
          if (g.handle === -1) {
            // Nearest-edge pick on first real move: dominant axis + direction.
            g.handle = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 7 : 5) : (dy > 0 ? 4 : 6);
          }
          const c = { ...g.startC };
          if (g.handle === 7 || g.handle === 0 || g.handle === 3) c.left = Math.max(0, Math.round(g.startC.left + dx / sxs));
          if (g.handle === 5 || g.handle === 1 || g.handle === 2) c.right = Math.max(0, Math.round(g.startC.right - dx / sxs));
          if (g.handle === 4 || g.handle === 0 || g.handle === 1) c.top = Math.max(0, Math.round(g.startC.top + dy / sys));
          if (g.handle === 6 || g.handle === 2 || g.handle === 3) c.bottom = Math.max(0, Math.round(g.startC.bottom - dy / sys));
          g.lastC = c;
          send('set_transform', { scene: g.scene, item: g.itemId, crop: c });
        }
      });
    };

    const onPointerUp = () => {
      const g = gestureRef.current;
      if (!g) return;
      gestureRef.current = null;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      commitGesture(g, false);
    };

    const onKeyDown = (e) => {
      const g = gestureRef.current;
      if (e.key === 'Escape' && g) {
        gestureRef.current = null;
        commitGesture(g, true);
        e.preventDefault();
        return;
      }
      const scene = programScene();
      const sel = getBroadcastUi().selection;
      if (!scene || !sel || sel.scene !== scene.name) return;
      const node = findItem(scene, sel.itemId);
      if (!node) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeItemWithUndo(api, snapRef.current, scene, node);
      } else if (e.key === 'F2') {
        e.preventDefault();
        updateBroadcastUi({ renameTarget: { scene: scene.name, itemId: node.item_id } });
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const t = { pos_x: node.transform.pos_x + dx, pos_y: node.transform.pos_y + dy };
        verb(api, 'transform_commit', { scene: scene.name, item: node.item_id, transform: t })
          .then(() => pushUndo({
            label: 'Nudge',
            undo: [{ op: 'transform_commit', args: { scene: scene.name, item: node.item_id, transform: { pos_x: node.transform.pos_x, pos_y: node.transform.pos_y } } }],
            redo: [{ op: 'transform_commit', args: { scene: scene.name, item: node.item_id, transform: t } }],
          }))
          .catch(() => {});
      }
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('keydown', onKeyDown);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [api]);

  return (
    <div
      ref={ref}
      tabIndex={0}
      style={{ position: 'absolute', inset: 0, outline: 'none' }}
      aria-label="Preview transform surface"
    />
  );
}

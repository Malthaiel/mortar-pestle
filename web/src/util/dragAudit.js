import { GLIDE_MS } from './motion.js';
// DEV drop auditor — the MOTION counterpart to candyCenterAudit (optical
// centering) and spacingAudit (vertical rhythm). Those two measure static
// layout; this one drives ONE real reorder on a DraggableSidebarList with
// synthetic pointer events and measures the only thing the drop has to get
// right:
//
//   NOTHING MOVES AFTER THE FINGER COMES UP.
//
// It samples every item's rect at rest, then repeatedly for a full glide plus
// a margin after release, and asserts three things:
//
//   still   — every post-glide sample is IDENTICAL to the one before it.
//             Exact equality, not a tolerance: the glide runs on
//             cubic-bezier(.22,1,.36,1), which decelerates so hard its last
//             frames move a tenth of a pixel at a time. A sub-0.5px tolerance
//             reads that as "finished" and passes a drop that is still 0.6px
//             short (measured 2026-09-14).
//   landed  — each item's final rect is one of the rects the list had BEFORE
//             the drag. The new arrangement must be a permutation of the
//             resting slots, so a landed rect matching no resting slot means
//             the list settled somewhere it was never supposed to be.
//   clean   — no inline transform / transition / z-index survives the drop. A
//             lingering transform keeps the element on its own compositing
//             layer, where a fractional position snaps to a whole device pixel
//             and it paints 1px off its neighbours.
//
// This replaced (2026-09-19) an auditor that checked a PREDICTED landing
// coordinate against reality — settleDelta, the accent bridge, the clone's
// press-release curve. All three described machinery that no longer exists:
// there is no clone, no prediction and no bridge, because the dragged item is
// the real one and never leaves the DOM. See Plans/Drag Reorder Rewrite.md.
//
// Synthetic pointer events drive the gesture fine (it is pointer-listener
// based), but they do NOT reproduce a real finger: a real press flushes React
// state between listeners where dispatchEvent does not. A green run here is a
// floor, never a substitute for a filmed take.
//
// Run `dragAudit()` in any webview console (overlay host included). Default =
// no-op drop of the first item on the first [data-drag-list] — the order is
// untouched; the pickup/drop thocks will sound. dragAudit(sel|el, { from, to })
// drives a real move, and that DOES commit the reorder. Never shipped to prod:
// imported only behind import.meta.env.DEV in main.jsx.

const HOLD_WAIT = 220;   // > the 180ms hold, so pickup arms for every consumer
const SETTLE_PAD = 400;  // watch this long past the glide for a late twitch
const SAMPLE_MS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firePointer(type, target, { x, y }) {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
    pointerId: 971,
    pointerType: 'mouse',
  }));
}

// Rects as integers of milli-pixels, so two samples compare for EXACT equality
// without float noise from getBoundingClientRect's own arithmetic. 1e-3 px is
// far below anything that can paint.
const snap = (list) => [...list.children].map((el) => {
  const r = el.getBoundingClientRect();
  return [Math.round(r.left * 1000), Math.round(r.top * 1000), Math.round(r.width * 1000), Math.round(r.height * 1000)];
});
const same = (a, b) => a.length === b.length && a.every((r, i) => r.every((v, j) => v === b[i][j]));
const px = (v) => (v / 1000).toFixed(2);

export async function dragAudit(target = '[data-drag-list]', { from = 0, to = null, quiet = false } = {}) {
  const list = typeof target === 'string' ? document.querySelector(target) : target;
  if (!list) { console.warn('[dragAudit] no [data-drag-list] found'); return null; }
  const src = list.children[from];
  if (!src) { console.warn(`[dragAudit] no item at index ${from}`); return null; }

  const horizontal = getComputedStyle(list).flexDirection.startsWith('row');
  const rest = snap(list);

  const r = src.getBoundingClientRect();
  const start = { x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(24, r.height / 2) };
  // Destination: a real slot's centre, or (no-op default) a nudge inside the
  // source's own band — past the 10px move threshold, short of the next slot.
  const dest = to == null
    ? { x: start.x + (horizontal ? 14 : 0), y: start.y + (horizontal ? 0 : 14) }
    : (() => {
        const t = list.children[Math.min(to, list.children.length - 1)].getBoundingClientRect();
        return { x: t.left + t.width / 2, y: t.top + t.height / 2 };
      })();

  const flags = [];
  const after = [];
  try {
    firePointer('pointerdown', src, start);
    await sleep(HOLD_WAIT);
    for (let i = 1; i <= 4; i++) {
      firePointer('pointermove', window, {
        x: start.x + ((dest.x - start.x) * i) / 4,
        y: start.y + ((dest.y - start.y) * i) / 4,
      });
      await sleep(80);
    }
    firePointer('pointerup', window, dest);

    const total = GLIDE_MS + SETTLE_PAD;
    const t0 = performance.now();
    while (performance.now() - t0 < total) {
      await sleep(SAMPLE_MS);
      after.push({ t: Math.round(performance.now() - t0), rects: snap(list) });
    }
  } catch (e) {
    // Never leave the component mid-drag if something threw.
    firePointer('pointerup', window, dest);
    console.warn('[dragAudit] threw mid-run', e);
    return null;
  }

  // ── still: nothing moves once the glide's window has closed ──────────────
  // One sample period of slack past GLIDE_MS, so the final commit frame is not
  // itself counted as movement.
  const settled = after.filter((s) => s.t >= GLIDE_MS + 2 * SAMPLE_MS);
  let movedAfterDrop = null;
  for (let i = 1; i < settled.length; i++) {
    if (same(settled[i - 1].rects, settled[i].rects)) continue;
    const a = settled[i - 1].rects;
    const b = settled[i].rects;
    const k = a.findIndex((rr, j) => rr.some((v, q) => v !== b[j][q]));
    movedAfterDrop = { t: settled[i].t, item: k, was: a[k], now: b[k] };
    break;
  }
  if (movedAfterDrop) {
    const m = movedAfterDrop;
    flags.push(`MOVED AFTER THE DROP: item ${m.item} changed at t+${m.t}ms — `
      + `left ${px(m.was[0])}→${px(m.now[0])}, top ${px(m.was[1])}→${px(m.now[1])}. `
      + 'The glide is over by then; nothing should still be in flight.');
  }

  // ── landed: every final rect is one of the resting slots ─────────────────
  const final = after.length ? after[after.length - 1].rects : [];
  const offSlot = [];
  if (final.length !== rest.length) {
    flags.push(`ITEM COUNT CHANGED: ${rest.length} → ${final.length} — the drag added or lost a slot.`);
  } else {
    for (let i = 0; i < final.length; i++) {
      if (!rest.some((rr) => rr.every((v, j) => v === final[i][j]))) offSlot.push(i);
    }
    if (offSlot.length) {
      flags.push(`OFF-SLOT LANDING: item${offSlot.length > 1 ? 's' : ''} ${offSlot.join(', ')} settled at a rect `
        + 'matching no resting slot — the arrangement must be a permutation of the slots the list had before the drag.');
    }
  }

  // ── clean: the drag hands every element back to the stylesheet ───────────
  const fossils = [...list.children].filter((el) => el.style.transform || el.style.transition || el.style.zIndex).length;
  if (fossils) {
    flags.push(`${fossils} item(s) still carry an inline transform / transition / z-index after the drop. `
      + 'A lingering transform keeps the element on its own compositing layer, where a fractional position '
      + 'snaps to a whole device pixel and it paints 1px off its neighbours.');
  }
  if (list.hasAttribute('data-dragging')) flags.push('data-dragging still set on the list after the drop.');
  if (list.hasAttribute('data-dl-grow-list') || list.parentElement?.hasAttribute('data-dl-grow-card')) {
    flags.push('grow-to-contain attributes survived the drop — the container will stay stretched.');
  }

  const report = {
    list: list.className || '[data-drag-list]',
    direction: horizontal ? 'row' : 'column',
    items: rest.length,
    glideMs: GLIDE_MS,
    samples: after.length,
    settledSamples: settled.length,
    movedAfterDrop,
    offSlot,
    inlineFossils: fossils,
    flags,
    pass: flags.length === 0,
  };
  if (!quiet) {
    console.log(`[dragAudit] ${report.pass ? 'PASS' : 'FAIL'} — ${rest.length} items, ${settled.length} post-glide samples, `
      + `${movedAfterDrop ? 'MOVED after drop' : 'still after drop'}, ${offSlot.length} off-slot, ${fossils} inline fossils`);
    for (const f of flags) console.warn('[dragAudit] ' + f);
  }
  return report;
}

export function startDragAudit() {
  window.dragAudit = dragAudit;
}

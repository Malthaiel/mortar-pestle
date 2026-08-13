import { GLIDE_MS } from './motion.js';
// DEV drop-sequence auditor — the MOTION counterpart to candyCenterAudit
// (optical centering) and spacingAudit (vertical rhythm). Those two measure
// static layout; this one drives ONE real reorder on a DraggableSidebarList
// with synthetic pointer events and measures the drop invariants numerically
// (the invariant list lives at the top of DraggableSidebarList.jsx — each was
// broken once, found by eyeball, in the 2026-07-01 drop-flicker saga):
//
//   settleDelta   — px between the clone's last gliding frame and the landed
//                   tile's rect: >1px = the clone glided to the wrong slot
//                   (the one-flex-gap bug reads as settleDelta ≈ gap).
//   bridgeOnTile  — .is-drop-accent landed on the under-cursor tile at commit
//                   (the accent-continuity bridge; :hover can't cover it).
//   faceTransition— computed transition-property of the bridged face: must be
//                   'transform' only (colour fades = the original flicker).
//   pressRelease  — the clone's face translateY series through the glide:
//                   starts pressed (≈ depth), eases to 0; any single frame
//                   jump > 60% of depth = the snap bug.
//
// Synthetic pointer events drive the drag fine (it's pointer-listener based);
// only :hover itself can't be faked — which is exactly why the bridge class
// exists and why this audit asserts the class, not the pseudo-state.
//
// Run `dragAudit()` in any webview console (overlay host included). Default =
// no-op drop of the first tile on the first [data-drag-list] — list order is
// untouched; the pickup/drop thocks will sound. dragAudit(sel|el, {from, to})
// drives a real move (to = original-index insert-before slot, N = past end —
// note that DOES commit the reorder). Never shipped to prod: imported only
// behind import.meta.env.DEV in main.jsx.

const HOLD_WAIT = 220;   // > the 180ms hold so pickup arms for every consumer (incl. dock)
const TOL = 1.0;         // px — sub-pixel rounding

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));

const faceY = (face) => {
  const t = getComputedStyle(face).transform;
  if (!t || t === 'none') return 0;
  return new DOMMatrixReadOnly(t).m42;
};

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

export async function dragAudit(target = '[data-drag-list]', { from = 0, to = null, quiet = false } = {}) {
  const list = typeof target === 'string' ? document.querySelector(target) : target;
  if (!list) { console.warn('[dragAudit] no [data-drag-list] found'); return null; }
  const items = [...list.children];
  const src = items[from];
  if (!src) { console.warn(`[dragAudit] no item at index ${from}`); return null; }

  const horizontal = getComputedStyle(list).flexDirection.startsWith('row');
  // One glide app-wide; the 'drag-drop-glide' bucket this used to read was
  // deleted 2026-08-13.
  const glideMs = GLIDE_MS;

  const r = src.getBoundingClientRect();
  const start = { x: r.left + Math.min(24, r.width / 2), y: r.top + Math.min(24, r.height / 2) };
  // Destination: a real slot's centre, or (no-op default) a nudge within the
  // source's own band — past the 10px move threshold, before the next slot's
  // shift threshold — so the reorder resolves to "insert before source + 1".
  const dest = to == null
    ? { x: start.x + (horizontal ? 14 : 0), y: start.y + (horizontal ? 0 : 14) }
    : (() => { const t = items[Math.min(to, items.length - 1)].getBoundingClientRect(); return { x: t.left + t.width / 2, y: t.top + t.height / 2 }; })();

  const samples = [];
  let clone = null;
  try {
    firePointer('pointerdown', src, start);
    await sleep(HOLD_WAIT); // arm pickup (hold-timer path works for every consumer)
    // Step to the destination slowly enough that the 60ms-throttled dropIdx
    // updates commit along the way.
    for (let i = 1; i <= 4; i++) {
      firePointer('pointermove', window, {
        x: start.x + ((dest.x - start.x) * i) / 4,
        y: start.y + ((dest.y - start.y) * i) / 4,
      });
      await sleep(80);
    }
    clone = document.querySelector('body > .is-dragging');
    const cloneFace = clone?.querySelector('.candy-face') || null;

    // Frame sampler — runs from just before release until the clone leaves the
    // DOM (commit): clone rect (glide target), face translateY (press release),
    // bridge class (accent continuity through the glide).
    const sampler = (async () => {
      const deadline = performance.now() + glideMs + 800;
      while (clone?.isConnected && performance.now() < deadline) {
        const cr = clone.getBoundingClientRect();
        samples.push({
          top: cr.top,
          left: cr.left,
          faceY: cloneFace ? faceY(cloneFace) : 0,
          bridged: clone.classList.contains('is-drop-accent'),
        });
        await frame();
      }
    })();

    firePointer('pointerup', window, dest);
    await sampler;
    await sleep(60); // let the post-commit paint settle before measuring
  } finally {
    // If anything threw mid-drag, make sure the component isn't left dragging.
    firePointer('pointerup', window, dest);
  }

  // ── Measure ────────────────────────────────────────────────────────────────
  const bridgedWrapper = list.querySelector(':scope > .is-drop-accent');
  const landed = bridgedWrapper || src; // no-op default lands the source itself
  const lr = landed.getBoundingClientRect();
  const last = samples[samples.length - 1] || null;
  const axis = horizontal ? 'left' : 'top';
  const settleDelta = glideMs === 0 || !last ? null : Math.abs(last[axis] - lr[axis]);

  const depth = samples.reduce((m, s) => Math.max(m, s.faceY), 0);
  let maxFrameSnap = 0;
  for (let i = 1; i < samples.length; i++) {
    maxFrameSnap = Math.max(maxFrameSnap, Math.abs(samples[i].faceY - samples[i - 1].faceY));
  }
  const releaseSamples = samples.filter((s) => s.bridged);
  const face = landed.querySelector('.candy-face');
  const faceTransition = bridgedWrapper && face ? getComputedStyle(face).transitionProperty : null;

  const flags = [];
  if (glideMs > 0) {
    if (!bridgedWrapper) flags.push('NO BRIDGE: no .is-drop-accent on any tile at commit — accent blinks (cursor-off-tile drop is the one legit case)');
    if (settleDelta != null && settleDelta > TOL) flags.push(`SETTLE OFF ${settleDelta.toFixed(1)}px: clone glided to the wrong spot (one-flex-gap bug ≈ container gap)`);
    if (depth > 2 && releaseSamples.length && maxFrameSnap > depth * 0.6) flags.push(`PRESS SNAP: face jumped ${maxFrameSnap.toFixed(1)}px of ${depth.toFixed(1)}px depth in one frame (should ease over --cbtn-press-dur)`);
    if (depth > 2 && releaseSamples.length && Math.abs(releaseSamples[releaseSamples.length - 1].faceY) > TOL) flags.push('PRESS NOT RELEASED: face still pressed at commit');
    if (releaseSamples.length === 0) flags.push('NO GLIDE BRIDGE: clone never carried .is-drop-accent during the glide (accent gap mid-glide)');
  }
  if (bridgedWrapper && faceTransition && faceTransition !== 'transform') {
    flags.push(`FACE TRANSITION '${faceTransition}': bridge must transition transform ONLY (colour in the list = the fade flicker)`);
  }

  const report = {
    list: list.className || '[data-drag-list]',
    glideMs,
    frames: samples.length,
    settleDelta,
    depth,
    maxFrameSnap,
    bridgeOnTile: !!bridgedWrapper,
    faceTransition,
    flags,
    pass: flags.length === 0,
  };
  if (!quiet) {
    console.log(`[dragAudit] ${report.pass ? 'PASS' : 'FAIL'} — settleΔ ${settleDelta == null ? 'n/a' : settleDelta.toFixed(2) + 'px'}, press depth ${depth.toFixed(1)}px, max frame jump ${maxFrameSnap.toFixed(1)}px, bridge ${report.bridgeOnTile}, faceTransition ${faceTransition}`);
    for (const f of flags) console.warn('[dragAudit] ' + f);
  }
  return report;
}

export function startDragAudit() {
  window.dragAudit = dragAudit;
}

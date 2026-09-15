import { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { playReorderPickup, playReorderDrop } from '../hooks/useTactileSound.js';
import { computeSlotY } from './dragMath.js';
import { GLIDE, GLIDE_MS, GLIDE_TIMING } from '../util/motion.js';

// ── Drop-sequence invariants (the drop-flicker saga, 2026-07-01) ─────────────
// The drop is a multi-frame pipeline: clone glides to slot (glideMs) → commit
// (reorder + clone removal in one flushSync) → bridge (until the next real
// pointermove). Four invariants, each broken once before being written down:
//  1. ACCENT CONTINUITY — an accent-painted element sits under the cursor on
//     every painted frame: the clone (.is-dragging, → .is-drop-accent at glide
//     start) through the glide, then the bridged real tile (.is-drop-accent
//     via accentTileUnderCursor) after commit. :hover can't cover the swap (no
//     recompute without a real pointer move) and colour transitions must not
//     fade the restore in (the bridge CSS transitions transform ONLY). [997f927]
//  2. PRESS RELEASES ON THE CLONE — the real tile is never pressed, so the
//     clone eases its face up during the glide (the is-dragging →
//     is-drop-accent swap drops the pressed-face rule). A pressed clone
//     swapped for an unpressed tile is an instant snap. [251a0cf]
//  3. CLONE LANDS PIXEL-EXACT — computeSlotY (dragMath.js) must equal the
//     landed tile's real top INCLUDING the container's flex gap. Exhaustive
//     check: `npm run check-drag`; live: `window.dragAudit()`. [97612e8]
//  4. GLIDE TARGETS THE COMMITTED SLOT — dropIdx is pinned to `to` at release;
//     the mid-drag dropIdx is 60ms-throttled and can be one update stale. [97612e8]
// Touching this sequence or the candy tile CSS → run window.dragAudit() in the
// affected webview and paste its numbers (Close the Loop § browser-verify).

const HOLD_MS = 180;
// MOVE_THRESHOLD: cursor displacement (px) during the 180ms hold that aborts
// the long-press. Bumped from 6 to 10 in v0.7.4.3 — high-precision tap-to-click
// touchpads register tiny drift during a deliberate hold; the prior 6px window
// made the pill fail to lift on light holds (KI v0.7.0 + v0.7.3).
const MOVE_THRESHOLD = 10;
const GAP = 44;
const STATE_THROTTLE = 60;
// SHIFT_THRESHOLD_FRACTION: how far into a stationary module (from its top) the
// cursor must travel before items shift to open the next slot. 0.5 = midpoint
// (legacy). 0.2 = items shift when cursor is 20% past module top — clone
// spends less time visibly overlapping a stationary item. The first non-source
// item keeps a midpoint trigger so dropping at the top of the rail stays
// reachable inside its bounds.
const SHIFT_THRESHOLD_FRACTION = 0.2;

function PlainDragTile({ sourceElement, originRect, originDisplay, cursorRef, slotY, slotXY = null, isHorizontal = false, isGrid = false, releasing = false, glideMs = 160, containerRef, grow = false }) {
  const hostRef = useRef(null);
  const cloneRef = useRef(null);
  const modeRef = useRef('slot-snap');
  // Where the clone is written. Grid uses left/top; every other consumer keeps
  // the transform it shipped with.
  //
  // A transform puts the clone on its own compositing layer, and a layer at a
  // FRACTIONAL y gets snapped to a whole device pixel. The chips rest at 341.2,
  // so the clone painted exactly 1px low for the whole drag and jumped back on
  // the drop — read off a 31-frame burst (top edge row 18 vs 17, bottom 46 vs
  // 45). Compositing alone isn't the culprit: the neighbours carry
  // translate3d(0,0,0), also a layer, at an INTEGER offset and never shift.
  // left/top is laid out, so it rounds exactly like the resting chip does.
  const place = (el, x, y) => {
    if (isGrid) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
    else el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  // Flipped true when the parent enters its release phase on drop. The
  // cursor-mode RAF reads this each frame and bails so its writes don't
  // fight the CSS transition that animates the clone into its final slot.
  const releaseRef = useRef(false);
  // Resting (content) height of the list container captured at lift, so the
  // drop-release effect can animate the grow-to-contain min-height back down.
  const growBaseRef = useRef(0);

  // useLayoutEffect (not useEffect) so the clone is inserted into the DOM
  // synchronously after React's commit, BEFORE the browser paints. Otherwise
  // there's a one-paint gap where the source slot has gone display:none
  // (causing adjacent slots to reflow upward) but the floating clone hasn't
  // appeared yet — visible as a "split second" jump of neighboring tiles.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!sourceElement || !host) return undefined;

    // Read the drag-tile-follow mode at lift time. Mid-drag mode changes are
    // ignored — the next drag picks up the new mode. Three modes:
    //   'off'       — clone parks at origin (gap-stays-at-source covers it)
    //   'cursor'    — clone anchors at the rail origin; cursor delta from the
    //                 lift point translates it on the active axis (no jump
    //                 to cursor center on pickup)
    //   'slot-snap' — clone snaps to slot with a 160ms CSS transition
    // Absent attr defaults to 'cursor' (matches ANIMATION_KEY_CONFIG in useSettings).
    //
    // A grid is ALWAYS 'slot-snap', whatever the setting says: its chips live in
    // a rail of fixed slots, so the lifted one steps between those slots — up,
    // down, left, right — instead of floating free under the cursor. The mode is
    // part of what a grid IS, not a preference about it.
    //
    // So is a horizontal strip — the dock, its only consumer (user-directed
    // 2026-09-13: the dock drag must read as the playlist/micros drag). Its
    // buttons are a fixed run of slots for the same reason, so the same rule
    // applies. The setting keeps governing the vertical rails (right sidebar,
    // overlay panel), which is what its own description already scopes it to.
    const mode = (isGrid || isHorizontal)
      ? 'slot-snap'
      : (document.body?.getAttribute('data-anim-drag-tile-follow') || 'cursor');
    modeRef.current = mode;

    const clone = sourceElement.cloneNode(true);
    // The source slot uses visibility:hidden during drag to preserve its
    // layout space (see items.map). cloneNode copies inline styles, so the
    // clone would inherit visibility:hidden and be invisible — force it
    // visible on the clone itself.
    clone.style.visibility = 'visible';
    // The source slot also runs the `drag-source-collapse` keyframe to shrink
    // its height to 0 over 160ms (so flex-weighted siblings grow smoothly
    // into the freed space). cloneNode copies the triggering data attribute
    // and the from-height CSS variable, so without these resets the clone
    // would ALSO collapse to height 0 mid-pickup and vanish.
    clone.removeAttribute('data-dragsrc-collapsing');
    clone.style.removeProperty('--drag-source-from-h');
    // The global press-hold (useTactileSound) marks the button data-candy-pressed
    // on pointerdown and keeps it there while the pointer is down — so a chip
    // lifted by a HOLD is mid-press at lift, and cloneNode copies that. A grid
    // chip — and a dock button — has to read exactly like its neighbours while it
    // travels, so drop the press on the clone. (A VERTICAL rail tile keeps it: its
    // pressed face during the drag is deliberate, and the drop sequence's
    // invariant 2 eases it back up on the landing glide.)
    // The mark sits on the .candy-btn INSIDE this wrapper, not on the wrapper,
    // so strip it from the subtree (and from the root, for a bare-button item).
    // Stripped one FRAME after the clone paints, not before it: cleared up
    // front there is no pressed state to transition FROM, so the face teleports
    // up at lift. Painting pressed once lets .candy-face's own 150ms ease-out
    // carry it back up while the chip travels.
    const releaseClonePress = () => {
      for (const el of [clone, ...clone.querySelectorAll('[data-candy-pressed], .is-pressed')]) {
        el.removeAttribute('data-candy-pressed');
        el.classList.remove('is-pressed');
      }
    };
    // Mark the clone so per-tile CSS can keep the press-depth look during
    // drag (the original element loses :active the moment the clone takes
    // over the pointer). E.g. `.rail-tile.is-dragging` collapses
    // its box-shadow to mimic the pressed state.
    clone.classList.add('is-dragging');
    // Axis-aware initial position. `slotY` holds the slot coordinate on the
    // active axis (Y for vertical, X for horizontal) — same prop name kept
    // for backwards compatibility with the parent's computeSlot call.
    let initialPos;
    if (mode === 'off') {
      initialPos = isHorizontal ? originRect.left : originRect.top;
    } else if (mode === 'cursor') {
      // Tile stays where it was lifted; the RAF loop below translates it
      // by the cursor delta from this anchor.
      initialPos = isHorizontal ? originRect.left : originRect.top;
    } else {
      const fallback = isHorizontal ? originRect.left : originRect.top;
      initialPos = (typeof slotY === 'number' && !isNaN(slotY)) ? slotY : fallback;
    }
    const initialX = slotXY ? slotXY.x : (isHorizontal ? initialPos : originRect.left);
    const initialY = slotXY ? slotXY.y : (isHorizontal ? originRect.top : initialPos);
    Object.assign(clone.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: originRect.width + 'px',
      height: originRect.height + 'px',
      margin: '0',
      pointerEvents: 'none',
      zIndex: '9999',
      cursor: 'grabbing',
      transition: 'none',
      opacity: '1',
      display: originDisplay || 'block',
      // Vertical: X anchors to source column (modules stay locked to rail).
      // Horizontal: Y anchors to source row (dock buttons stay on the bar).
      // Active-axis position depends on the drag mode.
      transform: isGrid ? 'none' : `translate3d(${initialX}px, ${initialY}px, 0)`,
    });
    place(clone, initialX, initialY);
    // Portal the clone to <body> rather than the in-tree host. The clone is
    // position:fixed and positioned with viewport coords (getBoundingClientRect).
    // If ANY ancestor of the host has a transform, that ancestor — not the
    // viewport — becomes the containing block for the fixed clone (CSS Transforms
    // spec), throwing it ~a full viewport off-screen. The dock's `.dock-pos` uses
    // translateX(-50%) and `.dock-root` ends its show-animation on a transform,
    // which is exactly why the dock clone went invisible while the (untransformed)
    // right sidebar worked. <body> has no transformed ancestor, so fixed ==
    // viewport again; theme vars live on :root/body so the clone still inherits them.
    document.body.appendChild(clone);
    // Let the pressed face paint ONE frame, then release it (see releaseClonePress).
    if (isGrid || isHorizontal) requestAnimationFrame(releaseClonePress);
    // Portalling to <body> leaves the surface's styling scope behind, so the chip
    // inside the clone loses the 2.5px lift the resting chip has and paints 3px
    // taller — it comes back up BELOW where it started (measured 2026-09-02: the
    // resting chip's box top is 341.2, the clone's 343.7). Copying the scope's
    // custom properties across was tried and changed NOTHING, so the difference
    // is a scoped RULE, not a variable. Rather than chase which rule, pin the
    // clone's chip to the geometry the real one actually has — read off the live
    // resting element at lift, so it stays right whatever the scope does.
    // (Grid only: the dock and sidebar clones are signed off as they are.)
    if (isGrid) {
      const srcBtn = sourceElement.querySelector('.candy-btn');
      const cloneBtn = clone.querySelector('.candy-btn');
      if (srcBtn && cloneBtn) {
        const br = srcBtn.getBoundingClientRect();
        cloneBtn.style.position = 'relative';
        cloneBtn.style.top = `${br.top - originRect.top}px`;
        cloneBtn.style.height = `${br.height}px`;
      }
    }
    cloneRef.current = clone;

    let rafId = null;
    let cancelled = false;
    // Hoisted so the cleanup below can reset them (assigned in the cursor branch).
    // growEl = the list container (grows to contain the tile); cardEl = its parent
    // .candy-card (pulled up so the panel can grow from the TOP too).
    let growEl = null;
    let cardEl = null;
    if (mode === 'cursor') {
      // Capture cursor at lift time. The tile starts at its rail origin and
      // chases the cursor delta with exponential smoothing, closing a fixed
      // fraction of the gap each frame so it slides through the rail with
      // weight. CHASE_RATE was the 'drag-tile-smoothness' setting until
      // 2026-08-13; the setting is gone (one motion, no per-drag knobs) and
      // 0.18 is what 'medium' was — the value the feature shipped with.
      // ponytail: this is exponential decay, NOT the app glide's fixed-duration
      // curve. Matching it exactly means restarting a tween per pointer move,
      // which tangles with the rubber-band and grow-to-contain maths in this
      // same loop. Left alone deliberately; see the motion-unification plan.
      const ic = { x: cursorRef.current.x, y: cursorRef.current.y };
      const CHASE_RATE = 0.18;
      // Rubber-band bounds: keep the tile inside its list container. The container
      // doesn't move during a pointer drag, so measure it once. Past an edge only R
      // of the overage passes to the target, so the tile resists leaving the panel
      // and the release glide springs it back to a valid slot.
      // ponytail: if a tile is taller than its container, min > max and the clamp
      // just pins it to the top/left edge — fine for these short lists.
      const cb = containerRef?.current?.getBoundingClientRect();
      // Grow-to-contain (vertical only): the content-height card grows to keep the
      // dragged tile inside it, in the direction of drag, with exponential resistance
      // on the stretch (below). Bottom: grow the list min-height (card extends down,
      // Studio fixed). Top: pad the list top + pull the card up by the same amount, so
      // the top edge (Studio) rises while the tiles and card bottom stay put — a true
      // mirror of the bottom, with Studio always above the tile.
      growEl = (grow && !isHorizontal && cb) ? (containerRef?.current || null) : null;
      cardEl = growEl ? growEl.parentElement : null;
      const baseH = cb ? cb.height : 0;
      growBaseRef.current = baseH;
      let curX = originRect.left;
      let curY = originRect.top;
      const loop = () => {
        if (cancelled || releaseRef.current) return;
        const c = cursorRef.current;
        let targetX = isHorizontal ? originRect.left + (c.x - ic.x) : originRect.left;
        let targetY = isHorizontal ? originRect.top : originRect.top + (c.y - ic.y);
        if (isHorizontal) {
          // Dock: unchanged linear rubber-band both edges.
          if (cb) {
            const RH = 0.18;
            const min = cb.left, max = cb.right - originRect.width;
            if (targetX < min) targetX = min - (min - targetX) * RH;
            else if (targetX > max) targetX = max + (targetX - max) * RH;
          }
        } else if (cb && grow) {
          // Overlay (growToContain): inside the panel the tile follows freely; past
          // either PANEL edge it stretches the card with exponential resistance —
          // d = C·(1−e^(−x/C)): ~1:1 just past the edge, asymptotic to C px far out
          // (firm, hard cap). The card then grows to contain the tile at that resisted
          // position (below), so a tile never leaves the panel — the panel expands.
          // ponytail: C=80 is the "firm" feel; raise for looser, lower for a harder wall.
          const EDGE_GIVE = 80;
          const resist = (x) => EDGE_GIVE * (1 - Math.exp(-x / EDGE_GIVE));
          const tileBottom = targetY + originRect.height;
          if (tileBottom > cb.bottom) targetY = cb.bottom - originRect.height + resist(tileBottom - cb.bottom);
          else if (targetY < cb.top)  targetY = cb.top - resist(cb.top - targetY);
        } else if (cb) {
          // Non-grow vertical consumers (right sidebar): original linear rubber-band
          // both edges, no card growth — unchanged from before the overlay grow.
          const R = 0.18;
          const min = cb.top, max = cb.bottom - originRect.height;
          if (targetY < min) targetY = min - (min - targetY) * R;
          else if (targetY > max) targetY = max + (targetY - max) * R;
        }
        curX += (targetX - curX) * CHASE_RATE;
        curY += (targetY - curY) * CHASE_RATE;
        if (growEl) {
          // Grow the card to contain the (resisted) tile position — instant follow, no
          // transition during drag. Bottom → min-height (card extends down). Top → list
          // padding-top + an equal upward pull on the card, so the top edge (Studio)
          // rises while the tiles and card bottom stay fixed. The two are mutually
          // exclusive (a tile drags up OR down), so they never fight.
          const overBottom = Math.max(0, (curY + originRect.height) - cb.bottom);
          const overTop = Math.max(0, cb.top - curY);
          growEl.style.minHeight = overBottom > 0 ? `${baseH + overBottom}px` : '';
          growEl.style.paddingTop = overTop > 0 ? `${overTop}px` : '';
          if (cardEl) cardEl.style.marginTop = overTop > 0 ? `${-overTop}px` : '';
        }
        clone.style.transform = `translate3d(${curX}px, ${curY}px, 0)`;
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    } else if (mode === 'slot-snap' && isHorizontal) {
      // The dock WIDENS the button under the pointer into icon+label, and drops
      // that width again when a drag starts — as a 240ms animation. So at lift the
      // whole row is still in motion and every rect taken above is of a layout
      // that no longer exists a frame later: the clone was stamped at the wide
      // size, kept it, and overlapped its neighbour while the real row slid back
      // underneath (photographed 2026-09-13: grabbed button 123px → 97 → 36, its
      // neighbours 668 → 681 → 712, the clone frozen at 123).
      //
      // So don't predict the settled size — MIRROR the source's live box every
      // frame until it stops changing. The carried copy shrinks into its icon
      // square exactly as the real slot does, and because both are left-anchored
      // the glyph never moves. Slot-snap takes over once the row is still.
      const srcInner = sourceElement.querySelector('.candy-btn');
      const cloneInner = clone.querySelector('.candy-btn');
      // The face's layout is SCOPED (the dock packs its glyph and label left and
      // clips the overflow). Portalled to <body> that scope is gone, the hidden
      // label claims its width again, and the glyph is shoved out of its own box
      // — 37px left of the copy's left edge, measured 2026-09-13. Copy the live
      // face's layout across rather than naming any of the rules.
      const srcFace = sourceElement.querySelector('.candy-face');
      const cloneFace = clone.querySelector('.candy-face');
      if (srcFace && cloneFace) {
        const cs = window.getComputedStyle(srcFace);
        for (const k of ['justifyContent', 'alignItems', 'gap', 'padding', 'overflow']) {
          cloneFace.style[k] = cs[k];
        }
      }
      let stable = 0, lastW = -1;
      const track = () => {
        if (cancelled || releaseRef.current) return;
        const r = sourceElement.getBoundingClientRect();
        clone.style.width = `${r.width}px`;
        // Pin the copy's own button to the real one's box. Portalled to <body> the
        // clone loses the dock's scoped rules, which painted its glyph 37px
        // outside its own left edge (measured: clone box 760.5, glyph 723.2).
        if (srcInner && cloneInner) {
          const ir = srcInner.getBoundingClientRect();
          cloneInner.style.position = 'relative';
          cloneInner.style.left = `${ir.left - r.left}px`;
          cloneInner.style.top = `${ir.top - r.top}px`;
          cloneInner.style.width = `${ir.width}px`;
          cloneInner.style.height = `${ir.height}px`;
        }
        place(clone, r.left, r.top);
        if (Math.abs(r.width - lastW) < 0.5) stable++; else stable = 0;
        lastW = r.width;
        if (stable < 3) { rafId = requestAnimationFrame(track); return; }
        rafId = null;
        void clone.offsetWidth;
        clone.style.transition = `transform ${GLIDE}`;
      };
      rafId = requestAnimationFrame(track);
    } else if (mode === 'slot-snap') {
      // Force a reflow so the initial transform commits with transition: none,
      // then enable the 160ms transition for subsequent slot updates. Without
      // the reflow, the browser may batch the transition switch with the initial
      // transform and animate from (0, 0) to the first slot on mount.
      void clone.offsetWidth;
      clone.style.transition = isGrid ? `left ${GLIDE}, top ${GLIDE}` : `transform ${GLIDE}`;
    }

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      try { clone.remove(); } catch { /* already removed */ }
      cloneRef.current = null;
      // Drop the grow-to-contain overrides so the container + card return to rest
      // (only touched when we actually grew — never stomps a consumer's own styles).
      if (growEl) { growEl.style.minHeight = ''; growEl.style.paddingTop = ''; growEl.style.transition = ''; }
      if (cardEl) { cardEl.style.marginTop = ''; cardEl.style.transition = ''; }
    };
  }, [sourceElement, originRect.left, originRect.top, originRect.width, originRect.height, originDisplay, cursorRef, isHorizontal, isGrid]); // eslint-disable-line react-hooks/exhaustive-deps -- slotXY is the LIFT-time slot here; later slots ride the effect below

  // Slot-snap mode: update transform when slot changes; CSS transition animates.
  // Gated on modeRef (captured at mount) so cursor-mode RAF writes aren't fought.
  useEffect(() => {
    const clone = cloneRef.current;
    if (!clone || modeRef.current !== 'slot-snap') return;
    const cx = slotXY ? slotXY.x : (isHorizontal ? slotY : originRect.left);
    const cy = slotXY ? slotXY.y : (isHorizontal ? originRect.top : slotY);
    place(clone, cx, cy);
  }, [originRect.left, originRect.top, slotY, slotXY, isHorizontal]);

  // Drop-release animation. The parent's onUp two-phase flow flips
  // `releasing` true on drop, keeps dragState alive for one transition cycle
  // (source stays hidden, gap stays open), then clears it. We ride that
  // window to (1) stop the cursor RAF, (2) animate the clone into the final
  // slot position via CSS transition, and (3) drop the `is-dragging` class
  // so .rail-tile's own 150ms transitions on transform+box-shadow
  // animate the press release. Without this, the clone is destroyed the
  // frame after drop and the press-up animation is never visible.
  useEffect(() => {
    const clone = cloneRef.current;
    if (!clone || !releasing) return;
    releaseRef.current = true;
    const cx = slotXY ? slotXY.x : (isHorizontal ? slotY : originRect.left);
    const cy = slotXY ? slotXY.y : (isHorizontal ? originRect.top : slotY);
    // Cursor-mode clones run with transition: 'none' during drag (RAF writes
    // the transform every frame). Switching to '160ms' AND changing transform
    // in the same JS task makes the browser batch both writes and skip the
    // transition — the clone snaps to slot instead of gliding. Force a reflow
    // between the two so the new transition rule is committed before the
    // transform delta is computed. Same pattern the slot-snap init uses at
    // mount (search for `void clone.offsetWidth`).
    const glide = `${glideMs}ms ${GLIDE_TIMING}`;
    clone.style.transition = isGrid ? `left ${glide}, top ${glide}` : `transform ${glide}`;
    void clone.offsetWidth;
    place(clone, cx, cy);
    // Swap is-dragging → is-drop-accent for the glide. The bridge class carries
    // the same accent (band + face flood, both tile types) but NOT the pressed
    // face transform, so the face eases back up over --cbtn-press-dur during
    // the glide — the same release a normal click shows. History: removing
    // is-dragging bare killed the accent mid-glide (the old flicker), so
    // dca4b97 kept it through the whole glide — which made the swap-to-source
    // an instant pressed→unpressed SNAP. The bridge class is the missing third
    // state: accent yes, press no. (Its CSS keeps the transform transition
    // alive and only strips the colour transitions — see styles.css.)
    clone.classList.remove('is-dragging');
    // …and only while the cursor is actually ON the clone. The glide used to keep
    // the accent unconditionally, so dropping and moving away left an accent chip
    // flying to its slot with the pointer nowhere near it — a fixed 267ms of glow
    // after the mouse had gone (photographed 2026-09-03: the frames show the lit
    // chip CHANGING POSITION, which only the clone does). Four earlier fixes
    // rewrote the post-commit bridge instead and changed nothing, because the
    // bridge was never the thing still lit. The clone's rect MOVES for the whole
    // flight, so hit-test its LIVE rect on every pointermove — a comparison
    // against the release point goes stale on the first frame.
    const syncLit = (ev) => {
      const r = clone.getBoundingClientRect();
      const x = ev ? ev.clientX : cursorRef.current.x;
      const y = ev ? ev.clientY : cursorRef.current.y;
      const on = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      clone.classList.toggle('is-drop-accent', on);
      clone.classList.toggle('is-drop-glide', !on);
    };
    syncLit(null);
    window.addEventListener('pointermove', syncLit);
    // Snap the grown card back to content height over the same glide, so the card
    // shrink and the clone settle finish together (transition to the captured
    // resting px, not '' — an auto/none target won't animate).
    const gc = containerRef?.current;
    if (gc && (gc.style.minHeight || gc.style.paddingTop)) {
      const ease = `${glideMs}ms ${GLIDE_TIMING}`;
      gc.style.transition = `min-height ${ease}, padding-top ${ease}`;
      if (gc.style.minHeight) gc.style.minHeight = `${growBaseRef.current}px`;
      const card = gc.parentElement;
      if (gc.style.paddingTop) {
        gc.style.paddingTop = '0px';
        if (card) { card.style.transition = `margin-top ${ease}`; card.style.marginTop = '0px'; }
      }
      // ...then DROP the overrides once the glide is over, so the container goes
      // back to whatever its owner renders. Without this the inline values stay
      // forever: this branch is not gated on `grow`, so any rail that has grown
      // once keeps `padding-top: 0px` and a pinned `min-height` for the life of
      // the window. Found 2026-09-14 as a fossil on the right widget rail — it
      // was overriding AppShell's paddingTop:7 and eating 7px of the gap above
      // the first tile, which is why the three rail gaps read 6 / 13 / 7.
      //
      // ponytail: fire-and-forget timer, deliberately NOT cancelled on unmount —
      // the clone unmounts AT the glide end, so cancelling there is what would
      // leave the styles stuck. A drag starting inside the same glideMs has its
      // own RAF rewriting these every frame, so a stray wipe self-corrects on the
      // next frame. Swap to a transitionend listener if that ever stops holding.
      setTimeout(() => {
        gc.style.minHeight = '';
        gc.style.paddingTop = '';
        gc.style.transition = '';
        if (card) { card.style.marginTop = ''; card.style.transition = ''; }
      }, glideMs);
    }
    return () => window.removeEventListener('pointermove', syncLit);
  }, [releasing, slotY, slotXY, originRect.left, originRect.top, isHorizontal, glideMs, containerRef, cursorRef]);

  return (
    <div
      ref={hostRef}
      aria-hidden
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />
  );
}

export default function DraggableSidebarList({
  items,
  renderItem,
  onReorder,
  direction = 'vertical',
  enabled = true,
  dragFromInteractive = false,
  onDragActiveChange,
  gapSize: gapSizeProp = GAP,
  keyExtractor = (item, i) => item.key ?? i,
  getItemStyle,
  // Opt-in edge-snap (the dock passes { triggerPx, centerIndex }; null elsewhere
  // so every sidebar consumer is byte-identical). On release, a drop near the
  // bar's left edge / centre / right edge snaps into that magnet zone.
  snapZones = null,
  // Opt-in grow-to-contain (the overlay panel passes it): past a panel edge the
  // card expands to keep the dragged tile inside, with exponential resistance.
  // Off elsewhere (dock/right sidebar) so their drag geometry is unchanged.
  growToContain = false,
  className,
  style,
}) {
  const containerRef = useRef(null);
  const itemRefs = useRef([]);
  const [dragState, setDragState] = useState(null);

  const dRef = useRef(null);
  const lastStateRef = useRef(0);
  const mouseRef = useRef({ x: 0, y: 0 });
  const holdTimerRef = useRef(null);
  // Set true on a real drag release so the wrapper's capture-phase click
  // handler swallows the synthetic click that follows pointerup (keeps a
  // hold-drag from also firing the item's onClick, e.g. dock nav buttons).
  const suppressClickRef = useRef(false);
  // Holds the { el, clearOnMove } for the transient post-drop forced accent
  // (see forceDropAccent). null when no drop-accent is active.
  const dropAccentRef = useRef(null);

  // Axis configuration — vertical (default) keeps the legacy sidebar behavior;
  // horizontal swaps to X-based threshold checks and marginLeft/Right gap.
  //
  // 'grid' is a WRAPPING run: still one flat order, but laid out over several
  // lines, so a slot is picked in READING order (both axes) instead of on one
  // coordinate. It also drops the margin/collapse choreography entirely — in a
  // wrapping container, opening a margin or collapsing the source re-flows the
  // wrap and chips jump between lines. The others slide with `transform`
  // instead, which never touches layout.
  const isGrid = direction === 'grid';
  const isHorizontal = direction === 'horizontal';
  const axis        = isHorizontal ? 'x'           : 'y';
  const sizeProp    = isHorizontal ? 'width'       : 'height';
  const startProp   = isHorizontal ? 'left'        : 'top';
  const marginStart = isHorizontal ? 'marginLeft'  : 'marginTop';
  const marginEnd   = isHorizontal ? 'marginRight' : 'marginBottom';

  const clearHold = useCallback(() => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
  }, []);

  // Remove the transient post-drop accent + its one-shot listener.
  const clearDropAccent = useCallback(() => {
    const d = dropAccentRef.current;
    if (!d) return;
    window.removeEventListener('pointermove', d.clearOnMove);
    dropAccentRef.current = null;
    // Taking the class off used to hand the face its normal 150ms background
    // transition back, easing the accent to grey once the pointer had left. This
    // used to force `transition: none` on the base, face and label spans, drop
    // the class, reflow, then restore on the next frame — and it never helped:
    // it fires on the FIRST pointermove, which is usually still ON the tile, so
    // it spent its snap on a frame where :hover was holding the colour steady
    // anyway (measured 2026-09-03: class gone at t+0, :hover not lost until
    // t+46ms, fade only then). A styles.css rule that snapped the accent out with
    // no fade at all was tried and removed 2026-09-04 — user-directed: the
    // accent leaves on the same 150ms fade as every other candy button.
    d.el.classList.remove('is-drop-accent');
  }, []);

  // Force the transient post-drop accent onto wrapper `el`; cleared on the next
  // real pointermove (when :hover takes back over). See accentTileUnderCursor.
  const forceDropAccent = useCallback((el) => {
    if (!el) return;
    clearDropAccent();
    el.classList.add('is-drop-accent');
    const clearOnMove = () => clearDropAccent();
    dropAccentRef.current = { el, clearOnMove };
    window.addEventListener('pointermove', clearOnMove);
  }, [clearDropAccent]);

  // Bridge the :hover gap on drop. The drag clone carried the accent through the
  // glide; when it's removed and the reordered tiles reappear under a STILL cursor,
  // the browser won't recompute :hover without a real pointer move, so the accent
  // would blink off. Hit-test the ACTUAL tile under the cursor (elementFromPoint)
  // rather than assume the dragged tile lands there — React re-inserts the dragged
  // node on a downward reorder but the displaced sibling on an upward one, so the
  // tile under the cursor isn't always the one dragged (the up-only flash). Caller
  // must have committed the reorder synchronously (flushSync) so this reads the new
  // order. (memory: ":hover needs a real pointer move".)
  const accentTileUnderCursor = useCallback(() => {
    const { x, y } = mouseRef.current;
    const hit = document.elementFromPoint(x, y);
    const wrapper = hit ? itemRefs.current.find(w => w && w.contains(hit)) : null;
    forceDropAccent(wrapper || null);
  }, [forceDropAccent]);

  const cleanup = useCallback(() => {
    clearHold();
    clearDropAccent();
    itemRefs.current.forEach(el => { if (el) el.style.pointerEvents = ''; });
    dRef.current = null;
    setDragState(null);
    // The release point rides along: a surface whose hover state was suspended for the
    // drag needs to know where the pointer ACTUALLY is to resume, not assume "nowhere".
    onDragActiveChange?.(false, mouseRef.current);
  }, [clearHold, clearDropAccent, onDragActiveChange]);

  useEffect(() => cleanup, [cleanup]);

  // ── Compute drop index from current mouse coord and item rects ────────────
  // The dragged item is `display: none` during drag, so its rect is zero —
  // skip it and iterate the remaining items in original-index order. Returns
  // the original-array index, which is what `onReorder(from, to)` expects.
  // Coordinate axis is selected by `direction` (Y for vertical, X for horizontal).
  const calcDropIndex = useCallback(() => {
    const draggedIdx = dRef.current?.idx;
    const els = itemRefs.current;
    if (isGrid || (isHorizontal && dRef.current?.slots)) {
      // NEAREST SLOT, not reading order. Every candidate drop lands the chip on
      // exactly one resting slot (measured at lift), so pick the slot whose
      // centre is closest to the cursor — the chip goes where the cursor IS.
      //
      // Reading order ("first item the cursor sits before") had two seams that
      // each threw the chip sideways on a few px of vertical wobble: the row gap
      // between two lines matched no item's band, so x was ignored there and the
      // slot snapped to the START of the next line; and past the last chip on a
      // line the next slot in order is that next line's first one, so the chip
      // jumped a column while the cursor only moved down. Distance to a real
      // slot has neither seam and needs no dead-band tuning.
      const slots = dRef.current?.slots;
      const or = dRef.current?.originRect;
      if (!slots || !or) return draggedIdx ?? els.length;
      const { x, y } = mouseRef.current;
      let best = draggedIdx ?? 0;
      let bestD = Infinity;
      for (let s = 0; s < slots.length; s++) {
        const dx = x - (slots[s].x + or.width / 2);
        const dy = y - (slots[s].y + or.height / 2);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = s; }
      }
      // Inverse of gridLanding's mapping: dropIdx <= idx lands on slot dropIdx,
      // dropIdx > idx lands on dropIdx − 1. best === draggedIdx is the no-op.
      //
      // The no-op has TWO spellings — idx and idx + 1 — and on a margin-spaced
      // run only the second one renders the hole at the source's own position
      // (the first opens no gap anywhere, so the row closes up and everything
      // past the source jumps a slot on the first pixel of movement). The grid
      // slides its chips instead of opening margins, so it never had to care.
      if (best === draggedIdx) return draggedIdx + 1;
      return best <= draggedIdx ? best : best + 1;
    }
    // The scan below claims a slot once the cursor is SHIFT_THRESHOLD_FRACTION
    // into it, counting from the left/top — which is not the same distance in
    // both directions. Measured on the dock 2026-09-14: 36px of travel to step
    // right, 58px to step left. Only the vertical rails still run it; the dock
    // takes the nearest-slot branch above, where each direction is half a slot.
    const coord = mouseRef.current[axis];
    let firstNonSourceSeen = false;
    for (let i = 0; i < els.length; i++) {
      if (i === draggedIdx) continue;
      const el = els[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r[sizeProp] === 0) continue;
      const offsetFraction = firstNonSourceSeen ? SHIFT_THRESHOLD_FRACTION : 0.5;
      firstNonSourceSeen = true;
      const threshold = r[startProp] + offsetFraction * r[sizeProp];
      if (coord < threshold) return i;
    }
    return els.length;
  }, [axis, sizeProp, startProp, isGrid, isHorizontal]);

  // Edge-snap (opt-in via `snapZones`, horizontal only). On release, if the
  // cursor is within triggerPx of the bar's left edge, centre, or right edge,
  // return that zone's drop index instead of the rect-midpoint slot; null = no
  // zone hit (fall back to calcDropIndex). Measured against the CONTAINER, so a
  // wide flex:1 spacer never skews it.
  const calcSnapIndex = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;
    const cr = container.getBoundingClientRect();
    const x = mouseRef.current.x;
    const t = snapZones?.triggerPx ?? 48;
    if (x <= cr.left + t) return 0;
    if (x >= cr.right - t) return items.length;
    const mid = (cr.left + cr.right) / 2;
    if (Math.abs(x - mid) <= t) {
      return snapZones?.centerIndex != null ? snapZones.centerIndex : Math.floor(items.length / 2);
    }
    return null;
  }, [snapZones, items]);

  // ── Window move ────────────────────────────────────────────────────────────
  const onMove = useCallback((e) => {
    const drag = dRef.current;
    if (!drag) return;
    if (drag.phase === 'hold') {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_THRESHOLD) {
        clearHold();
        if (dragFromInteractive) {
          // Dock: a move during the hold cancels (keeps tap=nav; a deliberate still
          // hold is the drag intent). Unchanged.
          dRef.current = null;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onAbort);
          window.removeEventListener('blur', onAbort);
        } else {
          // Reorder lists (overlay / right sidebar): movement STARTS the drag right
          // away — no need to wait out the hold timer / full press-down. beginDrag
          // flips dRef to 'drag' and the existing listeners carry the rest.
          beginDrag(drag.idx, itemRefs.current[drag.idx]?.getBoundingClientRect(), e.clientX, e.clientY);
        }
      }
      return;
    }
    if (drag.phase === 'drag') {
      e.preventDefault();
      mouseRef.current = { x: e.clientX, y: e.clientY };

      // Throttled React state update for drop-zone gap
      const now = performance.now();
      if (now - lastStateRef.current > STATE_THROTTLE) {
        lastStateRef.current = now;
        const dropIdx = calcDropIndex();
        setDragState(prev => {
          if (!prev || prev.dropIdx === dropIdx) return prev;
          return { ...prev, dropIdx };
        });
      }
    }
    // beginDrag is referenced in the hold branch but intentionally omitted from deps
    // (defined below; captured by closure like onUp — reading it at call time is safe).
  }, [clearHold, calcDropIndex, dragFromInteractive]);

  // ── Window up ────────────────────────────────────────────────────────────
  const onUp = useCallback((e) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onAbort);
    window.removeEventListener('blur', onAbort);
    const drag = dRef.current;
    if (!drag) return;
    clearHold();

    if (drag.phase === 'hold') {
      dRef.current = null;
      return;
    }

    if (drag.phase === 'drag') {
      e.preventDefault();
      // True release point — the last pointermove can lag it by one event, and
      // the post-drop accent hit-test (accentTileUnderCursor) reads these coords
      // ~160ms later. calcDropIndex below reads them too, so both use the same
      // ground truth.
      mouseRef.current = { x: e.clientX, y: e.clientY };
      // A real lift occurred (not a tap). Swallow the synthetic click the
      // browser fires after pointerup so a hold-drag — even one with no net
      // index change — never also triggers the item's onClick (e.g. a dock
      // button that would navigate/open a modal). Cleared next tick so it
      // never eats a later genuine click.
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);

      let to = calcDropIndex();
      if (snapZones && isHorizontal) {
        const snapped = calcSnapIndex();
        if (snapped != null) to = snapped;
      }
      const from = drag.idx;
      playReorderDrop();

      // The drop glide is the app's ONE glide now — the 'drag-drop-glide'
      // speed bucket was deleted 2026-08-13 (user-directed: one motion, no
      // per-drag knobs), so this is no longer a setting to read. Its 'off'
      // value took a whole second code path (synchronous cleanup, no release
      // animation at all); that path went with it, since GLIDE_MS is never 0.
      const glideMs = GLIDE_MS;

      // Two-phase release. Phase 1 (now): clear listeners + dRef but keep
      // dragState alive with `releasing: true` so the source slot stays
      // hidden and the gap stays open. PlainDragTile responds by animating
      // the clone into the final slot and dropping the `is-dragging` class
      // (the inner tile's 150ms transitions on transform+box-shadow animate
      // the press release). Phase 2 (after glideMs): clear dragState and
      // fire onReorder in one render, so the source reappears at its new
      // slot exactly when the clone vanishes.
      clearHold();
      itemRefs.current.forEach(el => { if (el) el.style.pointerEvents = ''; });
      dRef.current = null;
      // Pin dropIdx to the slot the drop actually commits to. The throttled
      // (60ms) move handler can leave dragState.dropIdx one update stale at
      // release, in which case the clone would glide to the OLD slot and then
      // snap to the real one when the source appears.
      setDragState(prev => prev ? { ...prev, dropIdx: to, releasing: true, glideMs } : null);

      // Keep tracking the pointer through the glide. The accent bridge below
      // hit-tests mouseRef, and without this it would still hold the RELEASE
      // point: a pointer that moved during the 160ms got a tile lit where it no
      // longer was, and — since forceDropAccent's clearing listener is only
      // registered at commit, after that move — nothing ever put it out
      // (reproduced 2026-09-03: still .is-drop-accent 1200ms after the pointer
      // parked at 60,60). Tracking rather than a moved/not-moved flag, because
      // skipping the bridge on ANY movement leaves the tile under a pointer that
      // moved and stopped on it un-accented until the next move — a flicker on
      // exactly the drop-and-stay-put gesture. The rule is simply: light what
      // the cursor is over at commit, and nothing when it is over nothing.
      const trackMove = (ev) => { mouseRef.current = { x: ev.clientX, y: ev.clientY }; };
      window.addEventListener('pointermove', trackMove);

      setTimeout(() => {
        window.removeEventListener('pointermove', trackMove);
        // Commit the swap synchronously so the hit-test below reads the new order in
        // the same frame the clone is removed (no un-accented paint in between).
        flushSync(() => {
          setDragState(null);
          if (typeof from === 'number' && typeof to === 'number' && from !== to) {
            onReorder(from, to);
          }
        });
        onDragActiveChange?.(false, mouseRef.current);
        accentTileUnderCursor();
      }, glideMs);
    }
  }, [clearHold, calcDropIndex, calcSnapIndex, snapZones, isHorizontal, cleanup, onReorder, onMove, onDragActiveChange, accentTileUnderCursor]);

  // ── Start drag ───────────────────────────────────────────────────────────
  const beginDrag = useCallback((idx, or, cx, cy) => {
    const el = itemRefs.current[idx];
    if (!el) return;

    // Signal drag-active FIRST so consumers (the dock) can imperatively cancel
    // any hover affordance (the dock's hover-expand width) before we measure. Otherwise
    // the rect snapshots below capture the expanded geometry and both the drop math
    // and the clone size go off. The getComputedStyle + getBoundingClientRect
    // reads that follow force the style/layout flush that applies it.
    onDragActiveChange?.(true);

    // Snapshot the source's computed `display` BEFORE the upcoming rerender
    // applies `display: none` to it — the clone needs the original value.
    const originDisplay = window.getComputedStyle(el).display;

    // Re-measure the source rect now (after drag-active unscaling) rather than
    // trusting the press-time `or`, so originRect, positions and heights are all
    // read under one consistent, unscaled layout.
    const originRect = el.getBoundingClientRect();

    // Capture layout BEFORE source.display:none takes effect. The gap-stays-
    // at-source lift cancels source's collapse exactly (marginStart on the next
    // item equals source's size on the axis), so positions[i] for i != sourceIdx
    // will continue to match items[i].getBoundingClientRect()[startProp] during
    // steady state — making computeSlotY math work off cached coordinates.
    const positions = itemRefs.current.map(e => e ? e.getBoundingClientRect()[startProp] : 0);
    const heights   = itemRefs.current.map(e => e ? e.getBoundingClientRect()[sizeProp]  : 0);

    // Container flex `gap` on the active axis. The source-collapse + drop-gap math
    // is height-only, so a flex gap leaves a one-gap surplus where the source lifts
    // and a one-gap deficit where it lands → siblings snap by one gap-width on drop.
    // Capture it so the render can cancel the surplus (−gap on the source) and pad
    // the deficit (+gap on the drop slot). 0 for margin-spaced consumers (dock/
    // sidebar) → a no-op there.
    const gcs = containerRef.current ? window.getComputedStyle(containerRef.current) : null;
    const flexGap = gcs ? (parseFloat(isHorizontal ? gcs.columnGap : gcs.rowGap) || 0) : 0;

    // Grid: every slot's resting origin, measured once at lift. The slide below
    // and the clone's landing target are both read off these — never predicted
    // from a column count or a chip width, which a wrap is free to change.
    const slots = (isGrid || isHorizontal)
      ? itemRefs.current.map(e => { const r = e?.getBoundingClientRect(); return r ? { x: r.left, y: r.top } : { x: 0, y: 0 }; })
      : null;

    // slots + originRect ride on dRef (not just dragState) so calcDropIndex can
    // read them without taking dragState as a dependency — it would rebuild the
    // whole pointer-handler chain on every drop-index update.
    dRef.current = { phase: 'drag', idx, slots, originRect };
    mouseRef.current = { x: cx, y: cy };

    if (el) el.style.pointerEvents = 'none';

    // Initial dropIdx points at the next non-source slot so the destination
    // marginTop (or marginBottom when source is last) opens a real gap exactly
    // at source's original position — items above and below source do not
    // visibly reflow on lift. The clone fills the gap (DESIGN.md § Drag and drop).
    const initialDropIdx = idx === itemRefs.current.length - 1 ? itemRefs.current.length : idx + 1;
    setDragState({
      dragging: true,
      idx,
      dropIdx: initialDropIdx,
      originRect,
      originDisplay,
      positions,
      heights,
      flexGap,
      slots,
    });
    playReorderPickup();

    // …and read them AGAIN once the row stops moving. On the dock the grabbed
    // button is wide (icon+label) at lift and animates back to its icon square,
    // so every rect above belongs to a layout that is still collapsing. The drop
    // gap and the slot math must use the settled numbers, not the lift-time ones
    // — the same reason the clone mirrors the live box rather than freezing it.
    // Pure re-measurement: nothing here is computed from the old values.
    if (isHorizontal) {
      let stable = 0, lastW = -1, waited = 0;
      const settle = () => {
        const live = itemRefs.current[idx];
        if (!live || dRef.current?.idx !== idx) return;
        const w = live.getBoundingClientRect().width;
        // EXACT equality, not a <0.5px tolerance. The collapse runs on
        // cubic-bezier(.22,1,.36,1), which decelerates hard: its final frames move
        // a tenth of a pixel at a time, so "barely changing" reads as "stopped"
        // while the button is still 0.6px wide of rest. gapSize is built from this
        // width, so every slide offset came out 46.6 instead of the 46.0 slot pitch
        // — and at commit the row snapped back that 0.6px, a beat after the drop.
        // (Measured 2026-09-14: items 4 and 5 jumped +46.6 at release.) A frame cap
        // keeps a jittering sub-pixel layout from spinning here forever.
        if (w === lastW) stable++; else stable = 0;
        lastW = w;
        if (stable < 3 && ++waited < 60) { requestAnimationFrame(settle); return; }
        const rest = live.getBoundingClientRect();
        // One measurement, both consumers: calcDropIndex reads dRef.current.slots,
        // the clone's landing target reads dragState.slots. Refreshing only the
        // first leaves the clone snapping to the expanded-button geometry — on a
        // centre-justified row that is a visible jump the moment slot-snap takes over.
        const restSlots = itemRefs.current.map(e => {
          const r = e?.getBoundingClientRect();
          return r ? { x: r.left, y: r.top } : { x: 0, y: 0 };
        });
        if (dRef.current) {
          dRef.current.slots = restSlots;
          dRef.current.originRect = rest;
        }
        setDragState(prev => (prev && prev.idx === idx ? {
          ...prev,
          restRect: rest,
          slots: restSlots,
          positions: itemRefs.current.map(e => e ? e.getBoundingClientRect()[startProp] : 0),
          heights:   itemRefs.current.map(e => e ? e.getBoundingClientRect()[sizeProp]  : 0),
        } : prev));
      };
      requestAnimationFrame(settle);
    }
  }, [onDragActiveChange, startProp, sizeProp, isGrid, isHorizontal]);

  // Abort a drag/hold that will never see a pointerup: a release outside the OS
  // window, or a window blur mid-drag (Alt-Tab / focus-stealing dialog). Guarding
  // on dRef.current keeps this a no-op during the post-release glide (onUp nulls
  // dRef before the glide's setTimeout), so it respects the two-phase release.
  const onAbort = useCallback(() => {
    if (!dRef.current) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onAbort);
    window.removeEventListener('blur', onAbort);
    cleanup(); // clearHold + clearDropAccent + restore pointerEvents + dRef=null + setDragState(null) + onDragActiveChange(false)
  }, [onMove, onUp, cleanup]);

  // ── Item pointer down ────────────────────────────────────────────────────
  const onItemDown = useCallback((e, idx) => {
    if (!enabled || e.button !== 0) return;
    suppressClickRef.current = false;

    // Drag pickup is allowed only from non-interactive chrome. Any standard
    // interactive element — or anything tagged data-no-drag (custom drag
    // surfaces like the planner day-view or the music seek/volume sliders) —
    // receives its own pointer events instead.
    //
    // When `dragFromInteractive` is set (the dock, whose every item IS an icon
    // button), the whole item is a drag surface: buttons/links no longer block
    // pickup, only inputs/sliders and explicit data-no-drag do. Tap-vs-hold
    // still disambiguates click from drag (HOLD_MS / MOVE_THRESHOLD below).
    const blockSelector = dragFromInteractive
      ? 'input, textarea, select, [contenteditable], [data-no-drag]'
      : 'button, a, [role="button"], input, textarea, select, [contenteditable], [data-no-drag]';
    const blocked = e.target.closest?.(blockSelector);
    if (blocked && blocked !== e.currentTarget) return;

    const r = itemRefs.current[idx]?.getBoundingClientRect();
    if (!r) return;

    dRef.current = { phase: 'hold', idx, sx: e.clientX, sy: e.clientY };
    mouseRef.current = { x: e.clientX, y: e.clientY };
    holdTimerRef.current = setTimeout(() => beginDrag(idx, r, e.clientX, e.clientY), HOLD_MS);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { passive: false });
    window.addEventListener('pointercancel', onAbort);
    window.addEventListener('blur', onAbort);
  }, [enabled, dragFromInteractive, beginDrag, onMove, onUp, onAbort]);

  const flexDir = direction === 'vertical' ? 'column' : 'row';

  // Destination gap matches the dragged item's actual size on the active axis
  // (+ one flex gap, which the inserted item brings in the final layout) so the
  // slot equals the item's true footprint and neighbours don't snap on drop.
  // restRect, when present, is the source re-measured after the row settled (see
  // beginDrag) — the footprint the slot will actually have, not the one it had
  // mid-collapse.
  const gapSize = (dragState?.restRect?.[sizeProp] ?? dragState?.originRect?.[sizeProp] ?? gapSizeProp)
    + (dragState?.flexGap ?? 0);

  // Grid: where each item sits while the drag is live. Removing the source from
  // the order shifts everything between it and the drop slot by exactly one
  // place, so item i simply borrows slot j's measured origin — no per-line or
  // per-column arithmetic, and a wrap of any shape comes out right.
  const gridSlotIndexFor = (i) => {
    const src = dragState.idx, drop = dragState.dropIdx;
    if (src < i && i < drop) return i - 1;
    if (drop <= i && i < src) return i + 1;
    return i;
  };
  // Where the DRAGGED chip itself lands: the slot the order leaves for it.
  const gridLanding = ((isGrid || isHorizontal) && dragState?.slots)
    ? dragState.slots[Math.max(0, Math.min(dragState.slots.length - 1,
        dragState.dropIdx > dragState.idx ? dragState.dropIdx - 1 : dragState.dropIdx))]
    : null;

  return (
    <>
      {dragState?.dragging && itemRefs.current[dragState.idx] && (
        <PlainDragTile
          sourceElement={itemRefs.current[dragState.idx]}
          originRect={dragState.originRect}
          originDisplay={dragState.originDisplay}
          cursorRef={mouseRef}
          slotY={computeSlotY(dragState.dropIdx, dragState.idx, dragState.positions, dragState.heights, dragState.flexGap ?? 0)}
          slotXY={gridLanding}
          isHorizontal={isHorizontal}
          isGrid={isGrid}
          releasing={!!dragState.releasing}
          glideMs={dragState.glideMs ?? 160}
          containerRef={containerRef}
          grow={growToContain}
        />
      )}
      <div ref={containerRef} data-drag-list="" data-dragging={dragState?.dragging ? 'true' : undefined} className={className} style={{ display: 'flex', flexDirection: flexDir, flexWrap: isGrid ? 'wrap' : undefined, ...style }}>
        {items.map((item, i) => {
          const isDragged = dragState?.idx === i;
          const isDrop    = dragState?.dragging && dragState?.dropIdx === i && !isDragged;
          // dropIdx === items.length means "drop after the last item". There
          // is no item[items.length] to attach a marginTop to, so the gap
          // gets attached as a marginBottom on the actual last non-dragged
          // item — otherwise dragging the first item past the last item in a
          // short list (e.g. the 2-slot right sidebar) shows zero visual
          // feedback even though the drop itself succeeds.
          // When source is the LAST item, marginBottom needs to land on the
          // second-to-last item (the new last non-source) so the gap renders at
          // source's original position. Otherwise the existing `items.length - 1`
          // target IS the source, which has `display: none` and !isDragged is
          // false — no gap renders and the lift collapses items upward.
          const lastNonSourceIdx = dragState?.idx === items.length - 1
            ? items.length - 2
            : items.length - 1;
          const isDropAfter = dragState?.dragging
            && dragState?.dropIdx === items.length
            && i === lastNonSourceIdx
            && !isDragged;
          // getItemStyle is spread FIRST so the drag-state overrides below
          // (display: none on the picked-up slot, etc.) win. Right-sidebar
          // slots set display: 'flex' here — without the order fix, the
          // collapse would be silently overwritten and the dragged tile
          // would stay visible, blocking layout.
          const itemStyle = getItemStyle ? getItemStyle(item, i) : {};

          // Grid: offset this chip from its own measured origin to the origin of
          // the slot it currently occupies. An OFFSET — never a margin or a
          // collapse, which would re-flow the wrap and throw chips onto other
          // lines. left/top rather than a transform: a transform makes each
          // shifted chip its own compositing layer, and a layer at a fractional
          // position is snapped to a whole device pixel, so every shifted chip
          // settled by 1px when the offset came off at commit. The item already
          // carries `position: relative` below.
          // Horizontal: the same idea as the grid's slide, but computed from the
          // dragged item's own footprint instead of borrowing a neighbour's slot
          // origin — so a run of MIXED widths (the dock's separators and flex
          // spacers) comes out right where the borrow would not.
          //
          // Why not the margin pair the vertical rails use: that scheme opens the
          // gap on one item and cancels it with a negative margin on the source,
          // and the cancellation only holds while both animate in lockstep. Move
          // fast and each new drop slot INTERRUPTS the previous transition, which
          // restarts from wherever it was with a fresh full duration — the two no
          // longer sum to a constant and every item downstream wobbles (reported
          // 2026-09-14: "buttons that aren't even supposed to move start shaking").
          // An independent per-item offset has nothing to cancel against: an
          // interruption just redirects that one item.
          let hDx = 0;
          if (isHorizontal && dragState?.dragging && !isDragged) {
            const F = gapSize;                       // the source's footprint + one gap
            if (i > dragState.idx) hDx -= F;         // it left: everything after closes up
            if (i >= dragState.dropIdx) hDx += F;    // it lands here: everything from here opens
          }
          let gridDx = 0, gridDy = 0;
          if (isGrid && dragState?.dragging && dragState.slots && !isDragged) {
            const from = dragState.slots[i];
            const to = dragState.slots[gridSlotIndexFor(i)];
            if (from && to) { gridDx = to.x - from.x; gridDy = to.y - from.y; }
          }

          return (
            <div
              key={keyExtractor(item, i)}
              ref={el => { itemRefs.current[i] = el; }}
              onPointerDown={e => onItemDown(e, i)}
              onClickCapture={e => { if (suppressClickRef.current) { e.stopPropagation(); e.preventDefault(); } }}
              style={{
                ...itemStyle,
                // Animate the destination-slot gap. The dragged item's source
                // slot collapses via a CSS animation (see `data-dragsrc-collapsing`
                // below) — sized from the captured originRect down to 0 over
                // the same 160ms easing, so flex-weighted siblings (e.g. the
                // planner slot with flexWeight:2) grow into the freed space
                // smoothly instead of snapping. Post-drop snap-back is instant.
                // The SOURCE transitions its margin too (not just !isDragged): its
                // −flexGap compensation must ease in with the SAME easing as the
                // collapse keyframe + the drop-gap, or it lands instantly at t=0 and
                // shoves neighbours by one gap on pickup (the pickup-snap bug).
                transition: dragState?.dragging
                  ? ((isGrid || isHorizontal) ? `left ${GLIDE}, top ${GLIDE}` : `margin ${GLIDE}`)
                  : 'none',
                left: isGrid ? gridDx : (isHorizontal ? hDx : undefined),
                top:  isGrid ? gridDy : undefined,
                [marginStart]: (isGrid || isHorizontal) ? undefined : (isDrop ? gapSize : 0),
                // Source slot cancels one flex gap so its collapse doesn't leave a
                // one-gap surplus where it lifted (siblings stay put on drop). Pairs
                // with the +flexGap in gapSize above to keep the lift itself reflow-
                // free. No-op when the container has no flex gap.
                // A HORIZONTAL source gives its whole footprint back, not just the
                // flex gap: the `drag-source-collapse` keyframe below is HEIGHT-only,
                // which does nothing to a row, so the source kept its full width while
                // the drop gap opened — the run grew by one slot and the centre-
                // justified dock bar spread ~18px each way on every lift (measured
                // 2026-09-13: resting lefts 380/426/472, during-drag 362/408/454).
                // −gapSize is exactly the width + gap the drop slot opens, so the row
                // is the same width all through the drag.
                // Horizontal keeps the source's space, exactly like the grid: the hole
                // the eye follows is opened by the neighbours sliding, not by the row
                // re-flowing around a collapsing slot — which is also what stops the
                // centre-justified bar from spreading on every lift.
                [marginEnd]:   (isGrid || isHorizontal) ? undefined
                  : (isDragged ? -(dragState?.flexGap ?? 0) : (isDropAfter ? gapSize : 0)),
                // Source slot: hide visually + provide the from-height for
                // the keyframe collapse. `visibility: hidden` keeps the slot
                // invisible during the collapse so its content doesn't clip-
                // peek above the clone; the keyframe runs simultaneously and
                // shrinks the slot height from its captured origin to 0. The
                // floating clone already covers the source's origin pixel
                // position, so the visual is: clone in place, planner grows
                // smoothly upward into the freed space.
                visibility: isDragged ? 'hidden' : undefined,
                // Grid keeps the source's space (no collapse keyframe): the gap
                // the eye follows is opened by the neighbours sliding, not by the
                // container re-flowing around a shrinking hole.
                ['--drag-source-from-h']: (isDragged && !isGrid && !isHorizontal)
                  ? `${dragState.originRect.height}px`
                  : undefined,
                cursor: enabled ? 'grab' : undefined,
                position: 'relative',
                pointerEvents: isDragged ? 'none' : undefined,
              }}
              data-dragsrc-collapsing={(isDragged && !isGrid && !isHorizontal) ? 'true' : undefined}
            >
              {renderItem(item, i)}
            </div>
          );
        })}
      </div>
    </>
  );
}

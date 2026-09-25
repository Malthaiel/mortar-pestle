import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { GLIDE_MS, glideEase } from '@host/util/motion.js';
import { MOVE_THRESHOLD } from '@host/components/DraggableSidebarList.jsx';
import { cornerAt, strokedCornerAt } from './corners.js';

// The planner's sole watchface: a rounded-rectangle two-ring dial.
//
//   OUTER, thick  = the DAY RIBBON - today's blocks and a now-marker painted
//                   right around the perimeter. Also the calendar's toggle.
//   INNER, thin   = session progress, depleting once over the whole session.
//
// The per-MINUTE arc is gone (user-directed 2026-09-06: "seconds aren't counted
// anymore"). It used to be the thick innermost ring; the thin session arc took
// its place on the inside and the ribbon took the thick weight on the outside.
//
// Drag-to-set duration is horizontal delta-based (6 px per minute) rather than
// angular click-to-set - the SVG's interior is one grip target and "left = less,
// right = more" maps cleanly to user intent. The ribbon band is NOT part of that
// grip: it takes clicks for the calendar.
//
// Ring geometry, in svg px from the svg edge. Hoisted to module scope so the one
// consumer that has to line up with the inner ring can READ these instead of
// copying them: PlannerDock's inner-controls overlay hardcoded 26/29 in
// styles.css, which is this sum minus the ring button's 3px frame.
const sessionStrokeW = 2.18;
// The ribbon keeps the weight the deleted minute arc carried, so the dial still
// has one thick mark and one thin one - just swapped ends.
export const RIBBON_W = 5.57;
// NO SHAPE IN HERE OWNS A RADIUS ANY MORE (rebuilt 2026-09-06 after four passes
// that each tuned one shape and left the rest disagreeing). Every corner comes
// from corners.js: the widget's own painted radius, minus how far in that shape
// sits. See that file for why equal radii read as UNEVEN and why this rule is the
// one the browser already uses for a border. What lives here now is only each
// shape's INSET - a fact about the dial's layout, not about roundness.
// The bare gap between the svg's edge and the FIRST stroke the eye sees. Anything
// lining the dial up with a neighbour lines up on THIS, not on an inset: an inset
// is measured to a stroke's centre, so two strokes of different weights at the same
// inset leave different gaps. The dial's box overflows its slot by exactly this
// much (PlannerDock), putting the painted ring on the widget's own margin.
export const RING_EDGE_GAP = 9.8;
// The bare gap between the two rings' PAINTED edges. Solving it against a fixed
// interior gave 24px of empty plate once the minute arc was deleted, which he
// rejected - so the GAP is the held number now and the interior takes the room
// the deleted ring freed. The readout does not stretch into it: its glyphs stop
// at their natural width (SegmentReadout) and the display scales as one object.
const RING_GAP = 9.215;
// How far the plate stands PROUD of the ribbon's painted outer edge. Purely an
// INSET - it has no say in any radius now that corners.js owns those.
//
// The FLOOR is RIBBON_W / 2 = 2.785: below that the ribbon's outer half-stroke
// hangs off the plate and loses its dark track wherever the tile floods accent.
// Zero overhang was tried and read as the slab missing entirely.
//
// It sat at that floor + 0.215 until 2026-09-09, when the plate stopped being a
// mere BACKING and became a slab the eye is meant to see - the same one the
// dev-tab Tube toy wears (user-directed). 6.7 is not a taste number either: the
// toy's slab stands 9.5 painted px past its pipe's outer edge, and this constant
// paints 1:1 with a 2.8px offset (MEASURED, two points: 3 -> 5.8, 5 -> 7.8), so
// 6.7 puts this slab the same 9.5 past the ribbon. The calendar's slab needs no
// change to follow: PlannerDock reads its inset off this plate's real rect.
//
// Pulled back to 5.2 the same day - the toy's own reach read as too much proud
// slab at this size (user-directed). Painted, that is 8.0 past the ribbon rather
// than 9.5. The 1:1 + 2.8px relation above is what converts the two.
const PLATE_OVERHANG = 5.2;

// The stack, outward to inward. Derived, never typed: edge gap -> ribbon -> gap
// -> session arc. Retuning either width moves everything downstream on its own.
const ribbonInset = RING_EDGE_GAP + RIBBON_W / 2;
const sessionInset = ribbonInset + RIBBON_W / 2 + RING_GAP + sessionStrokeW / 2;

// The innermost ring's INNER FACE - where the dial's interior starts, and so how
// much room the readout is given. The stroke is CENTRED on the path, so the
// interior starts half a stroke inward of the inset, not the whole width.
export const RING_INNER_EDGE = sessionInset + sessionStrokeW / 2;

// Total length of the rounded-rect path below. Chips are placed as dashes along
// it, so this is what turns "37% through the day" into a real arc length.
export const perimeterOf = (w, h, r) => 2 * (w + h) - 8 * r + 2 * Math.PI * r;

// Each shape's PAINTED OUTER edge, as a distance from the svg's own edge. These
// are what corners.js turns into radii; add the svg's own inset from the widget
// (measured, not summed) and you have the depth every corner is derived from.
export const RIBBON_OUTER_INSET = RING_EDGE_GAP;
export const SESSION_OUTER_INSET = sessionInset - sessionStrokeW / 2;
export const PLATE_OUTER_INSET = RING_EDGE_GAP - PLATE_OVERHANG;


// Walk the rounded-rect perimeter clockwise from top-middle, emitting an SVG
// path for the leading `fraction` of total length. Corners are quarter-arcs;
// edges are straight lines. Total perimeter = 2(w+h) - 8r + 2πr.
export function roundedRectArcPath(x, y, w, h, r, fraction) {
  if (fraction <= 0.0001) return '';
  const startX = x + w / 2;
  const startY = y;
  if (fraction >= 1) {
    return (
      `M ${startX} ${startY} ` +
      `L ${x + w - r} ${y} ` +
      `A ${r} ${r} 0 0 1 ${x + w} ${y + r} ` +
      `L ${x + w} ${y + h - r} ` +
      `A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} ` +
      `L ${x + r} ${y + h} ` +
      `A ${r} ${r} 0 0 1 ${x} ${y + h - r} ` +
      `L ${x} ${y + r} ` +
      `A ${r} ${r} 0 0 1 ${x + r} ${y} ` +
      `L ${startX} ${startY}`
    );
  }
  const cornerLen = (Math.PI * r) / 2;
  const halfTopLen = w / 2 - r;
  const sideVLen = h - 2 * r;
  const sideHLen = w - 2 * r;
  const segments = [
    { len: halfTopLen, kind: 'line',
      from: [startX, startY], to: [x + w - r, y] },
    { len: cornerLen, kind: 'arc',
      from: [x + w - r, y], to: [x + w, y + r], center: [x + w - r, y + r] },
    { len: sideVLen, kind: 'line',
      from: [x + w, y + r], to: [x + w, y + h - r] },
    { len: cornerLen, kind: 'arc',
      from: [x + w, y + h - r], to: [x + w - r, y + h], center: [x + w - r, y + h - r] },
    { len: sideHLen, kind: 'line',
      from: [x + w - r, y + h], to: [x + r, y + h] },
    { len: cornerLen, kind: 'arc',
      from: [x + r, y + h], to: [x, y + h - r], center: [x + r, y + h - r] },
    { len: sideVLen, kind: 'line',
      from: [x, y + h - r], to: [x, y + r] },
    { len: cornerLen, kind: 'arc',
      from: [x, y + r], to: [x + r, y], center: [x + r, y + r] },
    { len: halfTopLen, kind: 'line',
      from: [x + r, y], to: [startX, startY] },
  ];
  const perimeter = 2 * (w + h) - 8 * r + 2 * Math.PI * r;
  let remaining = fraction * perimeter;
  let path = `M ${startX} ${startY}`;
  for (const seg of segments) {
    if (remaining <= 0) break;
    if (remaining >= seg.len) {
      if (seg.kind === 'line') {
        path += ` L ${seg.to[0]} ${seg.to[1]}`;
      } else {
        path += ` A ${r} ${r} 0 0 1 ${seg.to[0]} ${seg.to[1]}`;
      }
      remaining -= seg.len;
    } else {
      const t = remaining / seg.len;
      if (seg.kind === 'line') {
        const px = seg.from[0] + t * (seg.to[0] - seg.from[0]);
        const py = seg.from[1] + t * (seg.to[1] - seg.from[1]);
        path += ` L ${px} ${py}`;
      } else {
        const startAng = Math.atan2(seg.from[1] - seg.center[1], seg.from[0] - seg.center[0]);
        const sweep = t * Math.PI / 2;
        const endAng = startAng + sweep;
        const px = seg.center[0] + r * Math.cos(endAng);
        const py = seg.center[1] + r * Math.sin(endAng);
        path += ` A ${r} ${r} 0 0 1 ${px} ${py}`;
      }
      remaining = 0;
    }
  }
  return path;
}

export default function DualRingRect({
  remainingMins, phase, running,
  width = 200, height = 80,
  interactive = false, dragMins = null,
  glow = true,
  // The widget's own PAINTED corner radius in px, read off the tile by the host
  // (corners.js/useWidgetCorner), and how far this svg's edge sits inside that
  // tile. Every radius in here is derived from the pair - see corners.js.
  outerR = 0, svgInset = 0,
  // A filled rounded rect behind the rings, drawn to the OUTER ring's outer edge,
  // so the dial stays readable when the button under it floods accent: the arcs are
  // accent-coloured and would vanish on an accent face. Inside the SVG rather than
  // a CSS layer - no stacking-order games, and it lines up by construction.
  plate = null,
  // WHERE THE SESSION RING IS PAINTED (user-directed 2026-09-20: "i actually want
  // the inner ring to be a PART of the 3d button"). Given { node, dx, dy }, the
  // ring's three shapes are portalled into `node` inside their own <svg>, offset by
  // dx/dy so they land on exactly the same pixels as before - the host is telling
  // us where its own box starts, and we shift back by it. Nothing about the ring's
  // geometry, its refs or the rAF loop that redraws the arc every frame changes:
  // the shapes are the same shapes in the same coordinate space, just carried into
  // a box that can turn. Omit the prop and the ring stays in this svg as it was.
  ringSlot = null,
  // PAINT THE RINGS AT ALL. False strips the session arc and the ring art, leaving
  // the svg as the drag-to-SET-time hit surface and nothing else — which is what
  // the planner dock became on 2026-09-22, when the turning block grew to fill the
  // tile and there was no band left for a ring to sit in. Default true: the Dev
  // rig (FlipTestPanel) still wants them.
  rings = true,
  // WHERE THE SESSION RING'S PAINTED OUTER EDGE SITS, from the svg's edge. Null
  // keeps the dial's own stack (SESSION_OUTER_INSET). The planner dock overrides
  // it from 2026-09-22: its svg IS the turning block now, so the ring has to be
  // re-placed against the block's rim instead of against a band that no longer
  // exists. Given as the OUTER edge, not the path centre, because that is the
  // edge the eye judges and the caller should not have to know the stroke width.
  ringOuterInset = null,
  // Ring 3's DATA left this file on 2026-09-08 (Ribbon Pour) - the dock's overlay
  // owns the dashes, the now-marker and the click target now, because they travel
  // down over the calendar and this svg paints behind it. All that is passed in
  // here is a ref onto the empty groove they came out of, so the dock can MEASURE
  // the pour's start rect off the real painted path instead of summing insets.
  grooveRef,
  onGrooveClick,
  onDragStart, onDrag, onDragEnd,
  onPressedChange,
}) {
  const svgRef = useRef(null);
  // Three shapes, one rule, zero literals: each asks corners.js what a shape at
  // its depth is allowed to be. `strokedCornerAt` also takes the half-stroke off,
  // because the eye judges a band's outer lip and the path runs down its middle.
  const plateR = cornerAt(outerR, svgInset + PLATE_OUTER_INSET);
  const ribbonR = strokedCornerAt(outerR, svgInset + RIBBON_OUTER_INSET, RIBBON_W);
  const sessionOuter = ringOuterInset ?? SESSION_OUTER_INSET;
  const sessionR = strokedCornerAt(outerR, svgInset + sessionOuter, sessionStrokeW);

  const totalSec = Math.max(0, Math.round(remainingMins * 60));
  const totalSecRef = useRef(totalSec);
  const subSecRef = useRef(0);
  const lastFrameRef = useRef(performance.now());
  const sessionGlowEl = useRef(null);
  const sessionArcEl = useRef(null);
  const drawRef = useRef(() => {});

  useEffect(() => {
    if (totalSec !== totalSecRef.current) {
      totalSecRef.current = totalSec;
      subSecRef.current = 0;
    }
  }, [totalSec]);

  useEffect(() => {
    if (!running) return;
    let raf;
    const tick = (t) => {
      const dt = (t - lastFrameRef.current) / 1000;
      lastFrameRef.current = t;
      subSecRef.current = Math.min(1, subSecRef.current + dt);
      drawRef.current();
      raf = requestAnimationFrame(tick);
    };
    lastFrameRef.current = performance.now();
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  // The dial TRAILS the cursor on the app's one glide (Motion Unification,
  // 2026-08-13), the only value-drag that takes it — this is a coarse dial at
  // 6px per minute, not a precision instrument that has to stay under the
  // fingertip. There is no element to hand a CSS transition to (the arc is a
  // <path> redrawn from a number), so the NUMBER is tweened: a rAF clock runs
  // the same curve, restarting from the live eased value on every pointer move
  // exactly like the wheel-scroll tween. `shownRef` is what gets drawn, both
  // here and in drawRef below, so a re-render mid-glide paints where the arc
  // actually IS rather than snapping to the raw target.
  const shownRef = useRef(null);
  const tweenRef = useRef(null);
  useEffect(() => {
    if (dragMins == null) { shownRef.current = null; tweenRef.current = null; return undefined; }
    tweenRef.current = { from: shownRef.current ?? dragMins, to: dragMins, t0: performance.now() };
    let raf;
    const tick = () => {
      const t = tweenRef.current;
      if (!t) return;
      const x = Math.min(1, (performance.now() - t.t0) / GLIDE_MS);
      shownRef.current = t.from + (t.to - t.from) * glideEase(x);
      drawRef.current();
      if (x < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dragMins]);

  const isDragMode = dragMins != null;
  // The sub-second remainder still counts here even though the minute arc is
  // gone: it is what makes the session arc slide smoothly instead of stepping
  // once a second.
  const sessionFraction = isDragMode
    ? Math.min(1, (shownRef.current ?? dragMins) / 60)
    : Math.min(1, Math.max(0, totalSec - subSecRef.current) / 3600);


  // The path runs down the stroke's middle, so the centre is the outer edge plus
  // half a stroke - the same relation SESSION_OUTER_INSET is derived by.
  const sessionCentre = sessionOuter + sessionStrokeW / 2;
  const sessionX = sessionCentre, sessionY = sessionCentre;
  const sessionW = width - 2 * sessionCentre, sessionH = height - 2 * sessionCentre;

  const ribbonX = ribbonInset, ribbonY = ribbonInset;
  const ribbonW = width - 2 * ribbonInset, ribbonH = height - 2 * ribbonInset;
  const ribbonPath = roundedRectArcPath(ribbonX, ribbonY, ribbonW, ribbonH, ribbonR, 1);
  // ribbonPath is still built here because the GROOVE is drawn on it, and because
  // it is the shape the dock's overlay has to leave from - see grooveRef above.

  const sessionBgPath = roundedRectArcPath(sessionX, sessionY, sessionW, sessionH, sessionR, 1);
  const sessionArcPath =
    roundedRectArcPath(sessionX, sessionY, sessionW, sessionH, sessionR, sessionFraction);

  // Per-frame the RAF loop recomputes the arc paths and writes them straight onto
  // the <path> DOM nodes (React's escape hatch for 60fps SVG) — no per-frame
  // render. Reassigned every render so it always closes over current geometry,
  // dragMins, totalSec, and roundedRectArcPath. Fraction math is verbatim from
  // the render body above.
  drawRef.current = () => {
    const f = isDragMode
      ? Math.min(1, (shownRef.current ?? dragMins) / 60)
      : Math.min(1, Math.max(0, totalSec - subSecRef.current) / 3600);
    const d = roundedRectArcPath(sessionX, sessionY, sessionW, sessionH, sessionR, f);
    sessionGlowEl.current?.setAttribute('d', d);
    sessionArcEl.current?.setAttribute('d', d);
  };

  const sessionHaloW = sessionStrokeW * 2.2;

  const dragging = useRef(false);
  const settingRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startMinsRef = useRef(0);
  const lastSentMinsRef = useRef(null);
  const PX_PER_MIN = 6;

  // The time-set starts only once the first move past the sidebar list's
  // MOVE_THRESHOLD is sideways. Vertical belongs to the list, which lifts the
  // tile on that same move (PlannerDock's data-drag-axis), so the minutes are
  // never touched by a reorder.
  function onPointerDown(e) {
    if (!interactive) return;
    e.preventDefault();
    dragging.current = true;
    settingRef.current = false;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    startMinsRef.current = dragMins != null
      ? dragMins
      : Math.max(1, Math.min(60, Math.round(remainingMins)));
    lastSentMinsRef.current = null;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onPressedChange?.(true);
  }
  function onPointerMove(e) {
    if (!dragging.current) return;
    const deltaPx = e.clientX - startXRef.current;
    if (!settingRef.current) {
      const dy = e.clientY - startYRef.current;
      if (Math.hypot(deltaPx, dy) <= MOVE_THRESHOLD) return;
      if (Math.abs(dy) > Math.abs(deltaPx)) {
        // The list lifts the tile and clears its press; nothing to commit.
        dragging.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        return;
      }
      settingRef.current = true;
      onDragStart?.(startMinsRef.current);
    }
    const newMins = Math.max(
      1,
      Math.min(60, Math.round(startMinsRef.current + deltaPx / PX_PER_MIN)),
    );
    if (newMins !== lastSentMinsRef.current) {
      lastSentMinsRef.current = newMins;
      onDrag?.(newMins);
    }
  }
  function onPointerUp(e) {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    onPressedChange?.(false);
    if (settingRef.current) onDragEnd?.();
  }

  // The session ring's three shapes, in one place so they can be painted either
  // in this svg or portalled into the turning block. The filter id follows them.
  const ringArt = (
    <>
      {/* Background ring — full perimeter, neutral stroke. */}
      <path d={sessionBgPath} fill="none"
        stroke="var(--clock-stroke-bg)" strokeWidth={sessionStrokeW}/>
      {/* Session arc — the whole session, depleting once. Always glows.
          `.tube-water` rather than a stroke attribute (user-directed 2026-09-16):
          the class paints var(--accent) exactly as the hand-set colour did, AND
          carries the tile's hover flip to #fff that the pipe's liquid already
          had — one rule, both liquids. */}
      {sessionArcPath && (
        <>
          {glow && (
            <path ref={sessionGlowEl} d={sessionArcPath} className="tube-water"
              strokeWidth={sessionHaloW} fill="none" strokeLinecap="round"
              opacity="0.32"
              filter={`url(#${ringSlot ? 'dualRectGlowSlot' : 'dualRectGlow'})`}/>
          )}
          <path ref={sessionArcEl} d={sessionArcPath} className="tube-water"
            strokeWidth={sessionStrokeW} fill="none" strokeLinecap="round"/>
        </>
      )}
    </>
  );

  return (
    <>
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      overflow="visible"
      width={width}
      height={height}
      style={{
        display: 'block',
        touchAction: interactive ? 'none' : 'auto',
        cursor: interactive ? (isDragMode ? 'grabbing' : 'grab') : 'default',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <defs>
        {glow && (
          <filter id="dualRectGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.9"/>
          </filter>
        )}
      </defs>

      {/* Transparent hit-rect — makes the entire SVG surface pointer-receptive
          so drag works anywhere inside the button, not just on the strokes. */}
      <rect x={0} y={0} width={width} height={height} fill="transparent"/>

      {/* The plate, if the host asked for one. Since ring 3 arrived (user-directed
          2026-09-06) its edge is the RIBBON's outer edge, so one slab backs all
          three rings - the day ribbon sits outside the two arcs and its track is
          --clock-stroke-bg, which is two RGB units off the tile's face and paints
          as nothing on bare face. On the plate it reads. Its corner comes from the
          same rule as everything else, off its own depth - see corners.js. */}
      {plate && (
        <rect
          x={PLATE_OUTER_INSET} y={PLATE_OUTER_INSET}
          width={width - 2 * PLATE_OUTER_INSET}
          height={height - 2 * PLATE_OUTER_INSET}
          rx={plateR}
          fill={plate}
        />
      )}
      {/* THE PLATE IS A RULER NOW (user-directed 2026-09-20: the ring and the
          background round the clock both come off). Painting it is what the host
          switched off - it passes "transparent" - but the rect itself has to stay:
          PlannerDock finds it by `rect[fill*="planner-face"]`... which a transparent
          fill would not match, so the host passes the token INSIDE a transparent
          colour-mix instead. See the plate prop at its call site. */}

      {/* ── Ring 3: the day ribbon's GROOVE ─────────────────────────
          Only the empty track lives here now. The dashes, the now-marker and the
          click target moved OUT to PlannerDock's overlay svg (Ribbon Pour,
          2026-09-08), because they have to travel down over the calendar rows and
          this svg is earlier in DOM order than the calendar body - anything drawn
          here paints behind it. What stays is the channel the strip came out of:
          the dial keeps its three-ring proportion whether the strip is home or
          poured, and the pour visibly starts FROM something.

          IT PAINTS NOTHING, and since 2026-09-20 nothing paints it at all. The tube
          drew this band from 2026-09-09; the tube is archived (_attic/tube) and the
          band was NOT handed back - user-directed, the ring and the plate behind it
          both come off, leaving the turning block on bare tile face.

          The path is also the RULER. grooveRef is how the dock measures the turning
          block's box: this path's real painted box, READ, never summed from insets -
          so the dial owns every number in it. Painted or transparent the box is the
          same; `none` is what would drop the stroke from it and quietly shift the
          measurement by RIBBON_W / 2.

          It still swallows pointerdown, exactly as the old hit stroke did: this
          band is not a drag-to-SET-time surface, and without that the press falls
          through to the svg and starts a time drag (user-directed 2026-09-06). The
          CLICK target is the overlay's stroke, which sits right on top of it. */}
      <path ref={grooveRef} d={ribbonPath} fill="none"
        stroke="transparent" strokeWidth={RIBBON_W}/>
      {/* The groove's own hit target, and it is NOT optional. Once the strip has
          poured away the only click target left is the outline around the calendar,
          three hundred pixels lower - so the calendar became impossible to close
          from the one place a hand actually goes, and this band SWALLOWED the press
          on top of that. The channel calls the strip back; the strip sends it away.
          One control, two ends, and each end works whether the strip is there or not.
          A hair wider than the paint so the edges are not a dead zone. */}
      <path
        d={ribbonPath} fill="none" stroke="transparent"
        strokeWidth={RIBBON_W + 6} strokeLinecap="round"
        role="button" tabIndex={0}
        aria-label="Toggle day calendar"
        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onGrooveClick}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onGrooveClick?.(e);
        }}/>

      {rings && !ringSlot && ringArt}

      {/* Session arc — the whole session, depleting once. Always glows.
          `.tube-water` rather than a stroke attribute (user-directed 2026-09-16):
          the class paints var(--accent) exactly as the hand-set colour did, AND
          carries the tile's hover flip to #fff that the pipe's liquid already
          had — one rule, both liquids. */}
    </svg>
      {rings && ringSlot && createPortal(
        <svg
          className="planner-ring-art"
          viewBox={`0 0 ${width} ${height}`}
          width={width} height={height} overflow="visible"
          style={{
            position: 'absolute', left: -ringSlot.dx, top: -ringSlot.dy,
            // The block underneath owns the drag-to-SET-time gesture and the three
            // buttons; this is paint only.
            pointerEvents: 'none',
          }}
        >
          <defs>
            {glow && (
              <filter id="dualRectGlowSlot" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="1.9"/>
              </filter>
            )}
          </defs>
          {ringArt}
        </svg>,
        ringSlot.node,
      )}
    </>
  );
}



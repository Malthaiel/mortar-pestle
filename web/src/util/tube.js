// ONE closed circuit of tube, emitted as a SINGLE stroke: a ring, down the right
// spout, round a second ring below, back up the left spout to where it started.
// Two surfaces draw it — the dev-tab toy (TubePanel) and the planner's calendar
// strip (PlannerDock) — so the geometry lives here once. The toy's rings never
// move; the strip rebuilds its own every frame off the live calendar rect. Same
// path either way.
//
// What comes back is the `d` plus WHERE THE THREE JUNCTIONS FALL along it, as
// fractions of the whole run. Those are MEASURED off the real path, never summed
// from the arithmetic that wrote it: a caller can hand in any radius, any spout
// gap, any pair of rects, and the timing follows for free. That measurement is
// the whole reason the liquid and the tube cannot drift apart.

// One scratch node for every measurement in the app. It is never mounted, never
// painted, and getTotalLength works on it regardless.
const scratch = document.createElementNS('http://www.w3.org/2000/svg', 'path');
const lengthOf = (d) => { scratch.setAttribute('d', d); return scratch.getTotalLength(); };

// A radius can never exceed half of either side, or the arcs cross over.
const fit = (r, w, h) => Math.max(0, Math.min(r, w / 2, h / 2));

// `top` and `bot` are plain rects, {x, y, w, h}, of the two rings' PATH CENTRES
// (not their painted edges — pull off half a stroke before you get here).
// `spout` is the gap between the two drop mouths, `join` the radius of the four
// junction arcs, `rad` the corner both rings aim for.
//
// EVERY junction arc bulges OUTWARD from its spout. An inward one drags that
// side of the gap toward the middle and the hole stops reading as centred — a
// one-flag mistake (the sweep flag, plus `dropR + join` vs `- join`) that was the
// root cause of two separate complaints while the toy was being built.
export function buildTube({ top, bot, rad, spout, join }) {
  const tL = top.x; const tR = top.x + top.w; const tY = top.y; const tB = top.y + top.h;
  const bL = bot.x; const bR = bot.x + bot.w; const bY = bot.y; const bB = bot.y + bot.h;
  const tRad = fit(rad, top.w, top.h);
  const bRad = fit(rad, bot.w, bot.h);
  const cx = top.x + top.w / 2;
  const dropL = cx - spout / 2;
  const dropR = cx + spout / 2;
  // The junction arcs cannot be longer than half the drop they turn into, or the
  // two of them meet and overshoot. At rest the calendar is shut, the drop has no
  // length at all, and this collapses them to nothing — an r=0 arc is a straight
  // line to the browser, so the path stays valid with no special case.
  const j = Math.max(0, Math.min(join, (bY - tB) / 2));

  const segTop =
    `M ${dropL - j} ${tB} H ${tL + tRad}`
    + ` A ${tRad} ${tRad} 0 0 1 ${tL} ${tB - tRad} V ${tY + tRad}`
    + ` A ${tRad} ${tRad} 0 0 1 ${tL + tRad} ${tY} H ${tR - tRad}`
    + ` A ${tRad} ${tRad} 0 0 1 ${tR} ${tY + tRad} V ${tB - tRad}`
    + ` A ${tRad} ${tRad} 0 0 1 ${tR - tRad} ${tB} H ${dropR + j}`;
  const segDown =
    ` A ${j} ${j} 0 0 0 ${dropR} ${tB + j} V ${bY - j}`
    + ` A ${j} ${j} 0 0 0 ${dropR + j} ${bY}`;
  const segBot =
    ` H ${bR - bRad}`
    + ` A ${bRad} ${bRad} 0 0 1 ${bR} ${bY + bRad} V ${bB - bRad}`
    + ` A ${bRad} ${bRad} 0 0 1 ${bR - bRad} ${bB} H ${bL + bRad}`
    + ` A ${bRad} ${bRad} 0 0 1 ${bL} ${bB - bRad} V ${bY + bRad}`
    + ` A ${bRad} ${bRad} 0 0 1 ${bL + bRad} ${bY} H ${dropL - j}`;
  const segUp =
    ` A ${j} ${j} 0 0 0 ${dropL} ${bY - j} V ${tB + j}`
    + ` A ${j} ${j} 0 0 0 ${dropL - j} ${tB}`;

  const d = segTop + segDown + segBot + segUp;
  const total = lengthOf(d) || 1;
  const cTop = lengthOf(segTop) / total;
  const cDown = lengthOf(segTop + segDown) / total;
  const cBot = lengthOf(segTop + segDown + segBot) / total;
  return { d, fTop: cTop, fDown: cDown - cTop, fBot: cBot - cDown };
}

// The y of `n + 1` evenly spaced points along a path. Only the toy needs this:
// its backing button GROWS as the tube is laid, and the height it grows to is
// whatever the lowest point currently drawn actually is. The strip's height is
// the calendar's, so it never asks.
export function sampleYs(d, n) {
  scratch.setAttribute('d', d);
  const total = scratch.getTotalLength();
  return Array.from({ length: n + 1 }, (_, i) => scratch.getPointAtLength((i / n) * total).y);
}

// How far the pour has got, turned into the dash spans the strokes need.
//
// BOTH DROPS AT ONCE (user-directed 2026-09-09). The circuit's two ends meet at
// the top ring, and the ring's own ends ARE the two drop mouths: path position 0
// is the left mouth, `fTop` the right. So the ring drains out of BOTH, each half
// of it running down its own drop and then half the bottom ring, arriving
// together at the bottom centre. What used to happen - one slug going the whole
// way round, out by the right spout and home by the left - is gone.
//
// Positions on the left branch come back NEGATIVE: past the left mouth the path
// runs backwards toward 1, and a negative start is what "wrapped through the end"
// means. Both callers already turn a start into `stroke-dashoffset: -start`,
// which is exactly the shift that needs.
//
// `m` runs 0..2 so both callers keep the click logic they already had; the lap
// back is the pour in reverse, hence the fold.
//
// `wet` is the LIQUID's own progress, and it defaults to `m` so a caller that has
// only one number keeps the behaviour it had. The planner passes a second one: its
// pipe follows the calendar's eased height while its liquid chases the pointer, and
// the two are not the same number for as long as a hand is moving. The liquid is
// always CLAMPED to the pipe here - water cannot exist in tube that has not been
// laid yet, and clamping at the source means no caller can forget to.
export function tubeSpans(m, { fTop, fDown, fBot }, wet = m) {
  const p = m <= 1 ? m : 2 - m;
  const q = Math.min(p, wet <= 1 ? wet : 2 - wet);
  // The PIPE. One contiguous run through the wrap point: the ring, plus however
  // far each front has been laid past its own mouth.
  const reach = p * (fDown + fBot / 2);
  // The LIQUID, as two slugs - one per branch, each the mirror of the other.
  // Half the ring's water leaves by each mouth, and THERE IS NO MORE OF IT THAN
  // THAT (user-directed 2026-09-09). Both ends of a slug move at the same speed,
  // so each stays exactly half the ring long for the whole trip: shut, the two of
  // them are the ring; poured, they are the two ends of the bottom loop with a dry
  // stretch between them, because the bottom loop is longer than the ring and the
  // liquid does not grow to fill it. Measured before the change, the wet fraction
  // of the circuit swelled 0.50 -> 0.70 across a pour; it is a flat 0.50 now.
  const half = fTop / 2;
  const front = q * (fDown + fBot / 2); // how far each slug has run past its mouth
  return {
    wallFrom: -reach,
    wallTo: fTop + reach,
    tail: half + front,                 // right slug, along the path
    head: fTop + front,
    tailL: -front,                      // left slug, mirrored through the mouth
    headL: half - front,
  };
}

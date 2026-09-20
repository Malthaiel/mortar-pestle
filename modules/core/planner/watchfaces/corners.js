import { useLayoutEffect, useState } from 'react';

// THE corner authority for the planner widget. Every rounded shape in the dial
// asks this module for its radius; nothing computes one by hand, and no shape
// carries a literal. Built 2026-09-06 after four failed passes that each tuned
// one shape's radius in isolation.
//
// WHY A MODULE AND NOT A CONSTANT ------------------------------------------
// The widget stacks four rounded shapes at four different depths: the tile's
// outline (0px in), the plate (12), the day ribbon (15) and the session ring
// (29.8). Giving them all the SAME radius is what the code did for months, and
// it is what reads as "uneven": two rounded rects with equal radii at different
// insets do NOT run parallel. Their arc centres sit `inset` apart on the
// diagonal, so the gap between them opens by a factor of sqrt(2) at the bend -
// measured live, the outline-to-ribbon gap went 15px down the sides and 21px at
// the corners.
//
// The rule that makes every gap identical everywhere is the one the browser
// already uses for a border: an inner edge's radius is the outer radius MINUS
// how far in it sits. That is `cornerAt`. It is why the tile's own frame band
// has never looked wrong while the rings always did.
//
// The trade, stated once so nobody rediscovers it: a shape further in than the
// outer radius is wide has no curve left, and squares off. At the default knob
// (outline 12) the ribbon at 15 and the session ring at 29.8 both go square.
// Turning the app's Corners knob up gives them curve back. Squaring is not a
// bug here - it is what "evenly spaced" costs at this stack depth, and the only
// lever that buys curve back is moving the rings closer to the edge.

// A shape whose painted outer edge sits `inset` px inside the widget's outer edge.
//
// THE RULE, and it is one line on purpose - it was four numbers in two files, and
// that is why it took a day to get wrong four times. Swap this line and every
// corner in the widget moves together, which is the whole point of the module.
//
//   SAME (live)  -> outerR                    every corner the same number
//   NESTED       -> Math.max(0, outerR-inset) every GAP the same width
//
// SAME is what was asked for: "every single one of them exactly the same
// roundness". NESTED was built and photographed 2026-09-06 and rejected on sight -
// it is arithmetically even but squares off every shape deeper than the outer
// radius, which at the default knob is all three of them. `inset` stays in the
// signature so the swap is genuinely one line.
// eslint-disable-next-line no-unused-vars
export const cornerAt = (outerR, inset) => outerR;

// ...and the same thing for a STROKED shape, which is drawn on the path its
// stroke straddles. The eye judges the painted OUTER edge, so the path carries
// half a stroke less than that edge's radius.
export const strokedCornerAt = (outerR, outerInset, strokeW) =>
  Math.max(0, cornerAt(outerR, outerInset) - strokeW / 2);

// The widget's own painted corner, READ off the tile - never recomputed from
// --corner, never `knob x 24`. getComputedStyle returns the resolved px, so the
// knob, the shape's --corner-max and any per-subtree override are all already
// baked in, and a zero knob reads as a plain 0 (the old parseFloat(...) || 0.5
// turned exactly that case back into a half-round dial).
//
// Re-read on the same two signals that can change it: the root's style/class
// attribute (the knob writes there, and a CSS variable moving is not a React
// render) and the tile resizing.
export function useWidgetCorner(ref) {
  const read = () => {
    const tile = ref.current?.closest('.rail-tile');
    if (!tile) return 0;
    return parseFloat(getComputedStyle(tile).borderTopLeftRadius) || 0;
  };
  const [outerR, setOuterR] = useState(0);
  useLayoutEffect(() => {
    const tile = ref.current?.closest('.rail-tile');
    if (!tile) return undefined;
    const sync = () => setOuterR((prev) => { const n = read(); return n === prev ? prev : n; });
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    const ro = new ResizeObserver(sync);
    ro.observe(tile);
    return () => { mo.disconnect(); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return outerR;
}

// How far `el`'s box sits inside the widget's outer edge. MEASURED off both
// rects rather than summed from the margins/frames/negative-margins between
// them - that chain was typed in three files and was wrong in all of them.
export function useInsetFromWidget(ref) {
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const tile = el?.closest('.rail-tile');
    if (!el || !tile) return undefined;
    const measure = () => {
      const a = el.getBoundingClientRect();
      const b = tile.getBoundingClientRect();
      const next = Math.round((a.left - b.left) * 100) / 100;
      setInset((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(tile);
    return () => ro.disconnect();
  }, []);
  return inset;
}

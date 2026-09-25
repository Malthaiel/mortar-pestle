// Tube — a dev-tab toy. A closed circuit of tube drawn as ONE stroke: a ring
// round the top of the button, down the right drop, round a second ring below,
// back up the left drop to where it started. Clicking pours; clicking again
// carries the liquid the rest of the way round, so it leaves by the LEFT drop
// rather than reversing back up the right one.
//
// ONE number drives everything: `u`, how far round the circuit we are (0 = shut,
// 1 = poured, 2 = shut again having gone the whole way round). Tube extent and
// liquid position both come from it.
//
// The button's height is MEASURED, not modelled: the real path is sampled (once
// per corner-knob value), and the height is whatever the lowest drawn point is.
// A height curve typed by hand is a restated constant, and it drifted — the
// liquid outran the button on the way down.
//
// The backing is a real .candy-btn (default face = --surface-3, the same face the
// planner rail tile paints), so the click that pours IS the button's own press.
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { eyebrowStyle } from '../ui/Eyebrow.jsx';
import { buildTube, sampleYs, tubeSpans } from '../../util/tube.js';

const LEFT = 20;
const RIGHT = 230;
const JOIN = 14;           // where a drop meets a ring
const TOP_Y = 20;          // top ring, upper edge
const TOP_B = 110;         // top ring, lower edge — both drops hang from it
const BOT_Y = 145;         // bottom ring, upper edge
const BOT_B = 320;         // bottom ring, lower edge
const DROP_L = 105;        // the two drop mouths, either side of centre
const DROP_R = 145;
const SLAB = 16;           // how far the backing slab reaches past the pipe.
                           // It is also the whole drawing's margin: the button's
                           // own padding is the only gap outside it, so all four
                           // sides read equal.
const WALL = 13;
// The liquid FILLS the pipe (user-directed 2026-09-09): 8 left 2.5px of dry wall
// showing either side of it. A hairline of casing is all that is left now.
const WATER = WALL;      // the liquid fills the bore - see WATER_W in PlannerDock.
const OPEN_MS = 1200;
const SAMPLES = 400;

// The circuit itself lives in util/tube.js — the planner's calendar strip draws
// the same one. What stays here is only this toy's own numbers and the height
// profile, which is read off the REAL path rather than worked out on paper: move
// any coordinate, or the corner knob, and both timing and growth follow.
function build(rad) {
  const t = buildTube({
    top: { x: LEFT, y: TOP_Y, w: RIGHT - LEFT, h: TOP_B - TOP_Y },
    bot: { x: LEFT, y: BOT_Y, w: RIGHT - LEFT, h: BOT_B - BOT_Y },
    rad, spout: DROP_R - DROP_L, join: JOIN,
  });
  return { ...t, ys: sampleYs(t.d, SAMPLES) };
}

// The ring's roundness IS the backing button's own corner, read off the live
// element — same knob, same --corner-max, and no second copy of the number to
// drift when the tile shape is re-tuned. --corner lands on :root in an effect,
// so a render-time read sits a frame behind forever; the observer is what keeps
// the tube in step with the slider while it is being dragged.
function useButtonCorner(ref) {
  const [rad, setRad] = useState(0);
  useLayoutEffect(() => {
    const read = () => {
      if (ref.current) setRad(parseFloat(getComputedStyle(ref.current).borderTopLeftRadius) || 0);
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributeFilter: ['style'] });
    return () => obs.disconnect();
  }, [ref]);
  return rad;
}

// easeInOutQuad — gentle at both ends so the pour starts and settles softly.
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2);

export default function TubePanel() {
  const [u, setU] = useState(0);
  const uRef = useRef(0);
  const raf = useRef(0);
  const btnRef = useRef(null);
  const rad = useButtonCorner(btnRef);
  const geom = useMemo(() => build(rad), [rad]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const runTo = useCallback((target) => {
    cancelAnimationFrame(raf.current);
    const from = uRef.current;
    const dur = OPEN_MS * Math.abs(target - from);
    if (!dur) return;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const v = from + (target - from) * ease(p);
      uRef.current = v;
      setU(v);
      if (p < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, []);

  const { d: D, fTop, ys } = geom;
  const m = ((u % 2) + 2) % 2;

  const { wallFrom, wallTo, tail, head, tailL, headL } = tubeSpans(m, geom);

  // Lowest point of tube that actually exists right now — the top ring is always
  // drawn, plus whatever span of circuit is currently laid.
  const lowest = () => {
    let y = 0;
    const scan = (a, b) => {
      for (let i = Math.floor(a * SAMPLES); i <= Math.ceil(b * SAMPLES); i += 1) {
        if (ys[i] > y) y = ys[i];
      }
    };
    scan(0, fTop);
    scan(wallFrom, wallTo);
    return y;
  };
  const low = lowest();
  const height = low + SLAB;

  // Dash pattern sums to exactly 1, so it tiles the whole path — a run of liquid
  // that passes the end reappears at the start instead of being clipped there.
  const runLen = Math.max(0, head - tail);
  const runLenL = Math.max(0, headL - tailL);

  return (
    <div>
      <div style={{ ...eyebrowStyle, margin: '20px 0 10px' }}>Tube</div>
      <button
        ref={btnRef}
        type="button"
        className="candy-btn"
        data-shape="tile"
        onClick={() => runTo(Math.round(uRef.current) + 1)}
        aria-label="Pour the tube"
      >
        <span className="candy-face">
          {/* Fixed viewBox, changing height: the box is cropped as the button
              grows rather than the drawing being squashed into it. */}
          <svg
            viewBox={`0 0 250 ${BOT_B + SLAB * 2}`}
            width={250}
            height={height}
            preserveAspectRatio="xMinYMin slice"
            style={{ display: 'block' }}
          >
            {/* The pipe wall is gone; what was its colour is now a plain slab
                behind the whole circuit. Its bottom edge is the SAME measured
                low point that sets the button height, so the slab grows with
                the pour instead of being a second copy of that number. */}
            <rect
              x={LEFT - SLAB}
              y={TOP_Y - SLAB}
              width={RIGHT - LEFT + SLAB * 2}
              height={low + SLAB - (TOP_Y - SLAB)}
              rx={rad}
              fill="var(--surface)"
            />
            <path
              d={D}
              pathLength="1"
              className="tube-water"
              fill="none"
              strokeWidth={WATER}
              strokeLinecap="round"
              strokeDasharray={`${runLen} ${1 - runLen}`}
              strokeDashoffset={-tail}
            />
            {/* The left branch's liquid - the mirror slug. Two elements because
                the two are two separate spans of one path. */}
            <path
              d={D}
              pathLength="1"
              className="tube-water"
              fill="none"
              strokeWidth={WATER}
              strokeLinecap="round"
              strokeDasharray={`${runLenL} ${1 - runLenL}`}
              strokeDashoffset={-tailL}
            />
          </svg>
        </span>
      </button>
    </div>
  );
}

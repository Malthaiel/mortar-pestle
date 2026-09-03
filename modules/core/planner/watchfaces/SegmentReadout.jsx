// The planner dial's readout: a drawn seven-segment display, not a typeface.
// Chosen 2026-09-03 over a milled-text, a split-flap and a drain-fill treatment
// (all four were mocked side by side against the real ring geometry first).
//
// Two things make it a display rather than a retro gimmick:
//   1. DEAD SEGMENTS STAY VISIBLE, faintly, the way a physical LCD shows the
//      bars it is not driving. The '8' is always there behind every digit.
//   2. A SEGMENT LEAVING FADES rather than snapping - the CSS carries a long
//      transition on the way out and a short one on the way in, so the display
//      is continuously, subtly alive without a single JS frame loop.
//
// Everything is drawn, so we own every stroke: thickness, corner, spacing, ink.

// The glyph's HEIGHT is the fixed unit; its WIDTH is computed per render, because
// the display fills the interior by WIDENING the digits rather than by spreading
// them apart (user-directed 2026-09-03 - the colon's shoulders were reading as
// dead space).
const UH = 32;

// THE thickness knob. Every other measurement on the glyph is a fraction of it,
// so raising it fattens the strokes without collapsing the joins between them -
// the first pass pinned segment positions to literals and a fatter bar grew
// straight through the middle bar.
const T = 4.4;

const RX = T * 0.34;         // segment corner, a constant fraction of the stroke
const BAR_INSET = T * 0.75;  // how far the horizontals hold off the glyph's sides
const VY = T * 0.5;          // a vertical starts INSIDE the top bar, so the corner
                             // reads as one solid join, not two bars near each other
// The verticals run PAST the middle bar's edge and stop just short of each other,
// leaving a hairline seam instead of a whole bar's worth of gap. A '0' never
// lights the middle bar, so with a full notch it read as two stacked halves
// rather than one ring (user-reported 2026-09-03).
const WAIST_SEAM = T * 0.5;

const GAP = T * 0.9;         // between the two digits of a pair
const COLON_GAP_RATIO = 1.6; // a clock face groups MM and SS: the gaps either side
                             // of the colon run wider than the one inside a pair
const COL_W = T * 1.9;       // the colon's own column
const COL_H = T * 1.55;      // its two marks are SHORT BARS off the same stroke -
                             // a square at stroke thickness reads tiny beside a
                             // full-length bar, and a circle reads as type
                             // smuggled into a drawn display
const MIN_UW = T * 2.6;      // a glyph narrower than this stops being legible

const MAP = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

const GY = (UH - T) / 2;                       // the middle bar's top edge
const VLEN = (UH - WAIST_SEAM) / 2 - VY;       // a vertical's run, bar to seam
const VBOT = (UH + WAIST_SEAM) / 2;            // where the lower vertical starts

// x, y, w, h per segment, in unit space. The classic seven-bar layout: three
// horizontals (a top, g middle, d bottom) and four verticals split at the waist.
// Only the horizontals' run and the right-hand verticals move with the glyph's
// width, so the map is built per render rather than hoisted.
function segments(uw) {
  const barW = uw - 2 * BAR_INSET;
  return {
    a: [BAR_INSET, 0, barW, T],
    g: [BAR_INSET, GY, barW, T],
    d: [BAR_INSET, UH - T, barW, T],
    f: [0, VY, T, VLEN],
    b: [uw - T, VY, T, VLEN],
    e: [0, VBOT, T, VLEN],
    c: [uw - T, VBOT, T, VLEN],
  };
}

/**
 * @param value  "MM:SS"
 * @param w, h   the space to fill, in real px (the ring interior, less its pad)
 */
export default function SegmentReadout({ value, w, h }) {
  if (!(w > 0) || !(h > 0)) return null;

  // HEIGHT sets the glyph size; the leftover WIDTH goes into the DIGITS, not into
  // the gaps. The gaps stay fixed multiples of the stroke, so the display widens
  // as one object instead of drifting apart around the colon.
  const colGap = GAP * COLON_GAP_RATIO;
  const fixedU = 2 * GAP + 2 * colGap + COL_W;
  let scale = h / UH;
  const uw = Math.max(MIN_UW, (w / scale - fixedU) / 4);
  const totalU = 4 * uw + fixedU;
  // Only bites when the box is too narrow to hold four legible glyphs; then the
  // whole display shrinks rather than cramping them.
  scale = Math.min(scale, w / totalU);

  const SEG = segments(uw);
  const keys = Object.keys(SEG);
  const digits = (value || '').replace(/\D/g, '').padStart(4, '0').slice(0, 4);
  const colX = 2 * uw + GAP + colGap;
  const afterColon = colX + COL_W + colGap;
  const xs = [0, uw + GAP, afterColon, afterColon + uw + GAP];

  return (
    <svg
      className="planner-seg"
      viewBox={`0 0 ${totalU} ${UH}`}
      width={totalU * scale}
      height={UH * scale}
    >
      {digits.split('').map((ch, i) => {
        const on = MAP[ch] || '';
        return (
          <g key={i} transform={`translate(${xs[i]} 0)`}>
            {keys.map((k) => {
              const [x, y, sw, sh] = SEG[k];
              const lit = on.includes(k);
              return (
                <rect
                  key={k} x={x} y={y} width={sw} height={sh} rx={RX}
                  // data-lit drives WHICH transition runs (fast in, slow out) -
                  // the attribute is already flipped when the transition starts,
                  // so the rule can pick the duration off it. See styles.css.
                  data-lit={lit ? '1' : '0'}
                  style={{ opacity: lit ? 1 : 'var(--seg-ghost)' }}
                />
              );
            })}
          </g>
        );
      })}
      <g transform={`translate(${colX} 0)`}>
        {[0.31, 0.69].map((f) => (
          <rect key={f} x={(COL_W - T) / 2} y={UH * f - COL_H / 2}
            width={T} height={COL_H} rx={RX}/>
        ))}
      </g>
    </svg>
  );
}

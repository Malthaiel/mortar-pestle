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

// The glyph's HEIGHT in unit space. Everything else on the display is a multiple
// of this or of the stroke, so the whole readout has ONE shape and one scale.
const UH = 32;

// The glyph's OWN width, and the only one it ever has. It used to be solved from
// whatever box arrived - the display filled the interior by WIDENING the digits
// (2026-09-03, the colon's shoulders were reading as dead space) - which means a
// box that grows taller than it grows wide comes out as tall thin digits. That is
// a stretch (user-directed 2026-09-06: "don't mess with the proportions"). 0.83 is
// the ratio the solved version was landing on at the dial's own box, so today's
// look is frozen here rather than recomputed: the same object, and a bigger box
// now scales it instead of reshaping it.
const NATURAL_UW = UH * 0.83;

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
// The display's whole width in unit space, and from it the height it paints at
// when a box of a given width squeezes it. Exported because the dial has to size
// its BOX around this display rather than the other way round - the readout's
// gaps top and bottom have to equal its gaps left and right, and only the thing
// that knows the shape can say how tall that is.
const COLON_U = 2 * (T * 0.9) + 2 * (T * 0.9 * COLON_GAP_RATIO) + COL_W;
export const TOTAL_U = 4 * NATURAL_UW + COLON_U;
export const readoutHeightForWidth = (w) => (w / TOTAL_U) * UH;

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

  // The glyph and every gap are fixed multiples of the stroke, so the display has
  // ONE shape and only its scale changes.
  const colGap = GAP * COLON_GAP_RATIO;
  const fixedU = COLON_U;
  const uw = NATURAL_UW;
  const totalU = TOTAL_U;
  // The display fits the box on WHICHEVER axis runs out first and keeps its own
  // shape on the other. This is the whole no-stretch rule, in one line.
  const scale = Math.min(h / UH, w / totalU);

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

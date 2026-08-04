// Fold demo — dev toy built on Josh Comeau's "Folding the DOM":
// https://www.joshwcomeau.com/react/folding-the-dom/
// Three stacked rectangles folded like a letter into thirds. One slider drives
// both folds in sequence: 0-180 folds the bottom rectangle up onto the middle
// one, 180-360 folds that pair up onto the top one. Each rectangle is sized and
// skinned to match the titlebar account chip.
import { useEffect, useState } from 'react';
import { Slider } from '../ui/index.js';

// Used until the real chip is measured. Height is TitleBar's BTN; the width is
// a stand-in only — the chip has no width of its own (see measure below).
const FALLBACK = { w: 160, h: 28 };
const SLIDER_W = 200;
// Camera distance. The article's 500 was sized for a 300px-tall image; against
// 28px rectangles it sits far too close, and the taper (the near edge of a
// folding flap draws wider than its hinge) reads as the rectangles changing
// shape. Pulling the camera back flattens the taper without killing the fold —
// the flap still foreshortens, which is what sells the 3D.
const PERSPECTIVE = 2000;
// Neighbouring rectangles overlap by exactly one frame, so a crease reads as a
// single 2px stroke instead of two 2px frames stacked into 4px.
const OVERLAP = -2;

// The pivot sits at the MIDDLE of the overlap, not on the flap's top edge.
// Rotating about the top edge overshoots by exactly the overlap: the edge is
// already 2px inside the rectangle above, so 180deg lands the flap 2px past it.
// Halving it makes the fold symmetric about the seam and the flap lands flush.
const HINGE_Y = -OVERLAP / 2;

// A folded flap lands exactly coplanar with what it lands on, which z-fights.
// Lifting it toward the viewer settles the order. After rotateX(180) the local
// +Z points away, so the lift is negative to stay in front at both ends.
const hinge = (deg) => ({
  transform: `rotateX(${deg}deg) translateZ(-1px)`,
  transformOrigin: `center ${HINGE_Y}px`,
  willChange: 'transform',
});

export default function FoldPanel({ accent }) {
  const [angle, setAngle] = useState(0);
  // The account chip shrink-wraps its display name, so its width is per-account
  // and there is no constant to copy. Measure the live one instead of guessing.
  const [box, setBox] = useState(FALLBACK);
  useEffect(() => {
    const r = document.querySelector('.titlebar-account')?.getBoundingClientRect();
    if (r?.width) setBox({ w: Math.round(r.width), h: Math.round(r.height) });
  }, []);

  // Lifted verbatim from styles.css .candy-face + .candy-btn (--cbtn-band is
  // --surface at rest, --cbtn-frame is 2px, radius is --radius-md).
  // ponytail: copied, not classed — these are plain divs, not buttons, and
  // wearing .candy-btn would drag in the press/hover/depth machinery too.
  const skin = {
    width: box.w,
    height: box.h,
    boxSizing: 'border-box',       // frame eats into the box — rectangles stay equal
    background: 'var(--surface-3)',
    border: '2px solid color-mix(in oklch, var(--surface), black 22%)',
    borderRadius: 'var(--radius-md)',
  };

  const flap = Math.min(angle, 180);          // bottom rectangle onto the middle
  const pair = Math.max(0, angle - 180);      // that pair onto the top

  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        margin: '20px 0 10px',
      }}>Fold</div>

      {/* width must match the rectangles — perspective-origin defaults to this
          element's centre, and a wider parent puts the vanishing point off to
          the right, which skews the fold sideways. */}
      <div style={{ perspective: PERSPECTIVE, width: box.w }}>
        {/* top — never moves; everything folds onto it */}
        <div style={skin} />

        {/* middle + bottom travel together on the second fold, so they share a
            wrapper that hinges on the top rectangle's bottom edge.
            preserve-3d keeps the inner fold in 3D instead of flattening it. */}
        <div style={{
          marginTop: OVERLAP,
          transformStyle: 'preserve-3d',
          ...hinge(pair),
        }}>
          <div style={skin} />
          <div style={{ ...skin, marginTop: OVERLAP, ...hinge(flap) }} />
        </div>
      </div>

      <div style={{ width: SLIDER_W, marginTop: 12 }}>
        <Slider
          value={angle} min={0} max={360} unit="°"
          onChange={setAngle} accent={accent}
        />
      </div>
    </div>
  );
}

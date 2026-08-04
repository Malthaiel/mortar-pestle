// Fold demo — dev toy recreating Josh Comeau's "Folding the DOM":
// https://www.joshwcomeau.com/react/folding-the-dom/
// Two rectangles stacked into a square; the bottom one folds on rotateX from a
// top-edge hinge inside a perspective parent. Each rectangle wears the titlebar
// account chip's skin (.candy-btn > .candy-face at rest), so the crease is just
// the two 2px frames meeting on the hinge.
import { useState } from 'react';
import { Slider } from '../ui/index.js';

const W = 200;
const H = 200;
// Lifted verbatim from styles.css .candy-face + .candy-btn (--cbtn-band is
// --surface at rest, --cbtn-frame is 2px, radius is --radius-md).
// ponytail: copied, not classed — the halves are plain divs, not buttons, and
// wearing .candy-btn would drag in the press/hover/depth machinery too.
const FRAME = 'color-mix(in oklch, var(--surface), black 22%)';

export default function FoldPanel({ accent }) {
  const [angle, setAngle] = useState(0);

  const half = {
    width: W,
    height: H / 2,
    boxSizing: 'border-box',        // frame eats into the box — halves stay equal
    background: 'var(--surface-3)',
    border: `2px solid ${FRAME}`,
    borderRadius: 'var(--radius-md)',
  };

  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        margin: '20px 0 10px',
      }}>Fold</div>

      {/* width must match the halves — perspective-origin defaults to this
          element's centre, and a full-width parent puts the vanishing point
          off to the right, which skews the fold sideways. */}
      <div style={{ perspective: 500, width: W }}>
        <div style={half} />
        <div style={{
          ...half,
          transform: `rotateX(${angle}deg)`,
          transformOrigin: 'center top',
          willChange: 'transform',
        }} />
      </div>

      <div style={{ width: W, marginTop: 12 }}>
        <Slider
          value={angle} min={0} max={180} unit="°"
          onChange={setAngle} accent={accent}
        />
      </div>
    </div>
  );
}

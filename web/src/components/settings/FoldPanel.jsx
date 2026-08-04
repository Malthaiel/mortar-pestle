// Fold demo — dev toy recreating Josh Comeau's "Folding the DOM":
// https://www.joshwcomeau.com/react/folding-the-dom/
// Two half-height divs share one background sized to the whole image; the
// bottom half shifts its background up so the seam is invisible, then folds on
// rotateX from a top-edge hinge inside a perspective parent.
import { useState } from 'react';
import { Slider } from '../ui/index.js';

const W = 200;
const H = 200;          // mortar.png is 512x512 — keep it square so it doesn't stretch
const SRC = '/mortar.png';

export default function FoldPanel({ accent }) {
  const [angle, setAngle] = useState(0);

  const half = {
    width: W,
    height: H / 2,
    backgroundSize: `${W}px ${H}px`,
    backgroundImage: `url(${SRC})`,
  };

  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        margin: '20px 0 10px',
      }}>Fold</div>

      <div style={{ perspective: 500 }}>
        <div style={half} />
        <div style={{
          ...half,
          backgroundPosition: '0px -100%',
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

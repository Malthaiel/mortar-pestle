// Fold demo — dev toy recreating Josh Comeau's "Folding the DOM":
// https://www.joshwcomeau.com/react/folding-the-dom/
// Two half-height divs stacked into one yellow rectangle; the bottom one folds
// on rotateX from a top-edge hinge inside a perspective parent. The crease is
// the top half's bottom border, sitting exactly on the hinge.
import { useState } from 'react';
import { Slider } from '../ui/index.js';

const W = 200;
const H = 200;
const PAPER = '#f0d24b';
const CREASE = '#b9992c';

export default function FoldPanel({ accent }) {
  const [angle, setAngle] = useState(0);

  const half = {
    width: W,
    height: H / 2,
    background: PAPER,
  };

  return (
    <div>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        margin: '20px 0 10px',
      }}>Fold</div>

      <div style={{ perspective: 500 }}>
        <div style={{
          ...half,
          boxSizing: 'border-box',      // keep the halves equal — border eats into height
          borderBottom: `1px solid ${CREASE}`,
        }} />
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

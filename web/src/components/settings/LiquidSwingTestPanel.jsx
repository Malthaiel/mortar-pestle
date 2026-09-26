// Dev-tab comparison rig for the liquid slide's swing. Kept for future testing
// (Malthaiel, 2026-09-26).
//
// Both rows are plain .candy-split runs lit by the app-wide liquid hover
// (util/liquidHover.js); nothing here draws the hover. While the pointer is
// inside a row, that row sets the shared slide spring's zeta to its own value,
// and hands back the shipped value on the way out. A split only slides while
// the pointer is inside it, so the rest of the app keeps the shipped value.
import { useEffect } from 'react';
import { eyebrowStyle } from '../ui/Eyebrow.jsx';
import { TUNE } from '../../util/liquidHover.js';

const SHIPPED = TUNE.stretch.zeta;
const ROWS = [['Swing', 0.5], ['No swing', 1]];
// Mixed widths on purpose: the swing must look the same between any two parts.
const LABELS = ['Home', '+', 'Queue', 'my mind is a mountain', 'Settings'];

const LABEL = { fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' };

const parts = () => LABELS.map((label) => (
  <button key={label} type="button" className="candy-btn" data-shape="chip">
    <span className="candy-face">{label}</span>
  </button>
));

export default function LiquidSwingTestPanel() {
  useEffect(() => () => { TUNE.stretch.zeta = SHIPPED; }, []);
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ ...eyebrowStyle, margin: '0 0 10px' }}>Liquid slide swing</div>
      <div style={{ display: 'grid', gridTemplateColumns: '110px auto', alignItems: 'center', rowGap: 16, justifyContent: 'start' }}>
        {ROWS.flatMap(([name, zeta]) => [
          <div key={`${name}-label`} style={LABEL}>{name}{zeta === SHIPPED ? ' (now)' : ''}</div>,
          <div key={name}>
            <div
              className="candy-split"
              onPointerEnter={() => { TUNE.stretch.zeta = zeta; }}
              onPointerLeave={() => { TUNE.stretch.zeta = SHIPPED; }}
            >{parts()}</div>
          </div>,
        ])}
      </div>
    </div>
  );
}

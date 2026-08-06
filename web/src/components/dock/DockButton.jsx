// One dock button: an `icon` shape at rest that expands on hover/focus into an
// icon+label pill (see .dock-btn-label in styles.css), wired to the two-layer
// candy `icon` shape with `.is-active` when the route/tool is active. The
// `.dock-btn-slot` wrapper is just the inline-flex layout slot / drag item.

import { candyCenterOffset } from '../../util/candy.js';
import DockFace from './DockFace.jsx';

const ICON_SIZE = 18;

// `updateDot` was removed with the Titlebar Overhaul — it only ever rode the
// settings gear, which moved to the titlebar and now renders the dot itself.
export default function DockButton({ Icon, label, onClick, isActive = false, accent, indicator, children, onContextMenu }) {
  return (
    <div
      className="dock-btn-slot"
      style={{ display: 'inline-flex', position: 'relative' }}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        data-own-press
        className={`candy-btn dock-btn${isActive ? ' is-active' : ''}`}
        data-shape="icon"
        style={{
          // Nudge up half the candy depth so the downward shadow doesn't pull
          // the icon visually low in the bar. candyCenterOffset() reads the icon
          // shape's own --cbtn-depth (small band). See util/candy.js.
          ...candyCenterOffset(),
          ...(accent ? { '--accent': accent } : {}),
        }}
      >
        <DockFace label={label}>{children ?? (Icon && <Icon size={ICON_SIZE}/>)}</DockFace>
        {indicator}
      </button>
    </div>
  );
}

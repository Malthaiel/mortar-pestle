// Full-bleed section header at the top of the primary sidebar — it IS the section.
// Doubles as the sidebar collapse/expand toggle; click flips `expanded` via the
// parent's onToggle.
//
// Candy slab: the accent face fills the section's full width + height; its 3D
// depth shadow forms the section's bottom edge (no separate divider). Collapsed
// shows the centered brand-mark; expanded names WHERE YOU ARE — the active
// module's icon + name, or the page's own name when a non-module page (Docs,
// Settings) has claimed the sidebar. Never blank, never a stale module name.
// The app's own wordmark moved to the titlebar brand button.
// Wires to the two-layer `.candy-btn.is-primary` block (data-variant="brand").

import * as hostIcons from './icons.jsx';

export default function SidebarToggleButton({ accent, expanded, onToggle, label, iconKey }) {
  const Icon = iconKey && hostIcons[iconKey] ? hostIcons[iconKey] : null;
  const tooltip = expanded ? 'Collapse sidebar' : 'Expand sidebar';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={tooltip}
      aria-pressed={!expanded}
      title={tooltip}
      data-own-press
      className="candy-btn is-primary"
      data-shape="block"
      data-variant="brand"
      style={{
        ...(accent ? { '--accent': accent } : {}),
      }}
    >
      <span
        className="candy-face"
        style={{ justifyContent: 'center', padding: expanded ? '0 14px' : '0' }}
      >
        {!expanded && <span className="brand-mark" aria-hidden/>}
        {expanded && (
          <span style={{
            flex: 1, minWidth: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 8,
            overflow: 'hidden',
          }}>
            {Icon && <Icon size={15}/>}
            <span style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{label}</span>
          </span>
        )}
      </span>
    </button>
  );
}

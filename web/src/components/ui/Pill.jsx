// Pill / segmented control family. Both wire to the candy-button language:
//   - Seg:        grouped segmented control (`.candy-seg` tray + seg-option)
//   - FilterChip: standalone chip toggle (`.candy-btn` + data-shape="chip")

// Grouped segmented control. `options` accepts:
//   ['a', 'b']                  // string-only
//   [{ value, label }]          // value+label
//   [{ value, label, Icon }]    // value+label+leading icon (size 12)
export function Seg({ options, value, onChange, accent, disabled }) {
  return (
    <div
      className="candy-seg"
      style={{
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : undefined,
        ...(accent ? { '--accent': accent } : {}),
      }}
    >
      {options.map(o => {
        const optValue = typeof o === 'string' ? o : o.value;
        const optLabel = typeof o === 'string' ? o : o.label;
        const Icon = typeof o === 'object' ? o.Icon : null;
        const active = value === optValue;
        return (
          <button
            key={String(optValue)}
            type="button"
            data-own-press
            onClick={() => { if (disabled) return; onChange(optValue); }}
            className={`candy-btn${active ? ' is-active' : ''}`}
            data-shape="seg-option"
            style={disabled ? { pointerEvents: 'none' } : undefined}
          >
            <span className="candy-face">
              {Icon && <Icon size={12}/>}
              {optLabel}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Standalone pill toggle. Use when buttons aren't grouped (filter chips, etc.).
export function FilterChip({ children, active, accent, onClick, disabled, title, maxWidth, type = 'button' }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-own-press
      className={`candy-btn${active ? ' is-active' : ''}`}
      data-shape="chip"
      style={{
        ...(accent ? { '--accent': accent } : {}),
        ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
        ...(maxWidth ? { maxWidth } : {}),
      }}
    >
      <span
        className="candy-face"
        style={maxWidth ? { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } : undefined}
      >{children}</span>
    </button>
  );
}

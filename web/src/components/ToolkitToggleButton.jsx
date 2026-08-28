// Full-bleed twin of SidebarToggleButton, mounted at the top of the right
// sidebar — it IS the section. Doubles as the right-rail collapse/expand toggle.
// No tagline path, no vault-sync pulse. Candy slab fills the section's full
// width + height; the TOOLKIT label renders inside when expanded. Wires to
// the two-layer `.candy-btn.is-primary` block (data-variant="brand").

export default function ToolkitToggleButton({ accent, expanded, onToggle, lockMode = 'none' }) {
  const tooltip = expanded ? 'Collapse toolkit' : 'Expand toolkit';
  const lockClass = lockMode !== 'none' ? ` is-lock-${lockMode}` : '';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={tooltip}
      aria-pressed={!expanded}
      title={tooltip}
      data-own-press
      className={`candy-btn is-primary${lockClass}`}
      data-shape="block"
      data-variant="brand"
      style={accent ? { '--accent': accent } : undefined}
    >
      <span
        className="candy-face"
        style={{ justifyContent: 'center', padding: expanded ? '0 14px' : '0' }}
      >
        {!expanded && <span className="brand-mark" aria-hidden/>}
        {expanded && (
          <span style={{
            minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            textAlign: 'center',
          }}>{`Version ${import.meta.env.PACKAGE_VERSION || '0.0.0'}`}</span>
        )}
      </span>
    </button>
  );
}

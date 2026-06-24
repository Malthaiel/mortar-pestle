// Reusable left-sidebar pill. Host's Sidebar.jsx uses it for hardcoded
// sections; modules register left-sidebar slots whose render() returns one of
// these. Two-layer candy button (.candy-btn + .sidebar-pill): an immovable base
// carries the depth band, the .candy-face child slides on press. Unlike the
// rest of the candy family the ACTIVE pill is a SUBTLE accent tint, not a full
// accent fill — it's persistent always-on nav (see .sidebar-pill in styles.css).
// Geometry morphs inline between a 32px collapsed icon and an expanded rounded
// pill. Migrated off the legacy .btn3d sidebar variant; the press ripple was
// dropped to unify on the candy press.

export default function SidebarPill({ Icon, label, expanded, accent, active, onClick, mutedAccent }) {
  // --accent drives the active tint; falls back to --text (a neutral grey tint)
  // when a section passes no accent, matching the legacy sidebar pill.
  const accentColor = accent || 'var(--text)';

  return (
    <button
      onClick={onClick}
      title={!expanded ? label : undefined}
      aria-pressed={active}
      data-own-press
      className={`candy-btn sidebar-pill${active ? ' is-active' : ''}${mutedAccent ? ' is-muted' : ''}`}
      style={{
        '--accent': accentColor,
        margin: '0 auto',
        width: expanded ? 'auto' : 32,
        height: expanded ? 34 : 32,
        borderRadius: expanded ? 999 : 8,
        flexShrink: 0,
      }}
    >
      <span
        className="candy-face"
        style={{
          width: '100%', height: '100%',
          padding: expanded ? '0 12px' : 0,
          gap: expanded ? 12 : 0,
          fontSize: 12.5,
          fontWeight: active ? 600 : 500,
        }}
      >
        {!expanded && (
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon size={18}/>
          </span>
        )}
        {expanded && (
          <span style={{
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center',
          }}>{label}</span>
        )}
      </span>
    </button>
  );
}

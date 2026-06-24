// 32×18 custom switch — accent-tinted track, white knob, 120ms slide.
// Promoted from ModulesTab.jsx so the settings tabs (AnimationRows + SoundsTab) share it.

export default function EnableToggle({ enabled, accent, onChange, title }) {
  const handleClick = (e) => {
    e.stopPropagation();
    onChange(!enabled);
  };
  return (
    <button
      onClick={handleClick}
      role="switch"
      aria-checked={enabled}
      title={title}
      style={{
        appearance: 'none', border: 0, padding: 0,
        width: 32, height: 18,
        borderRadius: 9,
        background: enabled
          ? accent
          : 'color-mix(in oklch, var(--text-faint) 40%, transparent)',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background 120ms ease',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: enabled ? 16 : 2,
        width: 14, height: 14,
        borderRadius: 7,
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
        transition: 'left 120ms ease',
      }}/>
    </button>
  );
}

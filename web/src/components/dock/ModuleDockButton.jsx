// Module-group dock button — wraps DockButton with one of three
// active-indicator variants driven by settings.dock.modules.activeIndicator:
//
//   - 'accent-fill' (default) — no extra indicator; the button's own
//     .is-active accent fill marks the active module. (Renamed from
//     'accent-fill-dot' — the dot was removed 2026-06-04; a one-time main.jsx
//     migration maps the old saved value to the new one.)
//
//   - 'vertical-beam' — 1px accent line above the button, gradient-faded.
//     Rendered as a sibling outside the button, since it's an external
//     tether-line affordance.
//
//   - 'lift' — translateY(-2px) on the wrapper plus a soft accent drop-shadow.
//     Pairs spatially with the sidebar's upward slide motion.
//
// The outer wrapper applies transform/filter ONLY when actively lifting — an
// always-on `translateY(0)` would create a needless stacking context and force
// a compositor layer on every dock module button.

import DockButton from './DockButton.jsx';

export default function ModuleDockButton({
  activeIndicator = 'accent-fill',
  isActive = false,
  accent,
  ...rest
}) {
  const accentColor = accent || 'var(--text)';
  const lift = activeIndicator === 'lift' && isActive;
  const beam = isActive && activeIndicator === 'vertical-beam';

  const lifted = lift
    ? {
        transform: 'translateY(-2px)',
        filter: `drop-shadow(0 4px 8px color-mix(in oklch, ${accentColor} 38%, transparent))`,
        transition: 'transform 160ms cubic-bezier(0.16, 1, 0.3, 1), filter 160ms ease',
      }
    : null;

  return (
    <div style={{
      position: 'relative',
      display: 'inline-flex',
      ...lifted,
    }}>
      <DockButton
        isActive={isActive}
        accent={accent}
        indicator={null}
        {...rest}
      />
      {beam && <BeamIndicator accent={accentColor}/>}
    </div>
  );
}

// NOTE: fadeIn keyframe ends at `transform: translateY(0)`, which would clobber
// any inline `translateX(-50%)`. Centering uses `left: calc(50% - half-width)`
// instead so the animation's transform doesn't fight the positioning.
function BeamIndicator({ accent }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 'calc(50% - 0.5px)',
        marginBottom: 4,
        width: 1, height: 26,
        background: `linear-gradient(to top, ${accent}, color-mix(in oklch, ${accent} 12%, transparent))`,
        borderRadius: 1,
        pointerEvents: 'none',
        opacity: 0,
        animation: 'fadeIn 180ms cubic-bezier(0.16, 1, 0.3, 1) forwards',
      }}
    />
  );
}

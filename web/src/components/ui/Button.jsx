import { forwardRef } from 'react';

// Shared button primitives — candy-button (3D depth) family.
// All button primitives here wire to the two-layer `.candy-btn`
// (Primary/Outlined/Danger/HeaderChip/IconBtn/CircleChip). Per-instance
// accent via inline `--accent`.

const accentStyle = (accent) => (accent ? { '--accent': accent } : undefined);

// Filled primary action. Size: small / chip / default.
export function PrimaryBtn({ children, onClick, disabled, accent, small, chip, title, type = 'button' }) {
  const sizeAttr = small ? 'small' : (chip ? 'chip' : undefined);
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-own-press
      className="candy-btn is-primary"
      data-size={sizeAttr}
      style={accentStyle(accent)}
    ><span className="candy-face">{children}</span></button>
  );
}

// Outlined neutral. Same size scaling as PrimaryBtn.
export function OutlinedBtn({ children, onClick, disabled, small, chip, title, type = 'button' }) {
  const sizeAttr = small ? 'small' : (chip ? 'chip' : undefined);
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-own-press
      className="candy-btn"
      data-size={sizeAttr}
    ><span className="candy-face">{children}</span></button>
  );
}

// Destructive outlined. Same size scaling.
export function DangerOutlinedBtn({ children, onClick, disabled, small, chip, title, type = 'button' }) {
  const sizeAttr = small ? 'small' : (chip ? 'chip' : undefined);
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-own-press
      className="candy-btn is-danger"
      data-size={sizeAttr}
    ><span className="candy-face">{children}</span></button>
  );
}

// Outlined circle icon — Planner Reset/Skip + similar. Uses the
// planner-circle treatment (neutral surface-3 face + dark frame).
// `className` appends extra candy modifiers — e.g. `is-hover-accent`, which opts
// the circle back into the base accent-flood hover (the titlebar controls).
// `...rest` spreads onto the BUTTON element (aria-*, data-* hooks) — the
// titlebar's Downloads chip carries [data-downloads-btn] that way, which is
// what DownloadsPanel queries for its anchor rect and its outside-click exempt.
// forwardRef because a fused .candy-split run rounds its DIRECT .candy-btn
// children — a wrapper <span> around a chip breaks the shell — so anything that
// needs the node itself (the notification bell's toast fly-target, the Agents
// popover's anchor rect) has to reach the button, not a box around it.
export const CircleChip = forwardRef(function CircleChip(
  { children, onClick, title, size = 30, className = '', style, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      onClick={onClick}
      title={title}
      data-own-press
      className={`candy-btn${className ? ' ' + className : ''}`}
      data-shape="circle"
      style={{ '--cbtn-size': `${size}px`, ...style }}
      {...rest}
    ><span className="candy-face">{children}</span></button>
  );
});

// Icon-only button. Variants: default (neutral), active, primary, playing.
//   - default: surface-3 face, muted glyph → text on hover
//   - active:  surface-3 face, accent glyph
//   - primary: accent face, white glyph (Play in music module)
//   - playing: primary + soft accent halo
export function IconBtn({ children, onClick, title, size = 28, accent, primary, active, playing, disabled, type = 'button' }) {
  const isPrimary = !!primary;
  const cls = isPrimary
    ? 'candy-btn is-primary'
    : `candy-btn${active ? ' is-active' : ''}`;
  const extraStyle = {};
  // Size lands on --cbtn-size, which the circle shape reads for BOTH axes. A
  // written width/height pair beat every stylesheet rule, so a window asking for
  // one control height could never win against it — and pinning only the height
  // left the width behind, turning circles into ovals. See styles.css § icon.
  if (size) extraStyle['--cbtn-size'] = `${size}px`;
  if (accent) extraStyle['--accent'] = accent;
  if (playing) {
    extraStyle.boxShadow =
      `0 0 14px color-mix(in oklch, ${accent || 'var(--accent)'} 30%, transparent),
       0 0.4em 0 -2px color-mix(in oklch, ${accent || 'var(--accent)'}, black 10%),
       0 0.4em 0 0 color-mix(in oklch, ${accent || 'var(--accent)'}, black 22%)`;
  }
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      disabled={disabled}
      data-own-press
      className={cls}
      data-shape="circle"
      style={{
        ...extraStyle,
        ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : {}),
      }}
    ><span className="candy-face">{children}</span></button>
  );
}

// Compact outlined chip — page header actions. Renders <a> if href given.
export function HeaderChip({ children, onClick, href, title, target }) {
  const sharedProps = {
    title,
    className: 'candy-btn',
    'data-shape': 'chip',
  };
  if (href != null) {
    return <a href={href} target={target} {...sharedProps}><span className="candy-face">{children}</span></a>;
  }
  return <button type="button" data-own-press onClick={onClick} {...sharedProps}><span className="candy-face">{children}</span></button>;
}

// Every badge on the strip is one shape — an accent pip pinned to its button's
// top-right corner, ringed in --surface so it reads against any band. Passing
// no children gives the bare 7px dot (Settings' update flag); a number gives
// the wider count pill (Processes, Downloads).
//
// It rides INSIDE .candy-face on purpose. .candy-face is position:static, so
// the badge anchors to the position:relative .candy-btn above it — which means
// no wrapper <span> around the button. That matters now the four are fused:
// .candy-split squares and overlaps its DIRECT .candy-btn children, and a
// wrapper sitting between them would swallow the :first-child / :last-child
// rounding rules and break the shell. Pinned at right:0 rather than -2 so it
// stops AT the seam instead of spilling over its neighbour; zIndex lifts it
// above the next half's overlapping frame either way.
//
// Colour is the ONE thing this shape does not set inline: `.candy-badge` in
// styles.css owns it, so the pip can invert to a white face when its button
// lights accent. Inline would win over that rule and put accent on accent.
// The two animations stay inline because the pulse-indicators gate matches on
// the inline style text (`[style*="newBadgePulse"]`, `[style*="badgeTick"]`).
export function Badge({ children, title, pulse }) {
  const dot = children == null;
  return (
    <span aria-hidden={!pulse} aria-label={pulse} title={title} className="candy-badge" style={{
      position: 'absolute', top: 0, right: 0,
      minWidth: dot ? 7 : 13, height: dot ? 7 : 13,
      padding: dot ? 0 : '0 3px', boxSizing: 'border-box',
      borderRadius: dot ? '50%' : 7,
      fontSize: 9, fontWeight: 700, lineHeight: '13px', textAlign: 'center',
      fontFamily: dot ? undefined : 'var(--font-mono)',
      boxShadow: '0 0 0 2px var(--surface)',
      animation: dot
        ? 'newBadgePulse 2.5s ease-in-out infinite'
        : 'badgeTick 320ms cubic-bezier(0.34,1.56,0.64,1)',
      pointerEvents: 'none', zIndex: 5,
    }}>{children}</span>
  );
}

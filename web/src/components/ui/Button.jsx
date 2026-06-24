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
export function CircleChip({ children, onClick, title, size = 30, type = 'button' }) {
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      data-own-press
      className="candy-btn"
      data-shape="circle"
      style={{ width: size, height: size }}
    ><span className="candy-face">{children}</span></button>
  );
}

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
  if (size) { extraStyle.width = size; extraStyle.height = size; }
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

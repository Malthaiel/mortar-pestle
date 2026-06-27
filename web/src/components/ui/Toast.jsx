// Presentational toast card — the bottom-right transient-notification card,
// extracted from TransientToastLayer so the chrome is reusable + consistent.
// Dumb by design (mirrors AppWindow's "props, no behavior" stance): the layer
// owns the auto-dismiss timer, the action handler, and the fly-to-dock dismiss;
// this just renders the card. Stays on `.candy-card`; the spring-in animation is
// kept INLINE so the body[data-anim-pulse-indicators="off"] gate (which matches
// `[style*="notif-toast-spring"]`) keeps working. No left accent strip — the
// accent survives only in the glyph bubble.
//
// Props: accent, glyph, title, message?, error?, actions? (rendered node),
// clickable?, onClick?, innerRef?, animateIn=true.

export default function Toast({
  accent,
  glyph,
  title,
  message,
  error,
  actions,
  clickable,
  onClick,
  innerRef,
  animateIn = true,
}) {
  return (
    <div
      ref={innerRef}
      className="candy-card"
      role="status"
      aria-live="polite"
      onClick={clickable ? onClick : undefined}
      style={{
        pointerEvents: 'auto',
        display: 'flex', alignItems: message ? 'flex-start' : 'center', gap: 14,
        padding: '12px 16px', maxWidth: 380,
        color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13,
        cursor: clickable ? 'pointer' : 'default',
        ...(animateIn ? { animation: 'notif-toast-spring-in 280ms cubic-bezier(0.34, 1.56, 0.64, 1) both' } : {}),
      }}
    >
      <span aria-hidden="true" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: message ? 1 : 0,
        background: `color-mix(in oklch, ${accent} 18%, transparent)`,
        color: accent, fontWeight: 700, fontSize: 13,
      }}>{glyph}</span>
      <div style={{ flex: 1, lineHeight: 1.4, minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </div>
        {!error && message && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, wordBreak: 'break-word' }}>
            {message}
          </div>
        )}
        {error && (
          <div style={{ fontSize: 11, color: 'var(--text)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={error}>
            {error}
          </div>
        )}
      </div>
      {actions}
    </div>
  );
}

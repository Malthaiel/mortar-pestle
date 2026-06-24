// SF4 — the recipe confirm/preview tray inside the Concierge window. Mirrors
// PendingEditsTray's slide-down chrome (pendingTrayDown keyframe, var tokens).
// Mounts between MessageList and ChatInput. Recipe round-trips run `hidden`
// (tray-centric flow), so this tray — not the chat transcript — is where the
// proposal is reviewed and applied.

function basename(p) {
  if (!p) return '';
  return String(p).split('/').pop();
}

const STATUS = {
  loading: (f) => `Reading ${basename(f) || 'note'}…`,
  running: (f) => `Organizing ${basename(f) || 'note'}…`,
  applying: () => 'Applying…',
  done: (f) => `Done — ${basename(f) || 'note'} reorganized. Original saved to the recycle bin.`,
};

export default function RecipeTray({ recipeState, def, accent, onApply, onDiscard, onClose }) {
  const { phase, proposal, ctx, error } = recipeState;
  const file = proposal?.path || ctx?.path;
  const showConfirm = (phase === 'confirm' || phase === 'applying') && proposal && def;
  const accentColor = accent || 'var(--text)';

  return (
    <div
      data-aos-no-mark
      style={{
        borderTop: '1px solid var(--border-soft)',
        background: 'var(--surface-2)',
        animation: 'pendingTrayDown 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        flexShrink: 0,
        maxHeight: 360,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{
        padding: '8px 10px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--border-soft)', gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ color: accentColor, fontSize: 11 }}>✦</span>
          <span style={{
            fontSize: 10.5, fontWeight: 700, color: 'var(--text)',
            fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>{def?.label || 'Recipe'}</span>
          {file && (
            <span title={file} style={{
              fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160,
            }}>{basename(file)}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          style={{
            width: 20, height: 20,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none',
            color: 'var(--text-muted)', cursor: 'pointer', borderRadius: 4,
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18"/>
            <line x1="6" y1="18" x2="18" y2="6"/>
          </svg>
        </button>
      </div>

      {showConfirm ? (
        def.renderConfirm(proposal, { onApply, onDiscard, applying: phase === 'applying' })
      ) : phase === 'error' ? (
        <div style={{
          padding: '10px 12px',
          fontSize: 11.5, lineHeight: 1.45,
          color: 'var(--error)', fontFamily: 'var(--font-mono)',
        }}>
          <strong style={{ fontWeight: 700 }}>{error?.code || 'ERROR'}</strong> — {error?.message || String(error || 'Recipe failed')}
        </div>
      ) : (
        <div style={{
          padding: '12px 12px',
          fontSize: 12, color: 'var(--text-muted)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', background: accentColor, flexShrink: 0,
            animation: (phase === 'loading' || phase === 'running' || phase === 'applying')
              ? 'atelierAvatarPulse 1100ms ease-in-out infinite' : 'none',
          }}/>
          {(STATUS[phase] ? STATUS[phase](file) : '…')}
        </div>
      )}
    </div>
  );
}

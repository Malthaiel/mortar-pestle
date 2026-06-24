// SF10 of Design Mode — slide-down tray inside AtelierChatWindow header
// surfacing every pending override. Each row shows the component name,
// the property + new value, and per-row Commit (when target === 'var')
// + Discard buttons.

import { useEffect, useRef } from 'react';

export default function PendingEditsTray({ pending, accent, onCommit, onDiscard, onCommitAll, onDiscardAll, onClose }) {
  const rootRef = useRef(null);
  useEffect(() => {
    // Focus management: nothing to focus by default but Esc closes.
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const commitableCount = pending.filter((p) => p.target === 'var').length;

  return (
    <div
      ref={rootRef}
      data-aos-no-mark
      style={{
        borderBottom: '1px solid var(--border-soft)',
        background: 'var(--surface-2)',
        animation: 'pendingTrayDown 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        flexShrink: 0,
        maxHeight: 280,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{
        padding: '8px 10px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--border-soft)',
        gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: 10.5, fontWeight: 700, color: 'var(--text)',
            fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase',
          }}>Pending</span>
          <span style={{
            fontSize: 10, color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
          }}>{pending.length} · {commitableCount} commitable</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {commitableCount > 0 && (
            <button
              type="button"
              onClick={onCommitAll}
              title="Commit every var-backed override to source"
              style={{
                padding: '3px 8px',
                background: accent || 'var(--text)', color: '#fff',
                border: 'none', borderRadius: 4,
                fontSize: 10, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
              }}
            >Commit all</button>
          )}
          {pending.length > 0 && (
            <button
              type="button"
              onClick={onDiscardAll}
              title="Discard every pending override"
              style={{
                padding: '3px 8px',
                background: 'transparent', color: 'var(--text-muted)',
                border: '1px solid var(--border-soft)', borderRadius: 4,
                fontSize: 10, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
              }}
            >Discard all</button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close tray (Esc)"
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
      </div>
      <div style={{ overflowY: 'auto', padding: '4px 0' }}>
        {pending.length === 0 ? (
          <div style={{
            padding: '10px 12px',
            fontSize: 11, color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)', textAlign: 'center',
          }}>No pending overrides.</div>
        ) : pending.map((p) => (
          <PendingRow key={p.id} edit={p} accent={accent} onCommit={() => onCommit(p)} onDiscard={() => onDiscard(p)}/>
        ))}
      </div>
    </div>
  );
}

function PendingRow({ edit, accent, onCommit, onDiscard }) {
  const offScreen = !edit.sourceFound;
  return (
    <div style={{
      padding: '6px 10px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 8,
      fontFamily: 'var(--font-mono)',
      fontSize: 10.5,
      borderTop: '1px solid var(--border-soft)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.35 }}>
        <span style={{
          color: accent || 'var(--text)', fontWeight: 700,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {edit.component}
          {offScreen && <span style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6, fontSize: 9.5 }}>(off-screen)</span>}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span title={edit.name}>{edit.name}</span>
          {' → '}
          <strong style={{ color: 'var(--text)' }}>{edit.value}</strong>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {edit.target === 'var' ? (
          <button
            type="button"
            onClick={onCommit}
            title="Patch the matched :root token in source"
            style={{
              padding: '2px 7px',
              background: accent || 'var(--text)', color: '#fff',
              border: 'none', borderRadius: 4,
              fontSize: 10, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
            }}
          >Commit</button>
        ) : (
          <span
            title="Raw value — commit-to-source deferred to a later release"
            style={{
              padding: '2px 7px',
              background: 'var(--surface)', color: 'var(--text-faint)',
              border: '1px dashed var(--border-soft)', borderRadius: 4,
              fontSize: 9.5, fontWeight: 600,
              opacity: 0.7,
            }}
          >no commit</span>
        )}
        <button
          type="button"
          onClick={onDiscard}
          title="Discard this override"
          style={{
            padding: '2px 7px',
            background: 'transparent', color: 'var(--text-muted)',
            border: '1px solid var(--border-soft)', borderRadius: 4,
            fontSize: 10, fontWeight: 600, cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
          }}
        >Drop</button>
      </div>
    </div>
  );
}

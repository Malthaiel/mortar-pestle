// SF11 of Design Mode — slide-down tray inside AtelierChatWindow header
// surfacing every git-dirty (tracked-modified) file in the working tree.
// Each row shows the file path + a per-row Discard (git checkout) button;
// the header offers global Commit-all (auto-generated message) + Discard-all.
// Mirrors PendingEditsTray's slide-down chrome (pendingTrayDown keyframe,
// var tokens, inline-style buttons — no .candy-btn). Discard is destructive
// (destroys uncommitted work) so both per-row Discard and Discard-all use an
// inline two-click confirm instead of a modal.

import { useEffect, useRef, useState } from 'react';

export default function WorkingTreeTray({ files, accent, onDiscard, onDiscardAll, onCommitAll, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
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
          }}>Working tree</span>
          <span style={{
            fontSize: 10, color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
          }}>{files.length} dirty</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {files.length > 0 && (
            <button
              type="button"
              onClick={onCommitAll}
              title="Commit every tracked-modified file (auto message)"
              style={{
                padding: '3px 8px',
                background: accent || 'var(--text)', color: '#fff',
                border: 'none', borderRadius: 4,
                fontSize: 10, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
              }}
            >Commit all</button>
          )}
          {files.length > 0 && (
            <DiscardAllButton onDiscardAll={onDiscardAll} />
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
        {files.length === 0 ? (
          <div style={{
            padding: '10px 12px',
            fontSize: 11, color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)', textAlign: 'center',
          }}>Nothing in the working tree.</div>
        ) : files.map((f) => (
          <WorkingTreeRow key={f.path} file={f} accent={accent} onDiscard={() => onDiscard(f.path)}/>
        ))}
      </div>
    </div>
  );
}

// Inline two-click confirm: first click arms (label -> "Confirm", danger tint),
// second click fires onDiscard. Blur or 3s timeout resets. No modal — keeps
// the tray's single-screen, no-inner-scroll feel.
function DiscardAllButton({ onDiscardAll }) {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const arm = () => {
    setConfirming(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setConfirming(false), 3000);
  };
  const fire = () => {
    clearTimeout(timer.current);
    setConfirming(false);
    onDiscardAll();
  };

  return (
    <button
      type="button"
      onClick={confirming ? fire : arm}
      onBlur={() => setConfirming(false)}
      title={confirming ? 'Click again to discard ALL dirty files' : 'Discard every dirty file'}
      style={{
        padding: '3px 8px',
        background: confirming ? 'var(--danger, #c0392b)' : 'transparent',
        color: confirming ? '#fff' : 'var(--text-muted)',
        border: confirming ? 'none' : '1px solid var(--border-soft)',
        borderRadius: 4,
        fontSize: 10, fontWeight: 600, cursor: 'pointer',
        fontFamily: 'var(--font-mono)',
      }}
    >{confirming ? 'Confirm' : 'Discard all'}</button>
  );
}

function WorkingTreeRow({ file, accent, onDiscard }) {
  const slash = file.path.lastIndexOf('/');
  const basename = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const dir = slash >= 0 ? file.path.slice(0, slash) : '';

  const [confirming, setConfirming] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const arm = () => {
    setConfirming(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setConfirming(false), 3000);
  };
  const fire = () => {
    clearTimeout(timer.current);
    setConfirming(false);
    onDiscard();
  };

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
          {basename}
          {file.staged && <span style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 6, fontSize: 9.5 }}>(staged)</span>}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span title={file.path}>{dir}</span>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <button
          type="button"
          onClick={confirming ? fire : arm}
          onBlur={() => setConfirming(false)}
          title={confirming ? 'Click again to discard this file' : 'Discard (git checkout) this file'}
          style={{
            padding: '2px 7px',
            background: confirming ? 'var(--danger, #c0392b)' : 'transparent',
            color: confirming ? '#fff' : 'var(--text-muted)',
            border: confirming ? 'none' : '1px solid var(--border-soft)',
            borderRadius: 4,
            fontSize: 10, fontWeight: 600, cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
          }}
        >{confirming ? 'Confirm' : 'Discard'}</button>
      </div>
    </div>
  );
}
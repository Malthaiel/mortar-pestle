// Shared add-to-library affordance for the discovery surfaces (anime + music).
//
// AddToLibraryButton — full candy button for detail pages: the main segment
// adds with the default status, the chevron segment opens a status menu so the
// initial status can be picked at click time (quick-status). Presentational:
// the caller owns the enqueue + in-library detection. (A hover quick-add chip
// for browse cards was built and removed by request at the SF2 gate.)

import { useEffect, useRef, useState } from 'react';

export function AddToLibraryButton({ accent, statuses, defaultStatus, busy, added, disabled, onAdd }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const dead = !!(busy || added || disabled);
  const text = added ? '✓ In library' : busy ? 'Adding…' : '+ Add to Library';
  const pick = (s) => { setOpen(false); onAdd(s); };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', gap: 3 }}>
      <button
        type="button"
        className="candy-btn"
        data-own-press
        disabled={dead}
        onClick={() => pick(defaultStatus)}
        title={added ? 'Already in your library' : `Add to library as ${String(defaultStatus).replace(/-/g, ' ')}`}
        style={{ '--accent': accent, height: 33, opacity: dead ? 0.65 : 1 }}
      ><span className="candy-face" style={{ padding: '0 14px', fontSize: 13 }}>{text}</span></button>

      <button
        type="button"
        className="candy-btn"
        data-own-press
        disabled={dead}
        onClick={() => setOpen(o => !o)}
        title="Add with a different status…"
        aria-label="Add with a different status"
        aria-expanded={open}
        style={{ '--accent': accent, height: 33, opacity: dead ? 0.65 : 1 }}
      ><span className="candy-face" style={{ padding: '0 9px', fontSize: 11 }}>▾</span></button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 40,
          minWidth: 188, padding: 6, borderRadius: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          boxShadow: '0 10px 28px rgba(0,0,0,0.38)',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {statuses.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => pick(s)}
              style={{
                textAlign: 'left', padding: '7px 10px', borderRadius: 7,
                border: 'none', background: 'transparent', cursor: 'pointer',
                color: 'var(--text)', fontSize: 12.5,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {s.replace(/-/g, ' ')}
              {s === defaultStatus && (
                <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text-faint)' }}>default</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


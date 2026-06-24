// ⚠️ DEPRECATED (App-Wide Context Menu SF6) — no remaining consumers as of
// 2026-06-05. Every surface (RightRailStack, LibraryPane, NotesPane, and the
// music AddToPlaylistButton — the last straggler, migrated 2026-06-05; the
// cassette tile was deleted) now uses the app-wide `context-menu/useContextMenu`
// hook + `ContextMenuRoot` renderer. Kept in place as a reference until a later
// cleanup sweep — do NOT wire new surfaces here; call `useContextMenu()` instead.
//
// Reusable portaled context menu.
// API:
//   <ContextMenu
//     open={!!menu}
//     anchor={{ x, y }}           // viewport coords (e.clientX/clientY)
//     onClose={() => setMenu(null)}
//     accent={accent}
//     header={'Mini variant'}     // optional small header label
//     items={[{ label, checked?, onClick }, ...]}
//   />
//
// Mounts via createPortal to document.body so it escapes any clipping
// ancestor. Closes on Escape, click outside, or any item click.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MIN_WIDTH = 180;
const MAX_WIDTH = 280;
const PAD = 8;

export default function ContextMenu({ open, anchor, onClose, items = [], header, accent }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999, ready: false });

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x;
    let top = anchor.y;
    if (left + rect.width + PAD > vw) left = Math.max(PAD, vw - rect.width - PAD);
    if (top + rect.height + PAD > vh) top = Math.max(PAD, vh - rect.height - PAD);
    setPos({ left, top, ready: true });
  }, [open, anchor]);

  useEffect(() => {
    if (!open) {
      setPos({ left: -9999, top: -9999, ready: false });
      return;
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    }
    function onDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;
  const accentColor = accent || 'var(--text)';

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        left: pos.left, top: pos.top,
        minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md, 8px)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.32), 0 2px 8px rgba(0,0,0,0.18)',
        padding: 4,
        zIndex: 9999,
        opacity: pos.ready ? 1 : 0,
        transition: 'opacity 90ms ease',
      }}
    >
      {header && (
        <div style={{
          padding: '6px 10px 4px',
          fontSize: 9,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--text-faint)',
          fontWeight: 600,
        }}>{header}</div>
      )}
      {items.map((it, i) => {
        if (it.divider) return <div key={i} style={{ height: 1, background: 'var(--border-soft)', margin: '4px 6px' }} />;
        if (it.section) return (
          <div key={i} style={{
            padding: i === 0 ? '2px 10px 4px' : '8px 10px 4px',
            fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.14em',
            textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
          }}>{it.label}</div>
        );
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              it.onClick?.();
              onClose?.();
            }}
            data-own-press
            className="candy-btn"
            data-shape="row"
            data-variant="menu"
            style={{ marginTop: i === 0 ? 0 : 4, ...(accent ? { '--accent': accent } : {}) }}
          >
            <span className="candy-face">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                color: accentColor, fontSize: 12,
              }}>{it.checked ? '✓' : ''}</span>
              <span>{it.label}</span>
            </span>
            </span>
          </button>
        );
      })}
    </div>,
    document.body
  );
}

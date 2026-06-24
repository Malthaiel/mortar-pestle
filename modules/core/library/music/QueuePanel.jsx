// Slide-out queue panel anchored to the right sidebar's left edge.
// Overlays the main content area, sliding leftward when opened.

import { useRef, useState } from 'react';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import AddToPlaylistButton from './AddToPlaylistButton.jsx';
import { refFromQueueItem } from './PlaylistProvider.jsx';

const DOCK_WIDTH = 300;

export default function QueuePanel({ open, onClose, accent }) {
  const { queue, index, jumpToQueueIndex, reorderQueue, removeFromQueue } = useMusicPlayer();
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  const rowRefs = useRef([]);
  const dragRef = useRef({ from: null, to: null });

  // Pointer-drag reorder — HTML5 DnD doesn't fire in the Tauri WebKitGTK webview.
  // A per-row grip handle starts the drag; we track the pointer against row rects
  // to pick the insertion target, then call reorderQueue(from, to) on release.
  const startReorder = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { from: i, to: i };
    setDragIdx(i);
    setOverIdx(i);
    const onMove = (ev) => {
      const y = ev.clientY;
      let target = queue.length - 1;
      for (let k = 0; k < queue.length; k++) {
        const r = rowRefs.current[k]?.getBoundingClientRect();
        if (!r) continue;
        if (y < r.top + r.height / 2) { target = k; break; }
      }
      if (target !== dragRef.current.to) {
        dragRef.current.to = target;
        setOverIdx(target);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const { from, to } = dragRef.current;
      if (from != null && to != null && from !== to) reorderQueue(from, to);
      dragRef.current = { from: null, to: null };
      setDragIdx(null);
      setOverIdx(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="candy-modal" style={{
      position: 'fixed', right: DOCK_WIDTH + 8, bottom: 16,
      width: 360, maxHeight: '60vh',
      transform: open ? 'translateX(0)' : 'translateX(20px)',
      opacity: open ? 1 : 0,
      pointerEvents: open ? 'auto' : 'none',
      transition: 'all 180ms ease',
      zIndex: 1000,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div className="candy-center-row" style={{
        padding: '12px 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}>Queue · {queue.length}</span>
        <button onClick={onClose} title="Close" data-own-press className="candy-btn" data-shape="circle"><span className="candy-face">×</span></button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: '8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {queue.length === 0 && (
          <div style={{
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 12, padding: '32px 24px',
            color: 'var(--text-faint)',
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: 'var(--text-faint)', opacity: 0.5,
            }}/>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Queue is empty</div>
          </div>
        )}
        {queue.map((t, i) => {
          const active = i === index;
          const dragging = dragIdx === i;
          const dropOver = overIdx === i && dragIdx !== null && dragIdx !== i;
          const hovering = hoverIdx === i;
          return (
            <div
              key={i + ':' + (t.audioPath || t.title)}
              ref={(el) => { rowRefs.current[i] = el; }}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(o => (o === i ? null : o))}
              onClick={() => t.available && jumpToQueueIndex(i)}
              className={'candy-btn' + (active ? ' is-playing' : '') + (!t.available ? ' is-unavailable' : '')}
              data-shape="track"
              style={{
                borderTop: dropOver && dragIdx > i ? `2px solid ${accent}` : undefined,
                borderBottom: dropOver && dragIdx < i ? `2px solid ${accent}` : undefined,
                opacity: dragging ? 0.4 : undefined,
              }}
            >
              <div className="candy-face" style={{ padding: '10px 16px' }}>
              <span
                onPointerDown={(e) => startReorder(e, i)}
                onClick={(e) => e.stopPropagation()}
                title="Drag to reorder"
                style={{ flexShrink: 0, width: 12, textAlign: 'center', cursor: 'grab', touchAction: 'none', color: active ? 'rgba(255,255,255,0.7)' : 'var(--text-faint)', fontSize: 12, lineHeight: 1, opacity: hovering ? 0.7 : 0, transition: 'opacity 120ms ease' }}
              >⠿</span>
              <span style={{
                fontSize: 10, fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
                color: active ? '#fff' : 'var(--text-faint)',
                fontWeight: active ? 700 : 500,
                minWidth: 16, textAlign: 'center',
              }}>{active ? '▸' : i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12, color: active ? '#fff' : 'var(--text)',
                  fontWeight: active ? 600 : 500,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  letterSpacing: '-0.005em',
                }}>{t.title}</div>
                <div style={{
                  fontSize: 10, color: active ? 'rgba(255,255,255,0.75)' : 'var(--text-muted)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{t.artist}</div>
              </div>
              <span
                onClick={(e) => e.stopPropagation()}
                style={{
                  flexShrink: 0,
                  opacity: hovering ? 1 : 0,
                  pointerEvents: hovering ? 'auto' : 'none',
                  transition: 'opacity 120ms ease',
                }}
              >
                <AddToPlaylistButton refs={[refFromQueueItem(t)]} accent={accent} />
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); removeFromQueue(i); }}
                title="Remove"
                data-own-press
                className="candy-btn"
                data-shape="circle"
                style={{
                  opacity: hovering ? 1 : 0,
                  pointerEvents: hovering ? 'auto' : 'none',
                  transition: 'opacity 120ms ease',
                  flexShrink: 0,
                }}
              ><span className="candy-face">×</span></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

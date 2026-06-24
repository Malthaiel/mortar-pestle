// A classification rendered AS a candy button (sub-plan 5): click it to open a small
// candy-chip popover and reclassify (replaces the old <select> retag). Used on Notes
// bullets and on review-modal rows. Candy buttons are element-agnostic and .candy-face
// is pointer-events:none, so the click handler sits on the <button>. Positions below the
// trigger, flipping above when there isn't room.
import { useLayoutEffect, useRef, useState } from 'react';
import Popover from '@host/components/ui/Popover.jsx';
import { CLASSIFICATIONS } from './noteCompile.js';
import { classColor } from './classColors.js';

const PANEL_W = 232;

export default function RetagButton({ label, onPick, allowClear = false, placeholder = '+ Tag' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const ref = useRef(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 8, estH = 168;
    const left = Math.max(8, Math.min(r.left, vw - PANEL_W - 8));
    if (r.bottom + gap + estH > vh && r.top - gap - estH > 0) setPos({ left, bottom: vh - r.top + gap });
    else setPos({ left, top: r.bottom + gap });
  }, [open]);

  return (
    <>
      <button ref={ref} type="button" className="candy-btn retag-trigger" data-shape="chip"
        onClick={() => setOpen((o) => !o)} title="Re-tag classification" style={{ flexShrink: 0 }}>
        <span className="candy-face" style={{ color: label ? classColor(label) : 'var(--text-muted)', minWidth: 56 }}>{label || placeholder}</span>
      </button>
      {open && pos && (
        <Popover open onClose={() => setOpen(false)} outsideExempt=".retag-trigger"
          style={{ position: 'fixed', ...pos, width: PANEL_W, zIndex: 4000 }} bodyStyle={{ padding: 8 }} ariaLabel="Re-tag classification">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {CLASSIFICATIONS.map((c) => (
              <button key={c} type="button" className={`candy-btn${c === label ? ' is-active' : ''}`} data-shape="chip"
                onClick={() => { onPick(c); setOpen(false); }}>
                <span className="candy-face" style={{ color: classColor(c) }}>{c}</span>
              </button>
            ))}
            {allowClear && (
              <button type="button" className="candy-btn" data-shape="chip" onClick={() => { onPick(null); setOpen(false); }}>
                <span className="candy-face" style={{ color: 'var(--text-muted)' }}>Clear</span>
              </button>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

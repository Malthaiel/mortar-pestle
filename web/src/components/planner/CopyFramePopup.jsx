// Copy Day Frame popup — portaled above the Planner (z 1100). Clones the
// NewEventModal shell (candy-modal + candy-backdrop + capture-phase Esc) at a
// smaller width. Seven weekday rows with checkboxes: the source day (the
// focused/anchor weekday) is greyed + disabled; Select All / Select None; Copy
// confirms via onCopy (CalendarPane.applyFocusedToDays → copyDayToTargets → one
// writeFrames). Checkboxes start all-unchecked; the recurring template is
// copied only (per-day overrides stay isolated). Flair: checked rows pop in
// sequence (copyDayPop) just before close — gated under body[data-anim-copy-day-pop].

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { OutlinedBtn, PrimaryBtn } from '../ui/index.js';
import { IconX } from '../icons.jsx';
import { DAY_ORDER } from '../../util/frames.js';

const DAY_FULL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

export default function CopyFramePopup({ open, onClose, onCopy, sourceDay, accent = 'var(--accent)' }) {
  const [checked, setChecked] = useState(new Set());
  const [popping, setPopping] = useState(false);

  // Reset selections each time the popup opens.
  useEffect(() => {
    if (!open) return;
    setChecked(new Set());
    setPopping(false);
  }, [open]);

  // Capture-phase Esc so it closes this popup without bubbling to the Planner's
  // own Esc handler (which would close the whole Planner modal).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!popping) onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, popping, onClose]);

  if (!open) return null;

  const toggle = (wd) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(wd)) next.delete(wd); else next.add(wd);
    return next;
  });
  const selectAll = () => setChecked(new Set(DAY_ORDER.filter(wd => wd !== sourceDay)));
  const selectNone = () => setChecked(new Set());
  const checkedList = DAY_ORDER.filter(wd => checked.has(wd));

  const doCopy = () => {
    if (!checked.size || popping) return;
    onCopy?.(checkedList);
    setPopping(true);
    const maxDelay = (checkedList.length - 1) * 40 + 180;
    setTimeout(() => onClose(), maxDelay);
  };

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div onClick={() => { if (!popping) onClose(); }} className="candy-backdrop"/>
      <div
        className="candy-modal"
        role="dialog" aria-modal="true" aria-label="Copy day frame"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative', width: 'min(420px, 94vw)', maxHeight: '80vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          animation: 'plannerModalIn 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
        }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px 12px', borderBottom: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text)' }}>
            Copy {DAY_FULL[sourceDay] || 'Day'}
          </div>
          <button type="button" data-own-press className="candy-btn" data-shape="chip"
            onClick={() => { if (!popping) onClose(); }} aria-label="Close">
            <span className="candy-face" style={{ padding: 5 }}><IconX/></span>
          </button>
        </div>

        {/* Body */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16, overflowY: 'auto', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" data-own-press className="candy-btn" data-shape="chip"
              onClick={selectAll} style={{ '--accent': accent }}>
              <span className="candy-face" style={{ fontSize: 10, padding: '3px 9px' }}>Select All</span>
            </button>
            <button type="button" data-own-press className="candy-btn" data-shape="chip"
              onClick={selectNone}>
              <span className="candy-face" style={{ fontSize: 10, padding: '3px 9px' }}>Select None</span>
            </button>
          </div>
          {DAY_ORDER.map((wd) => {
            const isSource = wd === sourceDay;
            const isChecked = checked.has(wd);
            const popIdx = popping && isChecked ? checkedList.indexOf(wd) : -1;
            return (
              <button
                key={wd}
                type="button"
                disabled={isSource}
                onClick={() => { if (!isSource && !popping) toggle(wd); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  border: `1px solid ${isChecked ? accent : 'var(--border)'}`,
                  background: isChecked ? `color-mix(in oklch, ${accent} 12%, var(--surface))` : 'transparent',
                  color: 'var(--text)',
                  cursor: isSource || popping ? 'not-allowed' : 'pointer',
                  opacity: isSource ? 0.45 : 1,
                  textAlign: 'left',
                  transition: 'background 120ms ease, border-color 120ms ease',
                  animation: popIdx >= 0 ? 'copyDayPop 0.18s ease' : undefined,
                  animationDelay: popIdx >= 0 ? `${popIdx * 40}ms` : undefined,
                }}>
                <span style={{
                  width: 16, height: 16, flexShrink: 0, borderRadius: 4,
                  border: `1.5px solid ${isChecked ? accent : 'var(--text-faint)'}`,
                  background: isChecked ? accent : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--surface)', fontSize: 11, lineHeight: 1, fontWeight: 800,
                }}>{isChecked ? '✓' : ''}</span>
                <span style={{ fontSize: 12.5, fontWeight: 500, flex: 1 }}>{DAY_FULL[wd]}</span>
                {isSource && (
                  <span style={{
                    fontSize: 9, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>source</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 18px', borderTop: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0,
        }}>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {checked.size ? `${checked.size} day${checked.size > 1 ? 's' : ''} selected` : 'Pick target days'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <OutlinedBtn small onClick={() => { if (!popping) onClose(); }}>Cancel</OutlinedBtn>
            <PrimaryBtn small onClick={doCopy} disabled={!checked.size || popping} accent={accent}>Copy</PrimaryBtn>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
// Centered modal for the Planner feature.
//
// Wraps a surface that scales with the app window (92vw × 90vh, no upper cap)
// in a portal at document.body, dims the canvas with a 42% backdrop, and
// animates in via plannerModalIn (fade + scale 0.97→1 over 280ms with
// cubic-bezier(0.16, 1, 0.3, 1)). Esc closes; backdrop click closes.
//
// Body: two columns — Calendar | unified DayPane — split by one drag-seam
// (Planner Overhaul Pivot 2; the old Events/Notes/Library rails + DailyNote
// column and the split/three-column layout toggle are gone). Both columns
// share one day pivot (`pivotDs`): the calendar's prev/next/Today nav and the
// DayPane's date header move the whole planner together. By default each
// column flexes to an equal half; dragging the seam pins the calendar to a
// committed px width (usePlannerSplit).
//
// Pattern mirrors SettingsDrawer.jsx:160-194 but center-aligned instead
// of right-slide.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconX, IconCalendar } from './icons.jsx';
import { IconBtn } from './ui/index.js';
import SidebarSeam from './SidebarSeam.jsx';
import { usePlannerUndo } from '../hooks/usePlannerUndo.js';
import { usePlannerSplit, HEALTH_CONFIG } from '../hooks/usePlannerSplit.js';
import { todayLocalStr } from '../util/time.js';
import CalendarPane from './planner/CalendarPane.jsx';
import DayPane from './planner/DayPane.jsx';
import HealthColumn from './health/HealthColumn.jsx';

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

export default function PlannerModal({ open, onClose, accent }) {
  const modalRef = useRef(null);
  const lastFocusRef = useRef(null);
  const { push: pushUndo, undo: undoOnce, clear: clearUndo } = usePlannerUndo();
  const { width: calWidth, setWidth: setCalWidth, config: splitCfg } = usePlannerSplit();
  const { width: healthWidth, setWidth: setHealthWidth, config: healthCfg } = usePlannerSplit(HEALTH_CONFIG);
  const [isResizing, setIsResizing] = useState(false);
  const bodyRowRef = useRef(null);
  const [rowW, setRowW] = useState(0);

  // Shared day pivot — owned here so the calendar and the DayPane always show
  // the same day. Reset to today on every open (the modal is a fresh surface).
  const [pivotDs, setPivotDs] = useState(() => todayLocalStr());
  useEffect(() => { if (open) setPivotDs(todayLocalStr()); }, [open]);

  useEffect(() => {
    if (!open) return;
    lastFocusRef.current = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        undoOnce();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [draggable="true"]'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => modalRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(t);
      clearUndo();
      if (lastFocusRef.current && typeof lastFocusRef.current.focus === 'function') {
        try { lastFocusRef.current.focus(); } catch {}
      }
    };
  }, [open, onClose, undoOnce, clearUndo]);

  // Measure the body row so the flexed columns can report their live px to
  // the seam (a drag starts from the real width) and so the seam's min/max
  // can bracket that width — no jump at large or small windows. Re-measures on
  // every modal/window resize.
  useEffect(() => {
    if (!open) return;
    const el = bodyRowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setRowW(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  if (!open) return null;

  // Equal-halves math: with no override the calendar flexes to an equal half;
  // flexEach is the px such a column currently occupies, fed to the seam as
  // the drag origin. A pinned calendar subtracts from the pool.
  const SEAMS_PX = 12; // two 6px hotzone seams: calendar|day and day|health
  const healthEff = healthWidth ?? healthCfg.def; // health is always a pinned px basis
  const flexCols = 1 + (calWidth == null ? 1 : 0);
  const flexEach = rowW > 0
    ? Math.max(0, (rowW - SEAMS_PX - (calWidth || 0) - healthEff) / flexCols)
    : splitCfg.def;
  const calEff = calWidth ?? flexEach;

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div onClick={onClose} className="candy-backdrop"/>
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Planner"
        className="candy-modal"
        style={{
          position: 'relative',
          width: '92vw',
          height: '90vh',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          outline: 'none',
          animation: 'plannerModalIn 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
        }}>
        {/* Header */}
        <div className="candy-center-row" style={{
          padding: '18px 22px 14px',
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 17, fontWeight: 600,
            letterSpacing: '-0.01em', color: 'var(--text)',
          }}>
            <IconCalendar size={18}/>
            <span>Planner</span>
          </div>
          <IconBtn onClick={onClose} title="Close" size={30}><IconX/></IconBtn>
        </div>

        {/* Body — calendar + unified day pane, split by one draggable seam. */}
        <div ref={bodyRowRef} style={{ flex: 1, minHeight: 0, display: 'flex', overflowX: 'auto' }}>
          {/* Left: Calendar (its own borderRight divides it from the seam). */}
          <div style={{
            flex: calWidth == null ? 1 : `0 0 ${calWidth}px`,
            minWidth: calWidth == null ? splitCfg.min : 0,
            display: 'flex', flexDirection: 'column', minHeight: 0,
            transition: isResizing ? 'none' : 'flex-basis 180ms ease',
          }}>
            <CalendarPane
              accent={accent}
              pushUndo={pushUndo}
              pivotDs={pivotDs}
              onPivotChange={setPivotDs}
            />
          </div>
          <SidebarSeam
            width={calEff}
            onWidthChange={setCalWidth}
            accent={accent || 'var(--text)'}
            defaultWidth={null}
            minWidth={Math.min(splitCfg.min, Math.floor(calEff))}
            maxWidth={Math.max(splitCfg.max, Math.ceil(calEff))}
            snapTargets={splitCfg.snap}
            presets={splitCfg.presets}
            storageKey={splitCfg.key}
            ariaLabel="Resize calendar pane"
            edgeRingSide="right"
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
          />
          {/* Middle: the unified day pane — the flex absorber, floored so the
              always-on health column can't crush it (small-window fallback: the
              body row scrolls horizontally below the combined column mins). */}
          <div style={{
            flex: 1, minWidth: 360, minHeight: 0,
            display: 'flex', flexDirection: 'column',
          }}>
            <DayPane
              accent={accent}
              pivotDs={pivotDs}
              onPivotChange={setPivotDs}
            />
          </div>
          {/* Health seam — left-edge + inverted: dragging left grows the
              column to the right of it. */}
          <SidebarSeam
            width={healthEff}
            onWidthChange={setHealthWidth}
            accent={accent || 'var(--text)'}
            defaultWidth={healthCfg.def}
            minWidth={Math.min(healthCfg.min, Math.floor(healthEff))}
            maxWidth={Math.max(healthCfg.max, Math.ceil(healthEff))}
            snapTargets={healthCfg.snap}
            presets={healthCfg.presets}
            storageKey={healthCfg.key}
            ariaLabel="Resize health column"
            edgeRingSide="left"
            inverted
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
          />
          {/* Right: the always-on Health column (pinned/resizable px basis). */}
          <div style={{
            flex: `0 0 ${healthEff}px`, minWidth: 0, minHeight: 0,
            display: 'flex', flexDirection: 'column',
            transition: isResizing ? 'none' : 'flex-basis 180ms ease',
          }}>
            <HealthColumn
              accent={accent}
              pivotDs={pivotDs}
              onPivotChange={setPivotDs}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

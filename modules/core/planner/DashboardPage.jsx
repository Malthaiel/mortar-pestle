// Planner Dashboard — the /planner route body. This IS the former
// PlannerModal's content, lifted out of its pop-up shell (Planner
// Consolidation): the portal, backdrop, candy-modal chrome, header row, Esc
// handler, Tab focus trap and plannerModalIn animation are gone; the modal
// file is deleted. Everything below the header is unchanged.
//
// THREE columns (user-directed 2026-08-28, reverting the 2026-08-27 stack):
// the calendar, the unified DayPane and Health sit side by side, split by two
// vertical seams. All three panes share one day pivot (`pivotDs`); the calendar
// header's prev/next/Today nav and its day-picker chip (which stayed there when
// DayPane's own header was deleted) move the whole dashboard together. By
// default the calendar and day list flex to equal halves of the pool while
// health keeps a pinned px basis; dragging a seam pins that pane.
//
// Both dividers are owned HERE, on the wrapper divs — the seam component paints
// nothing at rest, so the line has to be a border on a neighbour, and exactly
// one neighbour per seam or it doubles (the pair once painted two lines 6px
// apart, measured at x=759 and x=766).
//
// Ctrl+Z is scoped to this page being mounted (it was scoped to the modal
// being open). EditorPage owns the only other Ctrl+Z and never co-renders.

import { useEffect, useRef, useState } from 'react';
import ResizeSeam, { DRAG_EASE } from '@host/components/ui/ResizeSeam.jsx';
import { usePlannerUndo } from '@host/hooks/usePlannerUndo.js';
import { usePlannerSplit, HEALTH_CONFIG } from '@host/hooks/usePlannerSplit.js';
import { todayLocalStr } from '@host/util/time.js';
import CalendarPane from '@host/components/planner/CalendarPane.jsx';
import DayPane from '@host/components/planner/DayPane.jsx';
import HealthColumn from '@host/components/health/HealthColumn.jsx';

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

export default function DashboardPage({ accent }) {
  const { push: pushUndo, undo: undoOnce, clear: clearUndo } = usePlannerUndo();
  const { width: calWidth, setWidth: setCalWidth, config: splitCfg } = usePlannerSplit();
  const { width: healthWidth, setWidth: setHealthWidth, config: healthCfg } = usePlannerSplit(HEALTH_CONFIG);
  const [isResizing, setIsResizing] = useState(false);
  const bodyRowRef = useRef(null);
  const [rowW, setRowW] = useState(0);

  // Shared day pivot — owned here so all three columns show the same day.
  const [pivotDs, setPivotDs] = useState(() => todayLocalStr());

  // Ctrl+Z while the dashboard is mounted. Undo entries are cleared on unmount
  // so navigating away can't replay a stale inverse.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        undoOnce();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearUndo();
    };
  }, [undoOnce, clearUndo]);

  // Measure the body row so the flexed columns can report their live px to the
  // seam (a drag starts from the real width) and so the seam's min/max can
  // bracket that width — no jump at large or small windows.
  useEffect(() => {
    const el = bodyRowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setRowW(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  return (
    <div
      className="planner-uniform-btns" data-uniform-height="--planner-btn-h"
      style={{
        flex: 1, minWidth: 0, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--surface)',
      }}>
      {/* Body — calendar + unified day pane + health, split by two seams. */}
      <div ref={bodyRowRef} style={{ flex: 1, minHeight: 0, display: 'flex', overflowX: 'auto' }}>
        {/* Left: Calendar (its own borderRight divides it from the seam). */}
        <div style={{
          flex: calWidth == null ? 1 : `0 0 ${calWidth}px`,
          minWidth: calWidth == null ? splitCfg.min : 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          // No borderRight — this seam's divider lives on the DAY column's LEFT
          // edge instead (below), on the far side of the 6px seam. Painted here
          // it sat 7px left of where the day pane's section hairlines start, so
          // every hairline stopped short of it (measured x=789 vs x=796).
          // Still exactly ONE neighbour per seam, just the other one.
          // A drag TRAILS the cursor on ResizeSeam's shared clock rather than
          // tracking it 1:1 — same lag and curve as the seam's own menu.
          transition: isResizing ? `flex-basis ${DRAG_EASE}` : 'flex-basis 180ms ease',
        }}>
          <CalendarPane
            accent={accent}
            pushUndo={pushUndo}
            pivotDs={pivotDs}
            onPivotChange={setPivotDs}
          />
        </div>
        <ResizeSeam
          width={calEff}
          onWidthChange={setCalWidth}
          accent={accent || 'var(--text)'}
          defaultWidth={null}
          minWidth={Math.min(splitCfg.min, Math.floor(calEff))}
          maxWidth={Math.max(splitCfg.max, Math.ceil(calEff))}
          presets={splitCfg.presets}
          storageKey={splitCfg.key}
          ariaLabel="Resize calendar pane"
          onDragStart={() => setIsResizing(true)}
          onDragEnd={() => setIsResizing(false)}
        />
        {/* Middle: the unified day pane — the flex absorber, floored so the
            always-on health column can't crush it (small-window fallback: the
            body row scrolls horizontally below the combined column mins). Owns
            the borderRight that IS the health seam's divider. */}
        <div style={{
          flex: 1, minWidth: 360, minHeight: 0,
          display: 'flex', flexDirection: 'column',
          borderLeft: '1px solid var(--border)',
          borderRight: '1px solid var(--border)',
        }}>
          <DayPane
            accent={accent}
            pivotDs={pivotDs}
            onPivotChange={setPivotDs}
          />
        </div>
        {/* Health seam — left-edge + inverted: dragging left grows the
            column to the right of it. */}
        <ResizeSeam
          width={healthEff}
          onWidthChange={setHealthWidth}
          accent={accent || 'var(--text)'}
          defaultWidth={healthCfg.def}
          minWidth={Math.min(healthCfg.min, Math.floor(healthEff))}
          maxWidth={Math.max(healthCfg.max, Math.ceil(healthEff))}
          presets={healthCfg.presets}
          storageKey={healthCfg.key}
          ariaLabel="Resize health column"
          inverted
          onDragStart={() => setIsResizing(true)}
          onDragEnd={() => setIsResizing(false)}
        />
        {/* Right: the always-on Health column (pinned/resizable px basis). */}
        <div style={{
          flex: `0 0 ${healthEff}px`, minWidth: 0, minHeight: 0,
          display: 'flex', flexDirection: 'column',
          transition: isResizing ? `flex-basis ${DRAG_EASE}` : 'flex-basis 180ms ease',
        }}>
          <HealthColumn
            accent={accent}
            pivotDs={pivotDs}
            onPivotChange={setPivotDs}
          />
        </div>
      </div>
    </div>
  );
}

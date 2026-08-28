// Planner Dashboard — the /planner route body. This IS the former
// PlannerModal's content, lifted out of its pop-up shell (Planner
// Consolidation): the portal, backdrop, candy-modal chrome, header row, Esc
// handler, Tab focus trap and plannerModalIn animation are gone; the modal
// file is deleted. Everything below the header is unchanged.
//
// TWO columns since 2026-08-27 (user-directed): the calendar and the unified
// DayPane are STACKED in the left column — calendar on top, day list under it,
// split by a HORIZONTAL drag seam — and Health is the one full-height column on
// the right behind its own vertical seam. All three panes share one day pivot
// (`pivotDs`); the calendar header's prev/next/Today nav and its day-picker chip
// (moved out of DayPane's now-deleted header) move the whole dashboard together.
// By default the calendar and day list flex to equal halves of the left column
// while health keeps a pinned px basis; dragging a seam pins that pane.
//
// Both dividers are owned HERE, on the wrapper divs — the seam component paints
// nothing at rest, so the line has to be a border on a neighbour, and exactly
// one neighbour per seam or it doubles.
//
// Ctrl+Z is scoped to this page being mounted (it was scoped to the modal
// being open). EditorPage owns the only other Ctrl+Z and never co-renders.

import { useEffect, useRef, useState } from 'react';
import ResizeSeam, { DRAG_EASE } from '@host/components/ui/ResizeSeam.jsx';
import { usePlannerUndo } from '@host/hooks/usePlannerUndo.js';
import { usePlannerSplit, HEALTH_CONFIG, CALENDAR_HEIGHT_CONFIG } from '@host/hooks/usePlannerSplit.js';
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
  const { width: calHeight, setWidth: setCalHeight, config: calCfg } = usePlannerSplit(CALENDAR_HEIGHT_CONFIG);
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

  // Measure the LEFT STACK's HEIGHT so the calendar can report its live px to
  // the horizontal seam (a drag starts from the real height) and so the seam's
  // min/max can bracket it — no jump at tall or short windows.
  useEffect(() => {
    const el = bodyRowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setRowW(el.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Equal-halves math on the VERTICAL axis now: with no override the calendar
  // takes an equal half of the left stack; calEff is the px it currently
  // occupies, fed to the seam as the drag origin.
  const SEAM_PX = 6; // the one 6px hotzone between calendar and day list
  const healthEff = healthWidth ?? healthCfg.def; // health is always a pinned px basis
  const calEff = calHeight ?? (rowW > 0 ? Math.max(0, (rowW - SEAM_PX) / 2) : calCfg.def);

  return (
    <div
      className="planner-uniform-btns" data-uniform-height="--planner-btn-h"
      style={{
        flex: 1, minWidth: 0, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--surface)',
      }}>
      {/* Body — the stacked left column + health, split by one vertical seam. */}
      <div ref={bodyRowRef} style={{ flex: 1, minHeight: 0, display: 'flex', overflowX: 'auto' }}>
        {/* Left column — calendar over day list. Owns the borderRight that IS
            the divider against the health seam. */}
        <div style={{
          flex: 1, minWidth: 360, minHeight: 0,
          display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--border)',
        }}>
          {/* Calendar (top). */}
          <div style={{
            flex: calHeight == null ? 1 : `0 0 ${calHeight}px`,
            minHeight: calHeight == null ? calCfg.min : 0,
            display: 'flex', flexDirection: 'column',
            // A drag TRAILS the cursor on ResizeSeam's shared clock rather than
            // tracking it 1:1 — same lag and curve as every other seam.
            transition: isResizing ? `flex-basis ${DRAG_EASE}` : 'flex-basis 180ms ease',
          }}>
            <CalendarPane
              accent={accent}
              pushUndo={pushUndo}
              pivotDs={pivotDs}
              onPivotChange={setPivotDs}
            />
          </div>
          {/* Horizontal seam — drag up/down to resize the calendar. No presets:
              the preset fold menu unfolds sideways off a vertical divider and
              is skipped on an empty list. */}
          <ResizeSeam
            horizontal
            width={calEff}
            onWidthChange={setCalHeight}
            accent={accent || 'var(--text)'}
            defaultWidth={null}
            minWidth={Math.min(calCfg.min, Math.floor(calEff))}
            maxWidth={Math.max(calCfg.max, Math.ceil(calEff))}
            presets={[]}
            storageKey={calCfg.key}
            ariaLabel="Resize calendar height"
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
          />
          {/* Day list (bottom) — the flex absorber, floored so a tall calendar
              can't crush it. Owns the borderTop that IS the horizontal seam's
              divider. */}
          <div style={{
            flex: 1, minHeight: 180,
            display: 'flex', flexDirection: 'column',
            borderTop: '1px solid var(--border)',
          }}>
            <DayPane
              accent={accent}
              pivotDs={pivotDs}
              onPivotChange={setPivotDs}
            />
          </div>
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

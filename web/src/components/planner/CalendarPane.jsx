// Calendar pane for the Planner modal. Wraps the existing
// `modules/core/planner/CalendarPanel.jsx` and adds a Day↔3-day
// segmented toggle in its own header. View-mode state is local to this
// pane — switching here does NOT affect the main planner dock's
// CalendarPanel (which always shows Day in `PlannerDock.jsx:179`).
//
// Sources sessions, plan/fixed blocks, settings, and session callbacks
// from the existing PlannerProvider context, which still wraps this
// component because Portal preserves the React tree even though the
// modal is DOM-mounted at document.body.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CalendarPanel, { getVisibleDays } from '@modules/core/planner/CalendarPanel.jsx';
import { usePlanner } from '@modules/core/planner/PlannerProvider.jsx';
import { DRAG_DURATIONS } from '@modules/core/planner/dragDurations.js';
import { Seg, OutlinedBtn } from '@host/components/ui/index.js';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import BlockLibraryPopover from './BlockLibraryPopover.jsx';
import { IconChevronLeft, IconChevronRight } from '@host/components/icons.jsx';
import { weekdayForKey, dateFromKey, keyForDate } from '@host/util/events.js';
import { minsToHM, todayLocalStr } from '@host/util/time.js';
import { useBlockLibrary } from '@host/hooks/useBlockLibrary.js';
import { useFrameEditing } from '@host/hooks/useFrameEditing.js';
import { DAY_ORDER, WEEKDAY_KEYS, WEEKEND_KEYS, copyDayToTargets } from '@host/util/frames.js';

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}
const DAY_FULL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

export default function CalendarPane({ accent, pushUndo, pivotDs, onPivotChange }) {
  const p = usePlanner();
  const { blocks } = useBlockLibrary();
  const [viewMode, setViewMode] = useState('day');
  const [frameEditMode, setFrameEditMode] = useState(false);
  // Block Library popover (Pivot 2) — anchored below its header chip.
  const [libOpen, setLibOpen] = useState(false);
  const libBtnRef = useRef(null);
  // The day pivot is owned by PlannerModal (shared with the DayPane) — this
  // pane renders it and navigates via onPivotChange. Shift ±delta days in
  // BOTH Day and 3-day view (the 3-day window slides by one day — it does NOT
  // page by 3). No clamping: the Planner may look at past or future days
  // freely.
  const anchorDate = useMemo(() => dateFromKey(pivotDs), [pivotDs]);
  const goToDay = useCallback((delta) => {
    const next = dateFromKey(pivotDs);
    next.setDate(next.getDate() + delta);
    onPivotChange(keyForDate(next));
  }, [pivotDs, onPivotChange]);
  const goToToday = useCallback(() => onPivotChange(todayLocalStr()), [onPivotChange]);
  const blocksById = useMemo(() => {
    const m = new Map();
    blocks.forEach(b => m.set(b.id, b));
    return m;
  }, [blocks]);

  // Daily Frame: compute visible dates + fetch per-day frame segments
  // (canonical Schedule.md + each day's frame_override merged via
  // mergeFrameForDate), then merge into the session list passed to
  // CalendarPanel so packDaySessions lanes frame + real sessions together.
  const visibleDates = useMemo(
    () => getVisibleDays(viewMode, anchorDate, 3),
    [viewMode, anchorDate]
  );
  const dateKeys = useMemo(
    () => visibleDates.map(d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`),
    [visibleDates]
  );
  const { mergeIntoSessions, frames, writeFrames, handlers: frameHandlers } = useFrameEditing(dateKeys, { pushUndo });
  const sessionsWithFrame = useMemo(() => mergeIntoSessions(p.sessions), [mergeIntoSessions, p.sessions]);

  // sessionsRef keeps the latest sessions array accessible to undo closures
  // (otherwise an inverse() created at drop time would see stale sessions).
  const sessionsRef = useRef(p.sessions);
  useEffect(() => { sessionsRef.current = p.sessions; }, [p.sessions]);

  const pushSessionUndo = useCallback((label, ds, startHM, endHM, task) => {
    if (!pushUndo) return;
    pushUndo({
      label,
      inverse: () => {
        const list = sessionsRef.current || [];
        const sess = list.find(s =>
          s.dateKey === ds && s.start === startHM && s.end === endHM && s.task === task);
        if (sess) p.handleSessionDelete?.(ds, sess.id);
      },
    });
  }, [pushUndo, p.handleSessionDelete]);

  const handleBlockDrop = useCallback((ds, blockId, startMins) => {
    const block = blocksById.get(blockId);
    if (!block) return;
    const duration = Number(block.default_duration) || 60;
    const endMins = Math.min(24 * 60, startMins + duration);
    const startHM = minsToHM(startMins);
    const endHM = minsToHM(endMins);
    p.handleSessionCreate?.(ds, startHM, endHM, block.name);
    pushSessionUndo(`Drop ${block.name}`, ds, startHM, endHM, block.name);
  }, [blocksById, p.handleSessionCreate, pushSessionUndo]);

  // ── Frame Edit Mode ──────────────────────────────────────────────────────
  // The Edit Frame button toggles an on-calendar edit mode (replacing the old
  // FrameEditorModal). Every visible day column is editable; each gesture edits
  // that column's weekday template (frames[weekday]) in Schedule.md via
  // writeFrames — live, no Save. `frames` is lowercase-keyed (mon..sun) while
  // weekdayForKey returns 'Mon', hence the .toLowerCase() on every access. Each
  // template edit pushes an undo entry (see useFrameEditing) so Ctrl+Z reverts.
  const focusedWeekday = dateKeys[0] ? weekdayForKey(dateKeys[0]).toLowerCase() : 'mon';
  // Copy-source day: defaults to the anchor (leftmost) column, but the user can
  // pick any visible day from the copy picker. Falls back to the anchor when the
  // chosen weekday scrolls out of view.
  const visibleWeekdays = useMemo(() => dateKeys.map(k => weekdayForKey(k).toLowerCase()), [dateKeys]);
  const [copySource, setCopySource] = useState(null);
  const copySourceDay = (copySource && visibleWeekdays.includes(copySource)) ? copySource : focusedWeekday;
  const copyLabelStyle = {
    fontSize: 9, fontWeight: 700, color: 'var(--text-faint)',
    fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase',
  };

  // Esc exits edit mode. Capture phase + stopImmediatePropagation so the outer
  // PlannerModal's bubble-phase Esc (which closes the whole modal) doesn't also
  // fire. Bail on typing targets so Esc-while-renaming cancels the inline edit
  // instead of leaving edit mode.
  useEffect(() => {
    if (!frameEditMode) return;
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (isTypingTarget(e.target)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      setFrameEditMode(false);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [frameEditMode]);

  const applyFocusedToDays = useCallback(async (targets) => {
    try { await writeFrames(copyDayToTargets(frames, copySourceDay, targets)); } catch (e) { console.error('Frame copy failed', e); }
  }, [frames, copySourceDay, writeFrames]);

  const handleNoteDrop = useCallback((ds, payload, startMins) => {
    const endMins = Math.min(24 * 60, startMins + DRAG_DURATIONS.note);
    const anchor = payload.sourceAnchor || 'Quick Notes';
    const backlink = payload.sourceDate
      ? `Source: [[Pulse/Daily Logs/${payload.sourceDate}#${anchor}]]`
      : '';
    const startHM = minsToHM(startMins);
    const endHM = minsToHM(endMins);
    p.handleSessionCreate?.(ds, startHM, endHM, payload.text, backlink);
    pushSessionUndo(`Promote note`, ds, startHM, endHM, payload.text);
  }, [p.handleSessionCreate, pushSessionUndo]);

  // Plan-block move/resize (non-fixed). The Provider writer persists; we wrap it
  // with an undo step (Planner-only — the dock has no undo stack). The inverse
  // re-moves the block from its new time back to the old one.
  const handlePlanBlockMove = useCallback(async (ds, block, newStart, newEnd) => {
    await p.handlePlanBlockMove?.(ds, block, newStart, newEnd);
    if (pushUndo) {
      pushUndo({
        label: `Move ${block.title}`,
        inverse: async () => {
          await p.handlePlanBlockMove?.(
            ds,
            { ...block, start: newStart, end: newEnd },
            block.start, block.end,
          );
        },
      });
    }
  }, [p.handlePlanBlockMove, pushUndo]);

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      borderRight: '1px solid var(--border)',
    }}>
      {/* Header — view toggle + day navigation (left), Edit Frame (right) */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-soft)',
        flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Seg
            options={[
              { value: 'day',    label: 'Day' },
              { value: 'custom', label: '3-day' },
            ]}
            value={viewMode}
            onChange={setViewMode}
            accent={accent}
          />
          <button
            type="button"
            className="candy-btn"
            data-shape="circle"
            data-own-press
            onClick={() => goToDay(-1)}
            aria-label="Previous day"
          ><span className="candy-face"><IconChevronLeft/></span></button>
          <button
            type="button"
            className="candy-btn"
            data-shape="circle"
            data-own-press
            onClick={() => goToDay(1)}
            aria-label="Next day"
          ><span className="candy-face"><IconChevronRight/></span></button>
          <button
            type="button"
            className="candy-btn"
            data-shape="chip"
            data-own-press
            onClick={goToToday}
            aria-label="Jump to today"
          ><span className="candy-face">Today</span></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {frameEditMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={copyLabelStyle}>Copy</span>
              {visibleWeekdays.length > 1 ? (
                <CandySelect
                  value={copySourceDay}
                  options={visibleWeekdays.map(wd => ({ value: wd, label: DAY_FULL[wd] }))}
                  onChange={setCopySource}
                  title="Source day to copy from"
                  compact
                />
              ) : (
                <span style={copyLabelStyle}>{DAY_FULL[copySourceDay]}</span>
              )}
              <span style={copyLabelStyle}>to</span>
              <OutlinedBtn small onClick={() => applyFocusedToDays(DAY_ORDER)} title="Copy the source day to all 7 days">all</OutlinedBtn>
              <OutlinedBtn small onClick={() => applyFocusedToDays(WEEKDAY_KEYS)} title="Copy the source day to Mon–Fri">weekdays</OutlinedBtn>
              <OutlinedBtn small onClick={() => applyFocusedToDays(WEEKEND_KEYS)} title="Copy the source day to Sat–Sun">weekend</OutlinedBtn>
            </div>
          )}
          <button
            type="button"
            ref={libBtnRef}
            className={`candy-btn planner-blocklib-chip${libOpen ? ' is-active' : ''}`}
            data-shape="chip"
            data-own-press
            onClick={() => setLibOpen(v => !v)}
            aria-expanded={libOpen}
            aria-label="Block Library"
          ><span className="candy-face">Block Library</span></button>
          <button
            type="button"
            className={`candy-btn${frameEditMode ? ' is-active' : ''}`}
            data-shape="chip"
            data-own-press
            onClick={() => setFrameEditMode(v => !v)}
            aria-pressed={frameEditMode}
            aria-label="Edit Daily Frame"
          ><span className="candy-face">{frameEditMode ? 'Done' : 'Edit Frame'}</span></button>
        </div>
      </div>

      <BlockLibraryPopover
        open={libOpen}
        onClose={() => setLibOpen(false)}
        anchorRef={libBtnRef}
        accent={accent}
      />

      {/* Calendar */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <CalendarPanel
          hideHeader
          showDayStrip
          sessions={sessionsWithFrame}
          pivotDate={anchorDate}
          onPivotChange={() => {}}
          viewMode={viewMode}
          onViewModeChange={() => {}}
          customDays={3}
          onCustomDaysChange={() => {}}
          accent={accent}
          hourHeight={p.settings?.calendarHourHeight}
          timeFormat24h={p.settings?.timeFormat24h}
          showHourGutter={p.settings?.showCalendarHourGutter !== false}
          planBlocks={p.planBlocks}
          activePlanKey={p.activePlanKey}
          activeSessionId={p.activeSessionId}
          onSelectPlanBlock={p.selectPlanBlock}
          onSelectSession={p.selectSession}
          activeTaskName={p.activeTaskName}
          onSessionCreate={p.handleSessionCreate}
          onPlanBlockMove={handlePlanBlockMove}
          onSessionResize={p.handleSessionResize}
          onSessionMove={p.handleSessionMove}
          onSessionDelete={p.handleSessionDelete}
          taskDrag={p.taskDrag}
          onTaskDrop={p.handleTaskDrop}
          onBlockDrop={handleBlockDrop}
          onNoteDrop={handleNoteDrop}
          {...frameHandlers}
          frameEditMode={frameEditMode}
          onFrameEditExit={() => setFrameEditMode(false)}
        />
      </div>
    </div>
  );
}

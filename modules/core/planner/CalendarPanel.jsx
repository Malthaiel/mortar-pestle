import { useEffect, useMemo, useRef, useState } from 'react';
import { IconChevronLeft, IconChevronRight, IconX, IconRepeat, IconNotes, IconLayers, IconPlus, IconCalendar, IconReset } from '@host/components/icons.jsx';
import { IconBtn, HeaderChip, Seg, FilterChip } from '@host/components/ui/index.js';
import { fmtHHMMString, fmtHHMMFromHM, fmtClockCompact, fmtHourLabel } from '@host/util/time.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import NewEventModal from '@host/components/planner/NewEventModal.jsx';
import { descFromSession, descFromPlan, isEligibleForPull } from './blockPull.js';

function pad(n) { return String(n).padStart(2, '0'); }
// Minutes-from-midnight → "HH:MM". No %24 on the hour, so a block ending at
// midnight formats "24:00" (the sentinel the frame/override system expects),
// not a wrapped "00:00".
function hm(m) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
// "HH:MM" + "HH:MM" → "7:00 – 8:00" (en-dash range) for block time labels. AM/PM
// is stripped — the left-gutter hour labels already give that context, and 24h
// mode is period-free so the strip is a no-op there.
function fmtRange(start, end, use24h) {
  const t = (s) => fmtHHMMString(s, use24h).replace(/\s*[AP]M$/i, '');
  return `${t(start)} – ${t(end)}`;
}
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
// Per-block visual state while the dock's pull-selection mode is active.
function pullStateOf(desc, pullSelect) {
  if (desc.key === pullSelect.sourceKey) return 'source';
  if (pullSelect.selectedKeys.has(desc.key)) return 'selected';
  return isEligibleForPull(desc, pullSelect.source) ? 'eligible' : 'ineligible';
}

// Assigns each session in a day to a lane so overlapping sessions render
// side-by-side instead of stacked. Greedy sweep: sort by start, place each
// in the lowest-numbered lane whose latest end <= start. Pure; safe to
// recompute every render (small list). Returns sessions with `_lane` and
// `_lanes` (max count) attached.
function packDaySessions(daySessions) {
  if (!daySessions || daySessions.length === 0) return [];
  const items = daySessions.map(s => {
    const [sh, sm] = s.start.split(':').map(Number);
    const [eh, em] = s.end.split(':').map(Number);
    return { s, startMins: sh * 60 + sm, endMins: eh * 60 + em };
  });
  items.sort((a, b) => a.startMins - b.startMins || a.endMins - b.endMins);
  const laneEnds = [];
  const assigned = items.map(item => {
    let lane = laneEnds.findIndex(end => end <= item.startMins);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endMins);
    } else {
      laneEnds[lane] = item.endMins;
    }
    return { ...item.s, _lane: lane };
  });
  const lanes = laneEnds.length;
  return assigned.map(s => ({ ...s, _lanes: lanes }));
}

function getWeekDays(pivot) {
  const d = new Date(pivot);
  const day = d.getDay();
  const start = new Date(d);
  start.setDate(d.getDate() - ((day + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(start); x.setDate(start.getDate() + i); return x; });
}

export function getVisibleDays(viewMode, pivot, customDays = 3) {
  if (viewMode === 'day') return [new Date(pivot)];
  if (viewMode === 'week') return getWeekDays(pivot);
  if (viewMode === 'custom') {
    const n = Math.max(1, Math.min(10, customDays));
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(pivot); d.setDate(d.getDate() + i); return d;
    });
  }
  if (viewMode === 'month') {
    const first = new Date(pivot.getFullYear(), pivot.getMonth(), 1);
    const last = new Date(pivot.getFullYear(), pivot.getMonth() + 1, 0);
    const startOffset = (first.getDay() + 6) % 7;
    const start = new Date(first); start.setDate(first.getDate() - startOffset);
    const endOffset = 6 - ((last.getDay() + 6) % 7);
    const end = new Date(last); end.setDate(last.getDate() + endOffset);
    const days = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(new Date(d));
    return days;
  }
  return getWeekDays(pivot);
}

// Shared pointer-drag for calendar blocks (sessions + fixed plan blocks).
// Reshapes the LIVE drag so the block (1) can't leave the day-column grid,
// (2) magnetizes to the 15-min slot grid while dragging, (3) snaps into
// whichever day column the cursor is over (multi-day), and (4) chases that
// snapped target with the app's exponential-smoothing engine for a light,
// tunable drag. Smoothness + drop-release glide read the same
// `drag-tile-smoothness` / `drag-drop-glide` settings as the module-rail
// reorder; `drag-tile-follow` is intentionally ignored — the calendar always
// slot-snaps. `onCommit(dateKey, startMins, endMins)` persists the move;
// `moving` stays true after release so the block holds at the dropped slot
// until the parent's reload remounts it (no snap-back flash). `releasing`
// flips true at release, which re-enables the block's pointer events right
// away — so it stays clickable even if that remount is delayed or never comes
// (e.g. a persist that no-ops or fails), instead of swallowing the click.
function useBlockDrag({ elRef, startMins, endMins, hourHeight, onCommit, setPressed, lockColumn, shiftMode = false }) {
  const [moving, setMoving] = useState(false);
  const [moveDelta, setMoveDelta] = useState({ x: 0, y: 0 });
  const [liveStart, setLiveStart] = useState(null);
  const [releasing, setReleasing] = useState(false);
  const drag = useRef(null);
  const glideRef = useRef(160);

  // Defensive teardown if the block unmounts mid-drag (e.g. an external
  // re-render) before pointerup runs its own cleanup.
  useEffect(() => () => {
    const d = drag.current;
    if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    window.removeEventListener('pointermove', d.move);
    window.removeEventListener('pointerup', d.up);
    document.removeEventListener('selectstart', d.killSelect);
  }, []);

  function onPointerDown(e) {
    if (e.target.closest('[data-resize]')) return; // resize handle / inline buttons
    if (e.button !== undefined && e.button !== 0) return; // right/middle click → leave it for the context menu
    e.stopPropagation();
    const el = elRef.current;
    const ownCol = el?.closest('[data-day-col]');
    if (!ownCol) return;
    setPressed?.(true);
    // Scope columns to THIS calendar (closest day-col's row), so a second
    // mounted CalendarPanel (e.g. the dock) can't leak its columns in.
    const row = ownCol.parentElement;
    const cols = Array.from(row.querySelectorAll('[data-day-col]'))
      .map(c => ({ dateKey: c.dataset.dayCol, rect: c.getBoundingClientRect() }));
    if (!cols.length) return;
    const originCol = cols.find(c => c.dateKey === ownCol.dataset.dayCol) || cols[0];
    const blockRect = el.getBoundingClientRect();
    const dur = endMins - startMins;
    const originTop = (startMins / 60) * hourHeight;

    const smooth = document.body?.getAttribute('data-anim-drag-tile-smoothness') || 'medium';
    const chaseRate = ({ none: 1, light: 0.35, medium: 0.18, heavy: 0.08 })[smooth] ?? 0.18;
    const glideKey = document.body?.getAttribute('data-anim-drag-drop-glide') || '75';
    glideRef.current = ({ off: 0, '25': 480, '50': 240, '75': 160, '100': 120 })[glideKey] ?? 160;

    const d = {
      cols, originCol, originTop, dur, chaseRate,
      grabOffsetY: e.clientY - blockRect.top,
      startX: e.clientX, startY: e.clientY,
      cursor: { x: e.clientX, y: e.clientY },
      cur: { x: 0, y: 0 },
      lastTarget: null, moved: false, raf: 0, move, up, killSelect,
    };
    drag.current = d;

    // Snapped + clamped target for the current cursor. Column from cursor X
    // (clamped to the end columns → req 1 horizontal + req 3); start minute
    // snapped to 15 and clamped to [0, 1440−dur] → req 1 vertical + req 2.
    function target() {
      const { x, y } = d.cursor;
      // lockColumn (plan blocks) pins to the origin column → today-only,
      // vertical-only; sideways cursor motion can't change the day.
      const col = lockColumn
        ? d.originCol
        : (d.cols.find(c => x >= c.rect.left && x < c.rect.right)
          || (x < d.cols[0].rect.left ? d.cols[0] : d.cols[d.cols.length - 1]));
      const relY = y - col.rect.top - d.grabOffsetY;
      let s = Math.round(((relY / hourHeight) * 60) / 15) * 15;
      // shiftMode (wrap-frame segment drag) shifts the whole frame, so the start
      // isn't capped to the segment's own duration — let it range the full day.
      const maxStart = shiftMode ? (24 * 60 - 15) : (24 * 60 - d.dur);
      s = Math.max(0, Math.min(s, maxStart));
      return {
        dx: col.rect.left - d.originCol.rect.left,
        dy: (s / 60) * hourHeight - d.originTop,
        dateKey: col.dateKey, startMins: s,
      };
    }
    // Per-frame exponential chase toward the snapped target (the "light drag").
    function loop() {
      const t = target();
      d.lastTarget = t;
      setLiveStart(t.startMins);
      d.cur.x += (t.dx - d.cur.x) * d.chaseRate;
      d.cur.y += (t.dy - d.cur.y) * d.chaseRate;
      setMoveDelta({ x: d.cur.x, y: d.cur.y });
      d.raf = requestAnimationFrame(loop);
    }
    function move(ev) {
      d.cursor = { x: ev.clientX, y: ev.clientY };
      if (d.moved) return;
      const ax = ev.clientX - d.startX, ay = ev.clientY - d.startY;
      if (ax * ax + ay * ay > 16) { // 4px threshold before a click becomes a drag
        d.moved = true;
        setPressed?.(false);
        setReleasing(false);
        setMoving(true);
        window.getSelection?.()?.removeAllRanges?.();
        d.raf = requestAnimationFrame(loop);
      }
    }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.removeEventListener('selectstart', killSelect);
      setPressed?.(false);
      if (!d.moved) { drag.current = null; return; } // a click, not a drag
      cancelAnimationFrame(d.raf);
      // Swallow the click that the browser fires after a drag-release.
      const suppress = (e2) => { e2.stopPropagation(); window.removeEventListener('click', suppress, true); };
      window.addEventListener('click', suppress, true);
      const t = d.lastTarget || target();
      setLiveStart(t.startMins);
      // Two-step so the glide transition is live BEFORE the transform changes
      // (a same-render transition+transform swap is skipped by WebKit): enable
      // the transition this frame (block holds at its current lerped spot),
      // then settle onto the final snapped slot next frame so it animates.
      setReleasing(true);
      requestAnimationFrame(() => setMoveDelta({ x: t.dx, y: t.dy }));
      onCommit?.(t.dateKey, t.startMins, t.startMins + d.dur);
      // Keep moving=true; the parent reload remounts the block at its new slot.
    }
    // Kill text-selection for the whole press: once the block goes
    // pointer-events:none mid-drag, the cursor sweeps over the selectable grid /
    // time-label text underneath, where the selection would otherwise re-anchor
    // (the block's own user-select:none can't cover that). removeAllRanges (in
    // move) only clears what formed in the sub-threshold window before this arms.
    function killSelect(ev) { ev.preventDefault(); }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.addEventListener('selectstart', killSelect);
  }

  const dragTransform = `translate3d(${moveDelta.x}px, ${moveDelta.y}px, 0)`;
  const dragTransition = releasing && glideRef.current > 0
    ? `transform ${glideRef.current}ms cubic-bezier(0.32,0.72,0,1)`
    : 'none';
  return { moving, releasing, dragTransform, dragTransition, onPointerDown, liveStart };
}

function PlanBlock({ block, hourHeight, accent, onSelect, isActive, dayDateKey, onPlanBlockMove, timeFormat24h, desc, onBlockTap, pullState = null, onPullToggle }) {
  const [sh, sm] = block.start.split(':').map(Number);
  const [eh, em] = block.end.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  const top = (startMins / 60) * hourHeight;
  const height = Math.max(((endMins - startMins) / 60) * hourHeight, 20);
  const interactive = !!dayDateKey && !!onPlanBlockMove;
  const [hovered, setHovered] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [resizeDY, setResizeDY] = useState(0);
  const elRef = useRef(null);
  // Plan blocks re-time their own line in today's plan fence (today-only → lockColumn).
  const { moving, dragTransform, dragTransition, onPointerDown, liveStart } = useBlockDrag({
    elRef, startMins, endMins, hourHeight,
    lockColumn: true,
    onCommit: (ds, sMins, eMins) => onPlanBlockMove?.(ds, block, hm(sMins), hm(eMins)),
  });

  const currentHeight = Math.max(height + resizeDY, 14);

  function onResizeStart(e) {
    e.stopPropagation(); e.preventDefault();
    const startY = e.clientY;
    setResizing(true);
    function move(ev) {
      const rawMins = ((ev.clientY - startY) / hourHeight) * 60;
      setResizeDY((Math.round(rawMins / 15) * 15 / 60) * hourHeight);
    }
    function up(ev) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(false);
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 4) {
        const minsDelta = Math.round((dy / hourHeight) * 60);
        const snapped = Math.round(minsDelta / 15) * 15;
        if (snapped !== 0) {
          let newEndMins = endMins + snapped;
          if (newEndMins - startMins < 15) newEndMins = startMins + 15;
          newEndMins = Math.min(24 * 60, newEndMins);
          onPlanBlockMove?.(dayDateKey, block, block.start, hm(newEndMins));
        }
      }
      setResizeDY(0);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Live time label while dragging (moving) or resizing — snapped to 15 min so
  // it reads the slot the block will land in. Falls back to the committed range.
  const dur = endMins - startMins;
  const resizeMins = resizing ? Math.round((resizeDY / hourHeight) * 60) : 0;
  const showLive = (moving && liveStart != null) || resizing;
  const liveStartMins = moving && liveStart != null ? liveStart : startMins;
  const liveEndMins = moving && liveStart != null
    ? liveStart + dur
    : Math.min(24 * 60, Math.max(startMins + 15, endMins + resizeMins));
  const liveRange = showLive
    ? fmtRange(hm(liveStartMins), hm(liveEndMins), timeFormat24h)
    : fmtRange(block.start, block.end, timeFormat24h);

  return (
    <div
      ref={elRef}
      data-no-drag
      data-cal-block
      onMouseEnter={() => { if (!pullState) setHovered(true); }}
      onMouseLeave={() => { if (!resizing && !moving) setHovered(false); }}
      onPointerDown={pullState ? (e) => { e.stopPropagation(); } : (interactive ? onPointerDown : undefined)}
      onClick={e => {
        e.stopPropagation();
        if (pullState) {
          if (pullState === 'eligible' || pullState === 'selected') onPullToggle?.();
          return;
        }
        if (onBlockTap && desc) {
          onBlockTap(desc, elRef.current?.getBoundingClientRect() || null);
          return;
        }
        if (!interactive) onSelect?.(block);
      }}
      style={{
        position: 'absolute', left: 3, right: 3, top,
        height: Math.max(currentHeight, 14),
        zIndex: resizing || moving ? 30 : 0,
        background: isActive
          ? `color-mix(in oklch, ${accent} 55%, var(--surface-3))`
          : `color-mix(in oklch, ${accent} 28%, var(--surface-3))`,
        border: `1px solid color-mix(in oklch, ${accent} ${isActive ? 70 : 38}%, var(--border))`,
        borderRadius: 'var(--radius-md)', overflow: 'hidden',
        cursor: pullState
          ? (pullState === 'eligible' || pullState === 'selected' ? 'pointer' : 'default')
          : (interactive ? (moving ? 'grabbing' : 'grab') : 'pointer'),
        display: 'flex', flexDirection: 'column',
        justifyContent: 'center', alignItems: 'stretch',
        gap: 1, paddingLeft: 8, paddingRight: 6, paddingTop: 3, paddingBottom: 3,
        ...(pullState === 'selected' || pullState === 'source'
          ? { outline: '2px solid var(--accent)', outlineOffset: 1 }
          : {}),
        boxShadow: moving ? '0 8px 24px rgba(0,0,0,0.30)' : 'none',
        transform: moving ? dragTransform : 'none',
        transition: resizing ? 'none' : moving ? dragTransition : 'background 80ms, border-color 80ms, box-shadow 120ms, transform 120ms cubic-bezier(0,0,0.58,1)',
        opacity: pullState === 'ineligible' ? 0.45 : (moving ? 0.92 : 1),
        pointerEvents: moving ? 'none' : 'auto',
      }}>
      <div aria-hidden style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        background: `color-mix(in oklch, ${accent} ${isActive ? 95 : 65}%, var(--text-faint))`,
      }}/>
      {pullState === 'selected' && (
        <span aria-hidden style={{
          position: 'absolute', top: 1, right: 5, fontSize: 10, fontWeight: 700,
          color: 'var(--accent)', lineHeight: 1,
        }}>✓</span>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
        <span style={{
          fontSize: 9, fontWeight: 600, color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)', flexShrink: 0, letterSpacing: '0.02em',
        }}>
          {liveRange}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, color: 'var(--text)',
          display: '-webkit-box', WebkitBoxOrient: 'vertical',
          WebkitLineClamp: Math.max(1, Math.floor((Math.max(currentHeight, 14) - 8) / 13)),
          overflow: 'hidden', wordBreak: 'break-word', lineHeight: '13px',
          flex: 1, minWidth: 0, letterSpacing: '-0.005em',
        }}>
          {block.title}
        </span>
      </div>      {interactive && hovered && !moving && (
        <div data-resize="true" data-no-drag onPointerDown={onResizeStart} style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 6,
          cursor: 'ns-resize',
          background: resizing ? 'color-mix(in oklch, var(--text) 14%, transparent)' : 'transparent',
        }}/>
      )}
    </div>
  );
}

// Bare transparent text input that lives directly on a colored block — edits a
// session name in place (new draft or existing-block rename). Enter/Tab/blur
// commit; Escape cancels. data-resize keeps pointerdown from arming a block move.
function InlineNameInput({ value, onChange, onCommit, onCancel, placeholder, selectAll, compact = false }) {
  const ref = useRef(null);
  // Fire commit OR cancel exactly once. A blur can fire right after Enter/Escape
  // or when the input unmounts — without this guard that would double-commit, or
  // let Escape spuriously create a session via the blur path.
  const doneRef = useRef(false);
  const commit = () => { if (!doneRef.current) { doneRef.current = true; onCommit(); } };
  const cancel = () => { if (!doneRef.current) { doneRef.current = true; onCancel(); } };
  // Local undo/redo ring: the input is controlled and WebKitGTK clobbers native
  // input undo on programmatic value writes, so history lives in-component.
  // Ctrl+Z / Ctrl+Shift+Z are fully owned here — the Planner's block-undo
  // must never see them while an editor is open.
  const histRef = useRef({ past: [], future: [] });
  const valueRef = useRef(value);
  valueRef.current = value;
  const edit = (next) => {
    const h = histRef.current;
    h.past.push(valueRef.current);
    if (h.past.length > 200) h.past.shift();
    h.future = [];
    onChange(next);
  };
  const undo = () => {
    const h = histRef.current;
    if (!h.past.length) return;
    h.future.push(valueRef.current);
    onChange(h.past.pop());
  };
  const redo = () => {
    const h = histRef.current;
    if (!h.future.length) return;
    h.past.push(valueRef.current);
    onChange(h.future.pop());
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(0, 0);
  }, []);
  return (
    <input
      ref={ref}
      className="block-name-input"
      data-resize="true"
      data-no-drag
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={e => edit(e.target.value)}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
          e.preventDefault(); e.stopPropagation();
          if (e.shiftKey) redo(); else undo();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      }}
      onBlur={commit}
      style={{
        flex: 1, minWidth: 0, width: '100%',
        background: 'transparent', border: 'none', outline: 'none',
        padding: 0, margin: 0,
        fontSize: compact ? 9 : 10, fontWeight: 600, fontFamily: 'inherit',
        color: 'var(--on-accent)', letterSpacing: '-0.005em',
      }}
    />
  );
}

// The block you drag out (or click to create). Looks identical to a real,
// non-active session block so there's no visual shift on commit. `dragging`
// phase grows with the pointer (no input, pointer-events off so the window
// listeners keep firing); `editing` phase activates the inline name input.
function DraftBlock({ draft, hourHeight, accent, timeFormat24h, onNameChange, onCommit, onCancel }) {
  const editing = draft.phase === 'editing';
  const s = Math.min(draft.startMins, draft.endMins);
  const e = Math.max(draft.startMins, draft.endMins);
  const top = (s / 60) * hourHeight;
  const baseHeight = Math.max(((e - s) / 60) * hourHeight, 14);
  // #1: the block never grows when the inline input opens — short blocks
  // compact the input (font/padding) to fit the dragged size instead.
  const compact = baseHeight < 24;
  return (
    <div style={{
      position: 'absolute', left: 2, right: 2, top, height: baseHeight, zIndex: 40,
      background: `color-mix(in oklch, ${accent} 92%, var(--surface-3))`,
      border: `1px solid color-mix(in oklch, ${accent} 70%, black)`,
      borderRadius: 'var(--radius-md)', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'stretch',
      gap: 1, paddingLeft: 8, paddingRight: 6,
      paddingTop: compact ? 1 : 3, paddingBottom: compact ? 1 : 3,
      boxShadow: 'none',
      pointerEvents: editing ? 'auto' : 'none',
      userSelect: 'none',
    }}>
      <div aria-hidden style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        background: `color-mix(in oklch, ${accent} 100%, black 20%)`,
      }}/>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
        <span style={{
          fontSize: 9, fontWeight: 600, color: 'color-mix(in oklch, var(--on-accent) 78%, transparent)',
          fontFamily: 'var(--font-mono)', flexShrink: 0, letterSpacing: '0.02em',
        }}>
          {fmtRange(hm(s), hm(e), timeFormat24h)}
        </span>
        {editing ? (
          <InlineNameInput
            value={draft.name}
            placeholder="New session"
            selectAll={false}
            compact={compact}
            onChange={onNameChange}
            onCommit={onCommit}
            onCancel={onCancel}
          />
        ) : (
          <span style={{
            fontSize: 10, fontWeight: 600,
            color: 'color-mix(in oklch, var(--on-accent) 55%, transparent)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            flex: 1, minWidth: 0, letterSpacing: '-0.005em',
          }}>New session</span>
        )}
      </div>    </div>
  );
}

function SessionBlock({ session, hourHeight, accent, onDelete, onDuplicate, onResize, onMove, onFrameMove, onRename, onEditingChange, onSelect, onFrameReset, isActive, timeFormat24h, lane = 0, lanes = 1, frameEditMode = false, onFrameRetime, onFrameResize, onFrameDelete, onFrameDeleteToday, onFrameRename, onFrameShift, desc, onBlockTap, pullState = null, onPullToggle, entranceDelay = null }) {
  const isFrame = !!session.meta?.isFrame;
  const isOverridden = !!session.meta?.isOverridden;
  // A split segment of a midnight-wrapping frame (meta.segment 'head'|'tail').
  const isWrapSegment = isFrame && !!session.meta?.segment;
  const { openContextMenu } = useContextMenu();
  // SF10: unified right-click menu. Sessions → Edit name / Duplicate / Delete;
  // frames → Edit name + Delete (edit mode) or Reset override (an overridden
  // frame in normal mode). A plain frame in normal mode yields no items and
  // falls through to the generic chrome menu. Per-block colour is deferred —
  // blocks share the global accent, so there's no Change-colour submenu.
  function onSessionContextMenu(e) {
    const items = [];
    if (isFrame) {
      if (frameEditMode) {
        items.push({ label: 'Edit name', icon: IconNotes, onClick: () => startEdit() });
        items.push({ label: 'Delete frame', icon: IconX, danger: true, onClick: () => onFrameDelete?.(session.dateKey, session.meta?.frameId) });
      } else {
        if (isOverridden && onFrameReset) {
          items.push({ label: 'Reset override', icon: IconReset, onClick: () => onFrameReset(session.dateKey, session.meta?.frameId) });
        }
        items.push({ label: 'Delete for today', icon: IconX, danger: true, onClick: () => onFrameDeleteToday?.(session.dateKey, session.meta?.frameId) });
      }
    } else {
      items.push({ label: 'Edit name', icon: IconNotes, onClick: () => startEdit() });
      items.push({ label: 'Duplicate', icon: IconLayers, onClick: () => duplicateSession() });
      items.push({ label: 'Delete', icon: IconX, danger: true, onClick: () => onDelete?.(session.id) });
    }
    if (!items.length) return; // nothing block-specific → let it bubble to the generic menu
    e.stopPropagation();
    openContextMenu(e, items, { accent });
  }
  function duplicateSession() {
    const dur = Math.max(15, endMins - startMins);
    let ns = endMins, ne = ns + dur;
    if (ne > 24 * 60) { ne = 24 * 60; ns = Math.max(0, ne - dur); }
    onDuplicate?.(hm(ns), hm(ne), session.task || '');
  }
  const [sh, sm] = session.start.split(':').map(Number);
  const [eh, em] = session.end.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  const top = (startMins / 60) * hourHeight;
  const height = Math.max(((endMins - startMins) / 60) * hourHeight, 20);
  const [hovered, setHovered] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [resizeDY, setResizeDY] = useState(0);
  const [resizeEdge, setResizeEdge] = useState('bottom');
  const elRef = useRef(null);
  const { moving, releasing, dragTransform, dragTransition, onPointerDown, liveStart } = useBlockDrag({
    elRef, startMins, endMins, hourHeight,
    // Frame blocks lock to their own column — a drag re-times within that
    // weekday, never moves to another day. In edit mode it rewrites the
    // canonical frame (frames[weekday] in Schedule.md via onFrameRetime);
    // otherwise it commits a per-date override (end recomputed inside
    // handleFrameDrop). Sessions re-time their own line and can change day.
    // A wrap frame's split segment (edit mode) shifts the WHOLE frame by the
    // drag delta via onFrameShift — shiftMode lifts the within-day clamp so the
    // shift isn't capped to the segment's own (half-frame) duration.
    lockColumn: isFrame,
    shiftMode: isWrapSegment && frameEditMode,
    onCommit: isFrame
      ? (frameEditMode
          ? (isWrapSegment
              ? (ds, sMins) => onFrameShift?.(ds, session.meta?.frameId, sMins - startMins)
              : (ds, sMins, eMins) => onFrameRetime?.(ds, session.meta?.frameId, hm(sMins), hm(eMins)))
          : (ds, sMins) => onFrameMove?.(ds, session.meta?.frameId, sMins))
      : (ds, sMins, eMins) => onMove?.(session.id, ds, hm(sMins), hm(eMins)),
  });
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');

  // Edge-resize live preview: the bottom edge grows height (top fixed); the top
  // edge shifts `top` and inversely changes height (bottom fixed).
  const resizeTopDelta = resizing && resizeEdge === 'top' ? resizeDY : 0;
  const resizeBottomDelta = resizing && resizeEdge === 'bottom' ? resizeDY : 0;
  const currentTop = top + resizeTopDelta;
  const currentHeight = Math.max(height - resizeTopDelta + resizeBottomDelta, editing ? 36 : 14);

  // Drag the grabbed edge to retime a block. Sessions → onResize; frames →
  // onFrameRetime in Edit Frame mode (rewrites the weekday frame) or
  // onFrameResize otherwise (per-day override). `edge` is 'top' | 'bottom'.
  function onResizeStart(edge, e) {
    e.stopPropagation(); e.preventDefault();
    const startY = e.clientY;
    setResizeEdge(edge);
    setResizing(true);
    function move(ev) {
      const rawMins = ((ev.clientY - startY) / hourHeight) * 60;
      setResizeDY((Math.round(rawMins / 15) * 15 / 60) * hourHeight);
    }
    function up(ev) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(false);
      const dy = ev.clientY - startY;
      if (Math.abs(dy) > 4) {
        const suppress = (e2) => { e2.stopPropagation(); window.removeEventListener('click', suppress, true); };
        window.addEventListener('click', suppress, true);
        const minsDelta = Math.round((dy / hourHeight) * 60);
        const snapped = Math.round(minsDelta / 15) * 15;
        if (snapped !== 0) {
          // Move only the grabbed edge; keep a ≥15-min duration within [0, 1440].
          let ns = startMins, ne = endMins;
          if (edge === 'top') ns = Math.max(0, Math.min(startMins + snapped, endMins - 15));
          else ne = Math.min(24 * 60, Math.max(endMins + snapped, startMins + 15));
          if (isFrame) {
            if (frameEditMode) onFrameRetime?.(session.dateKey, session.meta?.frameId, hm(ns), hm(ne));
            else onFrameResize?.(session.dateKey, session.meta?.frameId, hm(ns), hm(ne));
          } else {
            onResize?.(session.id, hm(ns), hm(ne));
          }
        }
      }
      setResizeDY(0);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startEdit() {
    if (isFrame && !frameEditMode) return;
    setEditName(session.task || '');
    setEditing(true);
    onEditingChange?.(true);
  }
  function commitEdit() {
    const name = editName.trim();
    setEditing(false);
    onEditingChange?.(false);
    if (name && name !== session.task) {
      if (isFrame) onFrameRename?.(session.dateKey, session.meta?.frameId, name);
      else onRename?.(session.id, name);
    }
  }
  function cancelEdit() {
    setEditing(false);
    onEditingChange?.(false);
  }

  // Live time label while dragging (moving) or resizing — snapped to 15 min so
  // it reads the slot the block will land in. Falls back to the committed range.
  const dur = endMins - startMins;
  const resizeMins = resizing ? Math.round((resizeDY / hourHeight) * 60) : 0;
  const showLive = (moving && liveStart != null) || resizing;
  let liveStartMins = startMins;
  let liveEndMins = endMins;
  if (moving && liveStart != null) {
    liveStartMins = liveStart;
    liveEndMins = liveStart + dur;
  } else if (resizing) {
    if (resizeEdge === 'top') liveStartMins = Math.max(0, Math.min(startMins + resizeMins, endMins - 15));
    else liveEndMins = Math.min(24 * 60, Math.max(startMins + 15, endMins + resizeMins));
  }
  const liveRange = showLive
    ? fmtRange(hm(liveStartMins), hm(liveEndMins), timeFormat24h)
    : fmtRange(session.start, session.end, timeFormat24h);

  return (
    <div
      ref={elRef}
      data-no-drag
      data-cal-block
      data-frame-block={isFrame ? 'on' : undefined}
      onMouseEnter={() => { if (!pullState) setHovered(true); }}
      onMouseLeave={() => { if (!resizing && !moving) setHovered(false); }}
      onPointerDown={pullState || (isWrapSegment && !frameEditMode) ? (e) => { e.stopPropagation(); } : onPointerDown}
      onClick={(e) => {
        // Pull-selection mode: clicks toggle membership, nothing else. With a
        // dock onBlockTap the popover owns the click (frames included);
        // legacy select elsewhere (planner / Pulse calendar).
        if (pullState) {
          e.stopPropagation();
          if (pullState === 'eligible' || pullState === 'selected') onPullToggle?.();
          return;
        }
        if (onBlockTap && desc) {
          e.stopPropagation();
          onBlockTap(desc, elRef.current?.getBoundingClientRect() || null);
          return;
        }
        // #13: in edit-frame mode a plain click opens the inline title edit.
        // `moving` stays true after a real drag (resets on remount), so a
        // drag-release on the same slot never opens the editor.
        if (isFrame && frameEditMode) {
          if (!moving) startEdit();
          return;
        }
        if (!isFrame) onSelect?.(session);
      }}
      onDoubleClick={pullState || (isFrame && !frameEditMode) ? undefined : () => startEdit()}
      onContextMenu={pullState ? (e) => { e.preventDefault(); e.stopPropagation(); } : onSessionContextMenu}
      style={{
        position: 'absolute',
        ...(lanes > 1
          ? {
              left: `calc(${(lane / lanes) * 100}% + 2px)`,
              width: `calc(${100 / lanes}% - 4px)`,
            }
          : { left: 3, right: 3 }),
        top: currentTop, height: currentHeight,
        zIndex: resizing || moving ? 30 : editing ? 40 : (isFrame && frameEditMode ? 12 : 10),
        background: isActive
          ? accent
          : `color-mix(in oklch, ${accent} 92%, var(--surface-3))`,
        border: `1px solid color-mix(in oklch, ${accent} ${isActive ? 100 : 70}%, black)`,
        borderRadius: 'var(--radius-md)', overflow: 'hidden',
        cursor: pullState
          ? (pullState === 'eligible' || pullState === 'selected' ? 'pointer' : 'default')
          : (moving ? 'grabbing' : 'grab'),
        display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'stretch',
        gap: 1, paddingLeft: 8, paddingRight: 6, paddingTop: 3, paddingBottom: 3,
        userSelect: 'none',
        ...(pullState === 'selected' || pullState === 'source'
          ? { outline: '2px solid var(--accent)', outlineOffset: 1 }
          : {}),
        boxShadow: moving ? '0 8px 24px rgba(0,0,0,0.30)' : (isFrame && frameEditMode ? '0 4px 12px rgba(0,0,0,0.25)' : 'none'),
        transition: resizing ? 'none' : moving ? dragTransition : 'background 80ms, box-shadow 120ms, border-color 120ms, height 140ms cubic-bezier(0.32,0.72,0,1), transform 120ms cubic-bezier(0,0,0.58,1)',
        transform: moving ? dragTransform : 'none',
        opacity: pullState === 'ineligible' ? 0.45 : (moving ? 0.92 : 1),
        pointerEvents: moving && !releasing ? 'none' : 'auto',
      }}>
      <div aria-hidden style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        background: `color-mix(in oklch, ${accent} 100%, black 20%)`,
      }}/>
      {pullState === 'selected' && (
        <span aria-hidden style={{
          position: 'absolute', top: 1, right: 5, fontSize: 10, fontWeight: 700,
          color: 'var(--on-accent)', lineHeight: 1,
        }}>✓</span>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
        <span style={{
          fontSize: 9, fontWeight: 600, color: 'color-mix(in oklch, var(--on-accent) 78%, transparent)',
          fontFamily: 'var(--font-mono)', flexShrink: 0, letterSpacing: '0.02em',
        }}>
          {liveRange}
        </span>
        {editing ? (
          <InlineNameInput
            value={editName}
            placeholder="Session name"
            selectAll
            onChange={setEditName}
            onCommit={commitEdit}
            onCancel={cancelEdit}
          />
        ) : (
          <span style={{
            fontSize: 10, fontWeight: 600, color: 'var(--on-accent)',
            display: '-webkit-box', WebkitBoxOrient: 'vertical',
            WebkitLineClamp: Math.max(1, Math.floor((height - 8) / 13)),
            overflow: 'hidden', wordBreak: 'break-word', lineHeight: '13px',
            flex: 1, minWidth: 0, letterSpacing: '-0.005em',
          }}>
            {session.task}
          </span>
        )}
        {isOverridden && (
          <span aria-label="overridden" style={{
            fontSize: 8, fontStyle: 'italic',
            color: 'color-mix(in oklch, var(--on-accent) 62%, transparent)',
            letterSpacing: '0.02em', flexShrink: 0,
          }}>(override)</span>
        )}
      </div>      {session.meta?.isFrame && (
        <div aria-hidden style={{
          position: 'absolute', bottom: 3, right: 4,
          width: 11, height: 11,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'color-mix(in oklch, var(--on-accent) 55%, transparent)',
          pointerEvents: 'none',
        }}>
          <IconRepeat size={11}/>
        </div>
      )}
      {hovered && (
        <button data-resize="true" onClick={e => {
          e.stopPropagation();
          if (!session.meta?.isFrame) { onDelete?.(session.id); return; }
          // Edit mode deletes from the weekly template; normal mode writes a
          // {deleted: true} override for this date only (#10).
          if (frameEditMode) onFrameDelete?.(session.dateKey, session.meta?.frameId);
          else onFrameDeleteToday?.(session.dateKey, session.meta?.frameId);
        }}
          style={{
            position: 'absolute', top: 3, right: 3, width: 16, height: 16,
            borderRadius: 'var(--radius-sm)', border: 'none',
            background: 'rgba(0,0,0,0.22)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--on-accent)', padding: 0,
            transition: 'background 120ms',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.4)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.22)'}>
          <IconX/>
        </button>
      )}
      {hovered && isFrame && !frameEditMode && isOverridden && (
        <button data-resize="true" aria-label="Reset to schedule"
          onClick={e => { e.stopPropagation(); onFrameReset?.(session.dateKey, session.meta?.frameId); }}
          style={{
            position: 'absolute', top: 3, right: 23, width: 16, height: 16,
            borderRadius: 'var(--radius-sm)', border: 'none',
            background: 'rgba(0,0,0,0.22)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--on-accent)', padding: 0, fontSize: 11, lineHeight: 1,
            transition: 'background 120ms',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.4)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.22)'}>
          ↺
        </button>
      )}
      {hovered && !editing && !session.meta?.segment && (
        <>
          <div data-resize="true" data-no-drag onPointerDown={(e) => onResizeStart('top', e)} style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 6,
            cursor: 'ns-resize',
            background: resizing && resizeEdge === 'top' ? 'color-mix(in oklch, var(--on-accent) 22%, transparent)' : 'transparent',
          }}/>
          <div data-resize="true" data-no-drag onPointerDown={(e) => onResizeStart('bottom', e)} style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, height: 6,
            cursor: 'ns-resize',
            background: resizing && resizeEdge === 'bottom' ? 'color-mix(in oklch, var(--on-accent) 22%, transparent)' : 'transparent',
          }}/>
        </>
      )}
    </div>
  );
}

function MonthGrid({ days, monthAnchor, sessionsByDay, accent, today, onSelectDay }) {
  const minsByDay = useMemo(() => {
    const m = {};
    for (const d of days) {
      const ds = dateKey(d);
      const list = sessionsByDay[ds] || [];
      m[ds] = list.reduce((sum, s) => sum + (Number(s.durMin) || 0), 0);
    }
    return m;
  }, [days, sessionsByDay]);
  const maxMins = Math.max(60, ...Object.values(minsByDay));
  const monthIdx = monthAnchor.getMonth();

  return (
    <div className="flex-col" style={{ flex: 1, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(label => (
          <div key={label} style={{
            textAlign: 'center', padding: '8px 0 6px',
            fontSize: 10, fontWeight: 500, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)', letterSpacing: '0.03em',
          }}>{label}</div>
        ))}
      </div>
      <div style={{
        flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
        gridAutoRows: '1fr', gap: 0, padding: 0,
      }}>
        {days.map(d => {
          const ds = dateKey(d);
          const inMonth = d.getMonth() === monthIdx;
          const isToday = isSameDay(d, today);
          const mins = minsByDay[ds] || 0;
          const intensity = mins > 0 ? Math.min(1, mins / maxMins) : 0;
          const cellBg = mins > 0
            ? `color-mix(in oklch, ${accent} ${Math.round(intensity * 60)}%, var(--surface))`
            : 'var(--surface)';
          return (
            <button
              key={ds}
              data-own-press
              onClick={() => onSelectDay(d)}
              className={`candy-btn${isToday ? ' is-today' : ''}`}
              data-shape="daycell"
              style={{ '--cal-cell-face': cellBg, opacity: inMonth ? 1 : 0.45 }}
            >
              <span className="candy-face">
              <span style={{
                fontSize: 11, fontWeight: isToday ? 700 : 500,
                color: isToday ? 'var(--accent)' : 'var(--text)',
                fontFamily: 'var(--font-mono)',
              }}>{d.getDate()}</span>
              {mins > 0 && (
                <span style={{
                  fontSize: 9, fontFamily: 'var(--font-mono)',
                  color: intensity > 0.5 ? 'var(--on-accent)' : 'var(--text-muted)',
                  letterSpacing: '0.05em',
                }}>{mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}</span>
              )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function CalendarPanel({
  sessions, pivotDate, onPivotChange,
  viewMode = 'week', onViewModeChange, customDays = 3, onCustomDaysChange,
  accent, hourHeight = 52, timeFormat24h = true, showHourGutter = true,
  planBlocks = [], activePlanKey, onSelectPlanBlock,
  activeSessionId, onSelectSession, activeTaskName = 'Focus session',
  onSessionCreate, onSessionResize, onSessionMove, onSessionDelete, onSessionRename,
  onPlanBlockMove,
  taskDrag, onTaskDrop,
  onBlockDrop, onNoteDrop, onFrameDrop, onFrameReset, onFrameDeleteToday,
  frameEditMode = false, onFrameEditExit, onToggleFrameEdit,
  onFrameRetime, onFrameResize, onFrameCreate, onFrameDelete, onFrameRename, onFrameShift,
  // restoreAnim: { frameId → delayMs } — one-shot entrance stagger for frame
  // blocks just restored by the reset circle (cleared by the owner after ~1s).
  restoreAnim = null,
  hideHeader = false,
  showDayStrip = false,
  // Block-timer wiring (Planner dock only — absent elsewhere, zero behavior change):
  // onBlockTap(desc, rect) replaces plain click; pullSelect drives selection
  // mode; runningBlockKey highlights the block whose timer is live.
  onBlockTap, pullSelect = null, runningBlockKey = null,
}) {
  const visibleDays = useMemo(
    () => getVisibleDays(viewMode, pivotDate, customDays),
    [viewMode, pivotDate, customDays]
  );
  const [now, setNow] = useState(() => new Date());
  const today = now;
  const blocksRef = useRef({ planBlocks });
  blocksRef.current = { planBlocks };
  const timeFormatRef = useRef(timeFormat24h);
  timeFormatRef.current = timeFormat24h;
  const { openContextMenu } = useContextMenu();
  const [eventModal, setEventModal] = useState(null);

  useEffect(() => {
    let timeoutId;
    const originalTitle = document.title;

    function tick() {
      const t = new Date();
      setNow(t);

      const nowMins = t.getHours() * 60 + t.getMinutes();
      const { planBlocks: pb } = blocksRef.current;
      const next = [...pb]
        .map(b => {
          const [sh, sm] = b.start.split(':').map(Number);
          return { title: b.title, startMins: sh * 60 + sm };
        })
        .filter(b => b.startMins > nowMins)
        .sort((a, b) => a.startMins - b.startMins)[0];

      const nowLabel = fmtHHMMFromHM(t.getHours(), t.getMinutes(), timeFormatRef.current);
      if (next) {
        const mins = next.startMins - nowMins;
        const remaining = mins >= 60
          ? `${Math.floor(mins / 60)}h${mins % 60 ? `${mins % 60}m` : ''}`
          : `${mins}m`;
        document.title = `(${nowLabel}) ${remaining} → ${next.title}`;
      } else {
        document.title = `(${nowLabel}) Focus Timer`;
      }

      timeoutId = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    }

    tick();

    function onVis() {
      if (document.visibilityState === 'visible') {
        clearTimeout(timeoutId);
        tick();
      }
    }
    document.addEventListener('visibilitychange', onVis);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('visibilitychange', onVis);
      document.title = originalTitle;
    };
  }, []);

  const containerRef = useRef(null);
  const [draft, setDraft] = useState(null);
  // draft lifecycle: { ds, startMins, endMins, phase: 'dragging' | 'editing', name }
  const dragRefs = useRef(null);
  // True whenever an inline name editor (new draft OR existing-block rename) is
  // open. Guards handleDayPointerDown so a click-away that commits the editor
  // doesn't also spawn a fresh block (grid pointerdown fires before input blur).
  const editingActiveRef = useRef(false);

  function clearDraft() {
    editingActiveRef.current = false;
    setDraft(null);
  }

  const sessionsByDay = useMemo(() => {
    const map = {};
    for (const d of visibleDays) map[dateKey(d)] = [];
    for (const s of sessions) {
      const dk = s.dateKey || dateKey(new Date());
      if (map[dk]) map[dk].push(s);
      else map[dk] = [s];
    }
    return map;
  }, [sessions, visibleDays]);

  function stepPivot(direction) {
    onPivotChange(d => {
      const n = new Date(d);
      if (viewMode === 'day') n.setDate(n.getDate() + direction);
      else if (viewMode === 'week') n.setDate(n.getDate() + 7 * direction);
      else if (viewMode === 'custom') n.setDate(n.getDate() + customDays * direction);
      else if (viewMode === 'month') n.setMonth(n.getMonth() + direction);
      return n;
    });
  }

  function handleDayPointerDown(ds, e) {
    if (pullSelect) return; // selection mode — no draft creation
    if (taskDrag || editingActiveRef.current) return;
    if (e.target !== e.currentTarget) return;   // empty grid only — not blocks/buttons
    if (e.button !== undefined && e.button !== 0) return;
    const col = e.currentTarget;
    const rect = col.getBoundingClientRect();
    const minsPerPx = (24 * 60) / rect.height;
    const startMins = Math.max(0, Math.min(24 * 60,
      Math.round(((e.clientY - rect.top) * minsPerPx) / 15) * 15));
    dragRefs.current = { ds, colRect: rect, startY: e.clientY, startMins };
    setDraft({ ds, startMins, endMins: startMins, phase: 'dragging', name: '' });

    function onMove(ev) {
      const refs = dragRefs.current;
      if (!refs) return;
      const mpp = (24 * 60) / refs.colRect.height;
      const currentMins = Math.max(0, Math.min(24 * 60,
        Math.round(((ev.clientY - refs.colRect.top) * mpp) / 15) * 15));
      setDraft(d => (d && d.phase === 'dragging') ? { ...d, endMins: currentMins } : d);
    }
    function onUp(ev) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const refs = dragRefs.current;
      dragRefs.current = null;
      if (!refs) return;
      const dy = Math.abs(ev.clientY - refs.startY);
      // In Frame Edit Mode a plain click on empty grid exits the mode; only a
      // real drag (below) creates a frame block.
      if (frameEditMode && dy < 4) { setDraft(null); onFrameEditExit?.(); return; }
      let s, eMins;
      if (dy < 4) {
        // plain click / sub-threshold nudge → default 30-min block, clamped to the day
        s = Math.min(refs.startMins, 24 * 60 - 30);
        eMins = s + 30;
      } else {
        const mpp = (24 * 60) / refs.colRect.height;
        const endRaw = Math.max(0, Math.min(24 * 60,
          Math.round(((ev.clientY - refs.colRect.top) * mpp) / 15) * 15));
        s = Math.min(refs.startMins, endRaw);
        eMins = Math.max(refs.startMins, endRaw);
        if (eMins - s < 15) eMins = s + 15;
        eMins = Math.min(24 * 60, eMins);
      }
      editingActiveRef.current = true;
      setDraft({ ds: refs.ds, startMins: s, endMins: eMins, phase: 'editing', name: '' });
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // SF10: right-click empty grid → New session here / New event. "New session"
  // mirrors the plain-click create (a 30-min inline-name draft); "New event"
  // opens the host NewEventModal seeded with the clicked day + time.
  function handleGridContextMenu(ds, e) {
    if (e.target !== e.currentTarget) return; // empty grid only — blocks own their menu
    if (taskDrag || pullSelect) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minsPerPx = (24 * 60) / rect.height;
    let s = Math.max(0, Math.min(24 * 60, Math.round(((e.clientY - rect.top) * minsPerPx) / 15) * 15));
    s = Math.min(s, 24 * 60 - 30);
    openContextMenu(e, [
      { label: 'New session here', icon: IconPlus, onClick: () => {
        editingActiveRef.current = true;
        setDraft({ ds, startMins: s, endMins: s + 30, phase: 'editing', name: '' });
      } },
      { label: 'New event…', icon: IconCalendar, onClick: () => {
        setEventModal({ open: true, ds, start: hm(s) });
      } },
    ], { accent });
  }

  function confirmDraft() {
    const d = draft;
    if (d && d.name.trim()) {
      const s = Math.min(d.startMins, d.endMins);
      const eMins = Math.max(d.startMins, d.endMins);
      if (frameEditMode) {
        // hm() yields the 24:00 end-of-day sentinel at 1440 (unlike the %24
        // below, which would corrupt a midnight-ending frame block to 00:00).
        onFrameCreate?.(d.ds, hm(s), hm(eMins), d.name.trim());
      } else {
        const startTime = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
        const endTime = `${pad(Math.floor(eMins / 60) % 24)}:${pad(eMins % 60)}`;
        onSessionCreate?.(d.ds, startTime, endTime, d.name.trim());
      }
    }
    clearDraft();
  }

  // Drop side of the pane-drag primitive — the active task, a library block,
  // or a quick note released over a day column. Snaps to the 15-min grid and
  // routes by the drag's kind to the matching create-on-drop callback.
  function handlePaneDrop(ds, e) {
    if (!taskDrag) return;
    const col = e.currentTarget;
    const rect = col.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const mins = (relY / rect.height) * 24 * 60;
    const startMins = Math.max(0, Math.min(24 * 60 - 15, Math.round(mins / 15) * 15));
    if (taskDrag.kind === 'block' && taskDrag.payload?.blockId) {
      onBlockDrop?.(ds, taskDrag.payload.blockId, startMins);
    } else if (taskDrag.kind === 'note' && taskDrag.payload?.text) {
      onNoteDrop?.(ds, taskDrag.payload, startMins);
    } else {
      onTaskDrop?.(ds, `${pad(Math.floor(startMins / 60) % 24)}:${pad(startMins % 60)}`);
    }
  }

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const todayVisible = visibleDays.some(d => isSameDay(d, today));
  const currentHour = today.getHours();
  const nowOffset = ((today.getHours() * 60 + today.getMinutes()) / 60) * hourHeight;

  return (
    <div className="flex-col" style={{ height: '100%', background: 'var(--surface)' }}>
      {!hideHeader && (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 18px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <IconBtn title="Previous" onClick={() => stepPivot(-1)} size={26}>
          <IconChevronLeft/>
        </IconBtn>
        <HeaderChip onClick={() => onPivotChange(new Date())} title="Jump to today">Today</HeaderChip>
        <IconBtn title="Next" onClick={() => stepPivot(1)} size={26}>
          <IconChevronRight/>
        </IconBtn>

        <span style={{ width: 4 }}/>

        <Seg
          options={[
            { value: 'day', label: 'D' },
            { value: 'week', label: 'W' },
            { value: 'month', label: 'M' },
          ]}
          value={viewMode === 'custom' ? null : viewMode}
          onChange={onViewModeChange}
          accent={accent}
        />

        {viewMode === 'custom' ? (
          <div className="cal-customdays">
            <button
              className="cal-customdays__step"
              onClick={() => onCustomDaysChange(Math.max(1, customDays - 1))}
            >−</button>
            <span className="cal-customdays__label">{customDays}d</span>
            <button
              className="cal-customdays__step"
              onClick={() => onCustomDaysChange(Math.min(10, customDays + 1))}
            >+</button>
          </div>
        ) : (
          <FilterChip onClick={() => onViewModeChange('custom')} accent={accent}>
            {customDays}d
          </FilterChip>
        )}

        <span style={{ flex: 1 }}/>
        {onToggleFrameEdit && (
          <button
            type="button"
            className={`candy-btn${frameEditMode ? ' is-active' : ''}`}
            data-shape="chip"
            data-own-press
            onClick={onToggleFrameEdit}
            aria-pressed={frameEditMode}
            aria-label="Edit Daily Frame"
          ><span className="candy-face">{frameEditMode ? 'Done' : 'Edit Frame'}</span></button>
        )}
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.04em',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {viewMode === 'month'
            ? pivotDate.toLocaleString('en-US', { month: 'long', year: 'numeric' })
            : visibleDays.length === 1
              ? dateKey(visibleDays[0])
              : `${dateKey(visibleDays[0])} — ${dateKey(visibleDays[visibleDays.length - 1])}`}
        </span>
      </div>
      )}

      {viewMode !== 'month' && (!hideHeader || showDayStrip) && (
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ width: 44, flexShrink: 0 }}/>
          {visibleDays.map(d => {
            const isToday = isSameDay(d, today);
            return (
              <div key={dateKey(d)} style={{
                flex: 1, textAlign: 'center', padding: '8px 4px 6px',
                fontSize: 10, fontWeight: isToday ? 700 : 500, fontFamily: 'var(--font-mono)',
                color: isToday ? accent : 'var(--text-muted)',
                letterSpacing: '0.03em',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </div>
            );
          })}
        </div>
      )}

      {viewMode === 'month' ? (
        <MonthGrid
          days={visibleDays}
          monthAnchor={pivotDate}
          sessionsByDay={sessionsByDay}
          accent={accent}
          today={today}
          onSelectDay={(d) => { onPivotChange(d); onViewModeChange('day'); }}
        />
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }} ref={containerRef} data-frame-edit={frameEditMode ? 'on' : undefined}>
          <div style={{ display: 'flex', minHeight: '100%' }}>
            {showHourGutter && (
            <div style={{ width: 44, flexShrink: 0, position: 'relative' }}>
              {hours.map(h => {
                const isPastHour = todayVisible && h < currentHour;
                return (
                  <div key={h} style={{
                    height: hourHeight, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                    background: 'transparent',
                  }}>
                    {h > 0 && (
                      <span style={{
                        fontSize: 10, fontFamily: 'var(--font-mono)',
                        fontWeight: 500,
                        color: 'var(--text)',
                        opacity: isPastHour ? 0.4 : 1,
                        letterSpacing: '0.02em',
                        marginTop: -7, padding: '0 3px',
                        background: 'var(--surface)',
                      }}>
                        {fmtHourLabel(h, timeFormat24h)}
                      </span>
                    )}
                  </div>
                );
              })}
              {todayVisible && (
                <div style={{
                  position: 'absolute', left: 0, right: 0,
                  top: nowOffset,
                  display: 'flex', justifyContent: 'flex-end', paddingRight: 0,
                  transform: 'translateY(-50%)', pointerEvents: 'none', zIndex: 25,
                }}>
                  <span style={{
                    fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, whiteSpace: 'nowrap',
                    color: 'var(--on-accent)', background: 'var(--cal-now)',
                    padding: '1px 4px', borderRadius: 'var(--radius-sm) 0 0 var(--radius-sm)', lineHeight: 1.1,
                    letterSpacing: '0.02em',
                  }}>
                    {fmtClockCompact(today.getHours(), today.getMinutes(), timeFormat24h)}
                  </span>
                </div>
              )}
            </div>
            )}

            {visibleDays.map(d => {
              const ds = dateKey(d);
              const isToday = isSameDay(d, today);
              const daySessions = sessionsByDay[ds] || [];
              const packedSessions = packDaySessions(daySessions);
              const dayPlanBlocks = isToday ? planBlocks : [];

              return (
                <div key={ds} data-day-col={ds} data-no-drag
                  onPointerDown={e => handleDayPointerDown(ds, e)}
                  onPointerUp={e => handlePaneDrop(ds, e)}
                  onContextMenu={e => handleGridContextMenu(ds, e)}
                  style={{
                    flex: 1, position: 'relative',
                    borderRadius: 'var(--cal-radius)',
                    background: 'var(--surface-3)',
                    minHeight: hourHeight * 24, cursor: 'cell',
                  }}>
                  {/* Rounded hour boxes (replaces the old gradient hour lines).
                      pointer-events:none so empty-grid clicks/drops/menus still
                      hit this column — the blocks below stack on top. */}
                  <div className="cal-hours" aria-hidden>
                    {Array.from({ length: 24 }, (_, h) => (
                      <div key={h} className="cal-hour-cell" style={{ top: h * hourHeight + 1, height: hourHeight - 3 }} />
                    ))}
                  </div>
                  {dayPlanBlocks.map(b => {
                    const key = `${b.start}-${b.end}-${b.title}`;
                    const pDesc = descFromPlan(b, ds);
                    return (
                      <PlanBlock key={`p-${key}`} block={b}
                        hourHeight={hourHeight} accent={accent}
                        onSelect={() => onSelectPlanBlock?.(b, key)}
                        isActive={activePlanKey === key || pDesc.key === runningBlockKey}
                        dayDateKey={ds} onPlanBlockMove={onPlanBlockMove}
                        timeFormat24h={timeFormat24h}
                        desc={pDesc} onBlockTap={onBlockTap}
                        pullState={pullSelect ? pullStateOf(pDesc, pullSelect) : null}
                        onPullToggle={() => pullSelect?.onToggle(pDesc)}/>
                    );
                  })}
                  {packedSessions.map(s => {
                    const sDesc = descFromSession(s);
                    return (
                      <SessionBlock key={`${s.id}-${s.start}-${s.end}`} session={s}
                        hourHeight={hourHeight} accent={accent}
                        isActive={activeSessionId === s.id || sDesc.key === runningBlockKey}
                        onSelect={() => onSelectSession?.(s)}
                        onDelete={id => onSessionDelete?.(ds, id)}
                        onDuplicate={(start, end, task) => onSessionCreate?.(ds, start, end, task)}
                        onResize={(id, newStart, newEnd) => onSessionResize?.(ds, id, newStart, newEnd)}
                        onMove={(id, targetDs, newStart, newEnd) => onSessionMove?.(ds, id, targetDs, newStart, newEnd)}
                        onFrameMove={(targetDs, frameId, startMins) => onFrameDrop?.(targetDs, frameId, startMins)}
                        onRename={(id, task) => onSessionRename?.(ds, id, task)}
                        onEditingChange={v => { editingActiveRef.current = v; }}
                        onFrameReset={onFrameReset}
                        frameEditMode={frameEditMode}
                        onFrameRetime={onFrameRetime}
                        onFrameResize={onFrameResize}
                        onFrameDelete={onFrameDelete}
                        onFrameDeleteToday={onFrameDeleteToday}
                        onFrameRename={onFrameRename}
                        onFrameShift={onFrameShift}
                        entranceDelay={s.meta?.frameId != null ? (restoreAnim?.[s.meta.frameId] ?? null) : null}
                        timeFormat24h={timeFormat24h}
                        lane={s._lane}
                        lanes={s._lanes}
                        desc={sDesc} onBlockTap={onBlockTap}
                        pullState={pullSelect ? pullStateOf(sDesc, pullSelect) : null}
                        onPullToggle={() => pullSelect?.onToggle(sDesc)}
                      />
                    );
                  })}
                  {todayVisible && (
                    /* Now-line spans every visible day so it connects to the
                       gutter pill in week view; today's column gets the solid
                       segment, other days a faint hairline. */
                    <div style={{
                      position: 'absolute', left: 0, right: 0,
                      top: nowOffset,
                      height: 0, pointerEvents: 'none', zIndex: 20,
                    }}>
                      <div style={{
                        position: 'absolute', left: -2, right: 0, top: -1,
                        height: isToday ? 2 : 1.5, background: 'var(--cal-now)',
                        opacity: isToday ? 1 : 0.32,
                      }}/>
                    </div>
                  )}
                  {draft && draft.ds === ds && (
                    <DraftBlock
                      draft={draft}
                      hourHeight={hourHeight}
                      accent={accent}
                      timeFormat24h={timeFormat24h}
                      onNameChange={name => setDraft(d => d ? { ...d, name } : d)}
                      onCommit={confirmDraft}
                      onCancel={clearDraft}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {eventModal && (
        <NewEventModal
          open={eventModal.open}
          initialDs={eventModal.ds}
          initialStart={eventModal.start}
          accent={accent}
          onClose={() => setEventModal(null)}
          onCreated={() => {}}
        />
      )}
    </div>
  );
}

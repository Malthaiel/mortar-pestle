// Unified day pane — the Planner dashboard's MIDDLE column (Planner Overhaul
// Pivot 2). One daily-log-structured pane replacing the old Events /
// Unorganized / Block Library rails and the DailyNotePane editor: four sections
// — Events (forward agenda from the viewed day), Routine, Tasks List and Quick
// Notes — separated by hairlines and anchored to the dashboard's shared
// `pivotDs` pivot. Each section is ONE header row — its title plus a bare "+"
// circle in the slot the count badge used to hold — and then its list. The four
// "No upcoming events." / "No tasks." lines are gone (2026-08-28), so an empty
// section is just its header row; the whole pane runs on one 10px rhythm (GAP).
//
// EVERY day — today included — shows that day's own items and nothing else
// (2026-09-01). Carryover from other days moved entirely into the section's
// "show all" popover, where it is still grouped by source date. Fully
// interactive (toggle / ROUTE / drag), and every adder writes to the VIEWED day
// (2026-09-01): the four "+" circles are live on any date, and api.js's
// appendToDaySection creates that day's log from the skeleton if it is missing.
//
// Refresh is consolidated here: ONE debounced tick from the vault watcher
// ('today' / 'day' / 'manifest') + the `agentic:yesterday-notes-changed`
// browser event feeds all three data hooks, so a single write never
// multi-flashes the pane.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { subscribeEvents } from '../../api.js';
import { api } from '../../api.js';
import { useUpcomingWindow } from '../../hooks/useUpcomingWindow.js';
import { useDaySections } from '../../hooks/useDaySections.js';
import { useUnorganizedItems } from '../../hooks/useUnorganizedItems.js';
import { useEventTypes } from '../../hooks/useEventTypes.js';
import { todayLocalStr } from '../../util/time.js';
import { IconPlus } from '../icons.jsx';
import NewEventModal from './NewEventModal.jsx';
import PaneHeader from './PaneHeader.jsx';
import Popover from '../ui/Popover.jsx';
import { TaskChip, NoteChip, Group, Subdued, shortDate } from './ItemChips.jsx';
import RoutineChip from './RoutineChip.jsx';
import { useRoutineItems } from '../../hooks/useRoutineItems.js';
import { useDailyFrame } from '../../hooks/useDailyFrame.js';
import { makeUniqueId } from '../../util/frames.js';
import { weekdayForKey, colorForType } from '../../util/events.js';
import { candyGap } from '../../util/candy.js';
import { playCelebrationChime } from '../../hooks/useTactileSound.js';

// Day-group label relative to REAL today (not the pivot) — "Today"/"Tomorrow"
// keep meaning while time-traveling.
function dayLabel(ds) {
  const d = new Date(`${ds}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// One vertical rhythm for the whole pane (user-directed 2026-08-28: "even
// vertical spacing between every singular button, separator line, header";
// 2026-08-29: "perfectly centered both vertically and horizontally — same gap
// in 4 directions", and the same number between the buttons inside a box).
//
// INSET is that number, and it is always the PAINTED gap. A candy button paints
// half a depth ABOVE its row (candyCenterOffset lifts it so the face+lip unit
// centres beside plain text) and a whole depth BELOW it (the lip), so a layout
// gap has to add back half a depth for EACH candy neighbour it sits between.
// Horizontal gaps add nothing — the lip points down, not sideways. Every value
// is derived from the depth var, never typed, because depth is a user setting.
const INSET = 12;
const GAP = INSET;                                                    // no candy either side
const GAP_HALF = `calc(${INSET}px + var(--candy-depth-small) / 2)`;   // candy on one side
const GAP_UNDER_BTN = candyGap(INSET, true);                          // candy on both sides

// A flex child with NO rows is zero-tall but still eats the section's gap on
// both sides — an empty Tasks List sat 30px off its divider while every other
// gap in the pane was 10. display:none takes it out of the layout entirely.
const chipList = (empty) => ({
  display: empty ? 'none' : 'flex', flexDirection: 'column', gap: GAP_UNDER_BTN,
});
// Every section's adder: a bare "+" circle on the section's HEADER row, in the
// slot the count badge used to occupy (user-directed 2026-08-28 — the counters
// and the "New ..." wording are both gone). Live on every day — each
// section's onSubmit already carries `pivotDs`, so the item lands on whichever
// date the pane is parked on.
function AddCircle({ onClick, label }) {
  return (
    <button
      type="button"
      data-own-press
      className="candy-btn"
      data-shape="circle"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <span className="candy-face"><IconPlus size={14}/></span>
    </button>
  );
}

// One-line inline inserter shown under a section header after its "+" is
// clicked. Enter commits, Esc cancels (stopPropagation keeps the modal open).
function InlineAdd({ placeholder, onSubmit, onClose }) {
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const commit = async () => {
    const t = val.trim();
    if (!t) { onClose(); return; }
    setBusy(true);
    const r = await onSubmit(t);
    setBusy(false);
    if (r?.ok) onClose();
  };
  // ponytail: no margin — the section's gap spaces this. It carries
  // --candy-surface-depth, not --candy-depth-small, so its trailing gap is a
  // couple of px off the rest; it's a transient row, not worth a third constant.
  return (
    <div>
      <input
        ref={inputRef}
        className="candy-input"
        value={val}
        disabled={busy}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
        placeholder={placeholder}
        style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
      />
    </div>
  );
}

// Hairline between two sections. This IS the old UNORGANIZED divider with its
// Carryover arrives newest-source-first and flat; group consecutive items by
// source date for the divider block (insertion order preserves newest-first).
function groupBySource(items) {
  const m = new Map();
  for (const it of items) {
    if (!m.has(it.sourceDate)) m.set(it.sourceDate, []);
    m.get(it.sourceDate).push(it);
  }
  return [...m.entries()];
}

// The agenda list, shared by the Events column and its "show all" popover so
// the two can never drift apart. `hideDayLabel` is the COLUMN, which shows the
// viewed day and nothing else (user-directed 2026-08-29) — the day headings only
// mean something in the popover, which spans many days. With the labels gone the
// first painted thing is a candy face, not text, so the half-depth correction the
// text needed goes with them.
function EventGroups({ groups, colorFor, onEdit, hideDayLabel = false }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: hideDayLabel ? GAP_UNDER_BTN : GAP_HALF,
      ...(hideDayLabel ? null : { marginTop: 'calc(var(--candy-depth-small) / -2)' }),
    }}>
      {groups.map(({ ds, events }) => (
        <div key={ds}>
          {/* text-box trims the font's half-leading so this label's box IS its
              ink — cap height down to the descender — and the 12 above and
              below it read as 12 rather than 12-plus-slack. The browser does
              the measuring; nothing here restates a font metric. */}
          {!hideDayLabel && (
            <div style={{
              fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
              letterSpacing: '0.02em', marginBottom: GAP_HALF,
              textBox: 'trim-both cap text',
            }}>{dayLabel(ds)}</div>
          )}
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: GAP_UNDER_BTN }}>
            {events.map((ev, i) => (
              <li key={`${ds}-${i}`}>
                {/* The whole event IS the button — clicking it opens the same
                    modal that created it, in edit mode (with Delete). Muted
                    text is `inherit` + opacity, not a token, so it stays
                    readable when the row floods accent on hover.
                    The row shape inherits the FULL depth, but every other list
                    row in this pane (tasks, notes, routine) is a small shape;
                    pinning the small lip here keeps the rows matched and lets
                    one INSET sit evenly under all of them. */}
                <button
                  type="button"
                  data-own-press
                  className="candy-btn"
                  data-shape="row"
                  style={{ '--cbtn-depth': 'var(--candy-depth-small)' }}
                  title="Edit this event"
                  onClick={() => onEdit?.(ds, ev)}
                >
                  <span className="candy-face">
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: colorFor(ev.typeName),
                    }}/>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 12, lineHeight: 1.35 }}>
                        {ev.time12 && (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.7, marginRight: 6 }}>{ev.time12}</span>
                        )}
                        <span>{ev.title}</span>
                      </span>
                      {ev.note && (
                        <span style={{ display: 'block', fontSize: 11, opacity: 0.7, lineHeight: 1.3 }}>{ev.note}</span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// A section's title IS the button that opens its "show all" popover
// (user-directed 2026-08-28). Same candy chip as every other control in the
// pane; PaneHeader keeps the heading's own type inside the face, so the four
// titles still read as headings rather than as toolbar buttons.
//
// The title and its "+" are ONE fused button now (user-directed 2026-09-01) —
// .candy-split squares the two inner corners and merges the frames into a
// single seam. They stay two real .candy-btn elements, so each half presses,
// hovers and lights independently; the wrapper only changes how they look. The
// title half also stays HELD DOWN while its popover is open (the .is-active
// rule in § split), so the button itself reports the open panel.
//
// alignSelf: the split is `display: inline-flex`, which shrink-wraps in block
// flow but STRETCHES to full width now that the section wrapper is a flex
// column. flex-start pins it back. It goes here rather than as align-items on
// the wrapper because the chip rows below still want the column's stretch.
function SectionHead({ title, btnRef, open, onToggle, children }) {
  return (
    <div className="candy-split" style={{ alignSelf: 'flex-start' }}>
      <button
        type="button"
        ref={btnRef}
        data-own-press
        className={`candy-btn planner-section-head${open ? ' is-active' : ''}`}
        data-shape="chip"
        aria-expanded={open}
        title={`Show all ${title.toLowerCase()}`}
        onClick={onToggle}
      >
        <span className="candy-face"><PaneHeader>{title}</PaneHeader></span>
      </button>
      {children}
    </div>
  );
}

// Anchored "show all" panel - the BlockLibraryPopover recipe (caller-positioned
// Popover, clamped to the viewport, capture-phase Esc so only this closes)
// pointed at a section header instead of the Blocks chip. Its body reuses the
// pane's own chips, so everything inside stays as interactive as the column.
const WEEKDAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

const POPOVER_W = 340;
function SectionPopover({ open, onClose, anchorRef, accent, title, children }) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const r = anchorRef?.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 10, left: Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_W - 8)) });
  }, [open, anchorRef]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  return (
    <Popover
      open={open && !!pos}
      onClose={onClose}
      ariaLabel={title}
      accent={accent}
      escToClose={false}
      outsideExempt=".planner-section-head"
      panelClassName="candy-modal planner-uniform-btns"
      panelProps={{ 'data-uniform-height': '--planner-btn-h' }}
      style={{ position: 'fixed', zIndex: 1100, top: pos?.top, left: pos?.left, width: POPOVER_W, maxHeight: 460 }}
      bodyStyle={{ padding: 12, display: 'flex', flexDirection: 'column', gap: GAP_UNDER_BTN }}
    >
      {children}
    </Popover>
  );
}

// The Events popover's own, WIDER read. Mounted only while the popover is open:
// the window costs one vault read per day, so a 90-day sweep is fine on demand
// and would be wasteful standing.
const ALL_EVENTS_DAYS = 90;
function AllEventsBody({ pivotDs, colorFor, onEdit }) {
  const { groups, loading, error } = useUpcomingWindow(ALL_EVENTS_DAYS, pivotDs, 0);
  if (loading) return <Subdued>Loading</Subdued>;
  if (error) return <Subdued>Couldn't read upcoming events.</Subdued>;
  if (!groups.length) return <Subdued>Nothing scheduled in the next {ALL_EVENTS_DAYS} days.</Subdued>;
  return <EventGroups groups={groups} colorFor={colorFor} onEdit={onEdit}/>;
}

// Carryover age tint — group date labels warm from muted grey toward amber as
// the items get staler (~7 days to full warmth). Static color, not motion, so
// it carries no Animations toggle.
function ageColor(ds) {
  const age = Math.max(0, Math.round((Date.now() - new Date(`${ds}T00:00:00`).getTime()) / 86400000));
  const p = Math.min(age * 15, 100);
  return `color-mix(in oklch, var(--text-muted) ${100 - p}%, #d9a05b ${p}%)`;
}

export default function DayPane({ accent = 'var(--accent)', pivotDs, onPivotChange }) {
  // Real-today tick (60s, mirrors the old DailyNotePane) — `isToday` drives
  // the disabled "+" buttons and the Today return chip; at midnight the pane
  // greys its adders out in place instead of silently retargeting.
  const [todayDs, setTodayDs] = useState(todayLocalStr);
  useEffect(() => {
    const id = setInterval(() => {
      const t = todayLocalStr();
      setTodayDs(prev => (prev === t ? prev : t));
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  const isToday = pivotDs === todayDs;

  // Consolidated refresh — one trailing-debounced tick feeds all three hooks.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let t = null;
    const bump = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { setTick(v => v + 1); t = null; }, 150);
    };
    const unsub = subscribeEvents((name) => {
      if (name === 'today' || name === 'day' || name === 'manifest') bump();
    });
    window.addEventListener('agentic:yesterday-notes-changed', bump);
    return () => {
      if (t) clearTimeout(t);
      unsub();
      window.removeEventListener('agentic:yesterday-notes-changed', bump);
    };
  }, []);

  // The column is the viewed day only; other days live behind the section
  // header's "show all" popover, which sweeps its own window.
  const { groups, loading: evLoading, error: evError, reload: reloadEvents } = useUpcomingWindow(0, pivotDs, tick);
  const day = useDaySections(pivotDs, tick);
  const unorg = useUnorganizedItems(tick);
  const { types } = useEventTypes();

  // "Show all" popovers — ONE open key, so opening a second closes the first.
  const [allOpen, setAllOpen] = useState(null);   // 'events' | 'routine' | 'tasks' | 'notes'
  const evHeadRef = useRef(null);
  const roHeadRef = useRef(null);
  const tkHeadRef = useRef(null);
  const ntHeadRef = useRef(null);
  const toggleAll = (key) => setAllOpen(v => (v === key ? null : key));

  const [modalOpen, setModalOpen] = useState(false);
  // The event the modal is editing, as { ds, ev } — null means "new event".
  const [editingEvent, setEditingEvent] = useState(null);
  const openEventEditor = (ds, ev) => { setEditingEvent({ ds, ev }); setModalOpen(true); };
  const [addingTask, setAddingTask] = useState(false);
  const [addingRoutine, setAddingRoutine] = useState(false);

  // Routine items for the viewed weekday + the writer that creates an UNTIMED
  // one. A new item is born with no start/end — it lives in the list only until
  // it's dragged onto the calendar, which is what gives it a time.
  const routine = useRoutineItems(pivotDs, tick);
  const { frames, writeFrames } = useDailyFrame();
  const addRoutineItem = async (text) => {
    const name = (text || '').trim();
    if (!name) return;
    const dayKey = weekdayForKey(pivotDs).toLowerCase();
    const day = frames?.[dayKey] || [];
    const next = {
      ...frames,
      [dayKey]: [...day, { id: makeUniqueId(day, name), name }],
    };
    try { await writeFrames(next); }
    catch (e) { console.error('routine add failed', e); }
  };
  const [addingNote, setAddingNote] = useState(false);

  const colorFor = (typeName) => colorForType(types, typeName);

  // Day-slide direction — recomputed render-side ONLY when the pivot actually
  // moves, then held in a ref. It must stay applied across re-renders: the
  // pivot change immediately refetches day data, and that state landing
  // mid-animation would otherwise strip the inline style and cancel the slide
  // after one frame. The keyed body means the animation still only PLAYS on
  // remount (no first-mount slide — the ref starts null). The INLINE name is
  // load-bearing: body[data-anim-planner-day-slide="off"] matches [style*=].
  const prevPivotRef = useRef(pivotDs);
  const slideNameRef = useRef(null);
  if (prevPivotRef.current !== pivotDs) {
    slideNameRef.current = pivotDs > prevPivotRef.current
      ? 'plannerDaySlideFromRight'
      : 'plannerDaySlideFromLeft';
    prevPivotRef.current = pivotDs;
  }
  const slideName = slideNameRef.current;

  const dayPath = `Pulse/Daily Logs/${pivotDs}.md`;
  // Unchecked first, checked muted below (stable sort keeps file order within
  // each group).
  const dayTasks = [...day.tasks].sort((a, b) => Number(a.checked) - Number(b.checked));
  // Celebration hook — fires only when the clicked check was the LAST open
  // task among today's OWN tasks (carryover lives in other days' files and
  // doesn't count). day.tasks is the pre-toggle snapshot, so "last" means no
  // OTHER unchecked task remains. The confetti layer and the chime each
  // self-gate (task-celebration Animations toggle / tactile Sounds key).
  const onOwnTaskToggled = (line) => (r) => {
    if (!isToday || !r?.ok || !r.checked) return;
    if (day.tasks.some(t => !t.checked && t.line !== line)) return;
    window.dispatchEvent(new CustomEvent('app:confetti'));
    playCelebrationChime();
  };
  // Carryover is POPOVER-ONLY (user-directed 2026-09-01). The column shows the
  // viewed day and nothing else — seeing Sep 2's tasks while parked on Sep 1 is
  // exactly what it must not do. Everything from every other day is one click
  // away in the section's "show all" popover; that is the whole point of it.
  const allCarryTasks = unorg.loading ? [] : groupBySource(unorg.tasks);
  const allCarryNotes = unorg.loading ? [] : groupBySource(unorg.notes);

  // The pane's sections, in fixed on-screen order. Adding a fifth is one entry
  // here — it inherits the padding and the hairline above it.
  const sections = [
        /* ── Events — forward agenda anchored at the viewed day ── */
    { id: 'events', render: () => (<>
          <SectionHead
            title="Events"
            btnRef={evHeadRef}
            open={allOpen === 'events'}
            onToggle={() => toggleAll('events')}
          >
            <AddCircle label="New event" onClick={() => { setEditingEvent(null); setModalOpen(true); }}/>
          </SectionHead>
          {evLoading ? (
            <Subdued>Loading</Subdued>
          ) : evError ? (
            <Subdued>Couldn’t read upcoming events.</Subdued>
          ) : groups.length === 0 ? null : (
            <EventGroups groups={groups} colorFor={colorFor} onEdit={openEventEditor} hideDayLabel/>
          )}
    </>) },

        /* ── Routine — repeating items for this weekday (Frame + Recurring
            merged, Planner Consolidation). Timed ones also paint on the
            calendar; untimed ones live only here. Sits above Tasks List: the
            recurring shape of the day comes before its one-offs. ── */
    { id: 'routine', render: () => (<>
          <SectionHead
            title="Routine"
            btnRef={roHeadRef}
            open={allOpen === 'routine'}
            onToggle={() => toggleAll('routine')}
          >
            <AddCircle label="New routine item" onClick={() => setAddingRoutine(true)}/>
          </SectionHead>
          {addingRoutine && (
            <InlineAdd
              placeholder="New routine item — Enter to add, Esc to cancel"
              onSubmit={addRoutineItem}
              onClose={() => setAddingRoutine(false)}
            />
          )}
          {routine.total > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: GAP_UNDER_BTN }}>
              {routine.items.map(it => (
                <RoutineChip key={it.id} item={it} onToggle={routine.toggle}/>
              ))}
            </div>
          )}
    </>) },

        /* ── Tasks List — the viewed day's ## Tasks + today's carryover ── */
    { id: 'tasks', render: () => (<>
          <SectionHead
            title="Tasks List"
            btnRef={tkHeadRef}
            open={allOpen === 'tasks'}
            onToggle={() => toggleAll('tasks')}
          >
            <AddCircle label="New task" onClick={() => setAddingTask(true)}/>
          </SectionHead>
          {addingTask && (
            <InlineAdd
              placeholder="New task — Enter to add, Esc to cancel"
              onSubmit={(text) => api.daySections.addTask(pivotDs, text)}
              onClose={() => setAddingTask(false)}
            />
          )}
          <div style={chipList(!day.loading && !day.error && !dayTasks.length)}>
            {day.loading ? (
              <Subdued>Loading</Subdued>
            ) : day.error ? (
              <Subdued>Couldn’t read the daily log.</Subdued>
            ) : (
              <>
                {dayTasks.map(t => (
                  <TaskChip
                    key={`${pivotDs}:${t.line}:${t.text}`}
                    path={dayPath} line={t.line} text={t.text}
                    sourceDate={pivotDs} checked={t.checked} showDate={false}
                    onToggled={onOwnTaskToggled(t.line)}
                  />
                ))}
              </>
            )}
          </div>
    </>) },

        /* ── Quick Notes — the viewed day's bullets + today's carryover ── */
    { id: 'notes', render: () => (<>
          <SectionHead
            title="Quick Notes"
            btnRef={ntHeadRef}
            open={allOpen === 'notes'}
            onToggle={() => toggleAll('notes')}
          >
            <AddCircle label="New quick note" onClick={() => setAddingNote(true)}/>
          </SectionHead>
          {addingNote && (
            <InlineAdd
              placeholder="New quick note — Enter to add, Esc to cancel"
              onSubmit={(text) => api.daySections.addNote(pivotDs, text)}
              onClose={() => setAddingNote(false)}
            />
          )}
          <div style={chipList(!day.loading && !day.error && !day.notes.length)}>
            {day.loading ? (
              <Subdued>Loading</Subdued>
            ) : day.error ? (
              <Subdued>Couldn’t read the daily log.</Subdued>
            ) : (
              <>
                {day.notes.map(n => (
                  <NoteChip key={`${pivotDs}-${n.index}-${n.text}`} text={n.text} sourceDate={pivotDs} index={n.index} showDate={false}/>
                ))}
              </>
            )}
          </div>
    </>) },
  ];
  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      // No borders — DashboardPage's two wrapper divs own both dividers now
      // (the stacked layout put a horizontal seam above this pane and moved the
      // vertical one out to the left column's edge).
    }}>
      {/* No header — the date chip and the Today chip moved into
          CalendarPane's one centered header row (user-directed 2026-08-27),
          which sits directly above this pane in the stacked layout. */}

      {/* Sections body — one scroll container for all four sections, keyed
          by the pivot so a day switch remounts it (fresh scroll + slide).
          NOT a rail (user-directed 2026-09-04): the `.rail-tile.is-panel`
          chrome and the drag-to-reorder that came with it are gone, so each
          section is just its header button plus its list. The divider is a
          full-width hairline carried by the section BELOW it, which keeps the
          container's own top and bottom edges clean.

          Each section is a flex COLUMN on the pane's one rhythm: its header
          button, any inline adder and its list are candy on both sides, so
          GAP_UNDER_BTN is the same gap the lists already use internally.
          Without it the first chip painted straight over the header's depth
          lip. The bottom padding carries that same lip clearance, so the gap
          above each hairline reads equal to the gap below it. */}
      <div
        key={pivotDs}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column',
          ...(slideName ? { animation: `${slideName} 400ms cubic-bezier(0.16, 1, 0.3, 1)` } : {}),
        }}>
        {sections.map((s, i) => (
          <div
            key={s.id}
            style={{
              padding: `14px 18px ${candyGap(14, true)}`,
              display: 'flex', flexDirection: 'column', gap: GAP_UNDER_BTN,
              borderTop: i === 0 ? undefined : '1px solid var(--border)',
            }}>
            {s.render()}
          </div>
        ))}
      </div>

      {/* "Show all" popovers. Each body is mounted only while its popover is
          open, so the Events sweep's 90 day-reads never fire at rest. Tasks and
          Quick Notes reuse the data the pane already holds — the viewed day's
          own items plus every other day's open carryover — and Routine reads
          the whole week straight out of the frames it already fetched. */}
      <SectionPopover
        open={allOpen === 'events'}
        onClose={() => setAllOpen(null)}
        anchorRef={evHeadRef}
        accent={accent}
        title="All events"
      >
        {allOpen === 'events' && <AllEventsBody pivotDs={pivotDs} colorFor={colorFor} onEdit={openEventEditor}/>}
      </SectionPopover>

      <SectionPopover
        open={allOpen === 'routine'}
        onClose={() => setAllOpen(null)}
        anchorRef={roHeadRef}
        accent={accent}
        title="All routine"
      >
        {!WEEKDAYS.some(([key]) => (frames?.[key] || []).length > 0) && (
          <Subdued>No routine items on any day.</Subdued>
        )}
        {WEEKDAYS.map(([key, label]) => {
          const items = frames?.[key] || [];
          if (!items.length) return null;
          const isViewed = key === weekdayForKey(pivotDs).toLowerCase();
          return (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: GAP_UNDER_BTN }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: isViewed ? 'var(--text)' : 'var(--text-muted)',
              }}>{label}</div>
              {/* Only the VIEWED weekday's items carry live tick state — a
                  routine item is checked per DAY, and the other six weekdays
                  have no day to check against, so they list as plain rows. */}
              {isViewed
                ? routine.items.map(it => <RoutineChip key={it.id} item={it} onToggle={routine.toggle}/>)
                : items.map(it => (
                    <div key={it.id} style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.35 }}>
                      {it.name}
                    </div>
                  ))}
            </div>
          );
        })}
      </SectionPopover>

      <SectionPopover
        open={allOpen === 'tasks'}
        onClose={() => setAllOpen(null)}
        anchorRef={tkHeadRef}
        accent={accent}
        title="All tasks"
      >
        {dayTasks.map(t => (
          <TaskChip
            key={`all:${pivotDs}:${t.line}:${t.text}`}
            path={dayPath} line={t.line} text={t.text}
            sourceDate={pivotDs} checked={t.checked} showDate={false}
          />
        ))}
        {allCarryTasks.map(([ds, items]) => (
          <Group key={`all:${ds}`} label={shortDate(ds)} labelColor={ageColor(ds)}>
            {items.map(t => (
              <TaskChip key={`all:${t.path}:${t.line}`} path={t.path} line={t.line} text={t.text} sourceDate={t.sourceDate} showDate={false}/>
            ))}
          </Group>
        ))}
        {unorg.loading && <Subdued>Loading</Subdued>}
        {!unorg.loading && !dayTasks.length && !allCarryTasks.length && <Subdued>No open tasks anywhere.</Subdued>}
      </SectionPopover>

      <SectionPopover
        open={allOpen === 'notes'}
        onClose={() => setAllOpen(null)}
        anchorRef={ntHeadRef}
        accent={accent}
        title="All quick notes"
      >
        {day.notes.map(n => (
          <NoteChip key={`all:${pivotDs}-${n.index}-${n.text}`} text={n.text} sourceDate={pivotDs} index={n.index} showDate={false}/>
        ))}
        {allCarryNotes.map(([ds, items]) => (
          <Group key={`all:${ds}`} label={shortDate(ds)} labelColor={ageColor(ds)}>
            {items.map(n => (
              <NoteChip key={`all:${n.sourceDate}-${n.index}`} text={n.text} sourceDate={n.sourceDate} index={n.index} showDate={false}/>
            ))}
          </Group>
        ))}
        {unorg.loading && <Subdued>Loading</Subdued>}
        {!unorg.loading && !day.notes.length && !allCarryNotes.length && <Subdued>No quick notes anywhere.</Subdued>}
      </SectionPopover>

      <NewEventModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditingEvent(null); }}
        onCreated={reloadEvents}
        accent={accent}
        initialDs={pivotDs}
        editing={editingEvent}
      />
    </div>
  );
}

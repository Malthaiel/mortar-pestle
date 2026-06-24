// Unified day pane — the Planner's right column (Planner Overhaul Pivot 2).
// One daily-log-structured pane replacing the old Events / Unorganized / Block
// Library rails and the DailyNotePane editor: a date-button header (month
// popover arrives in a later sub-feature) above three sections — Events
// (forward agenda from the viewed day), Tasks List, and Quick Notes — all
// anchored to the modal's shared `pivotDs` pivot.
//
// Viewing TODAY, the Tasks/Notes sections show today's own items first, then
// an "Unorganized" divider grouping carryover from previous days by source
// date (the old Unorganized pane's data). Any other day shows that day's own
// items only — still fully interactive (toggle / ROUTE / drag), but every "+"
// adder is disabled off-today.
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
import Popover from '../ui/Popover.jsx';
import MiniMonthPicker from './MiniMonthPicker.jsx';
import NewEventModal from './NewEventModal.jsx';
import PaneHeader from './PaneHeader.jsx';
import { TaskChip, NoteChip, Group, Subdued, shortDate } from './ItemChips.jsx';
import { playCelebrationChime } from '../../hooks/useTactileSound.js';
import { usePlanner } from '@modules/core/planner/PlannerProvider.jsx';

function humanDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

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

// Section "+" — candy circle, greyed and inert when the pane is parked on a
// non-today day (creation is today-only by design; viewing stays interactive).
function AddCircle({ isToday, onClick, label }) {
  return (
    <button
      type="button"
      data-own-press
      className="candy-btn"
      data-shape="circle"
      disabled={!isToday}
      title={isToday ? label : 'Switch to today to add'}
      aria-label={label}
      style={isToday ? undefined : { opacity: 0.45 }}
      onClick={onClick}
    >
      <span className="candy-face"><IconPlus size={14}/></span>
    </button>
  );
}

// The "+ New Event" chip keeps its labeled-chip form from the old Events pane.
function AddChip({ isToday, onClick, children }) {
  return (
    <button
      type="button"
      data-own-press
      className="candy-btn"
      data-shape="chip"
      disabled={!isToday}
      title={isToday ? undefined : 'Switch to today to add'}
      style={isToday ? undefined : { opacity: 0.45 }}
      onClick={onClick}
    >
      <span className="candy-face" style={{ gap: 5, fontSize: 10, padding: '4px 10px' }}>{children}</span>
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
  return (
    <div style={{ marginBottom: 8 }}>
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

// Hairline divider labeling the carryover block inside Tasks/Quick Notes.
function UnorgDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 2px' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
      <span style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: 'var(--text-faint)',
      }}>Unorganized</span>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
    </div>
  );
}

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

// Carryover age tint — group date labels warm from muted grey toward amber as
// the items get staler (~7 days to full warmth). Static color, not motion, so
// it carries no Animations toggle.
function ageColor(ds) {
  const age = Math.max(0, Math.round((Date.now() - new Date(`${ds}T00:00:00`).getTime()) / 86400000));
  const p = Math.min(age * 15, 100);
  return `color-mix(in oklch, var(--text-muted) ${100 - p}%, #d9a05b ${p}%)`;
}

// Mono counter beside a section title (EVENTS 3 · TASKS 2/5 · NOTES 4).
function CountBadge({ children }) {
  return (
    <span style={{
      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
      letterSpacing: '0.04em', color: 'var(--text-muted)',
    }}>{children}</span>
  );
}

// rAF count-up toward a changed value (~280ms, cubic ease-out). Disabled →
// snaps instantly (the counter-tick Animations toggle; JS-driven animations
// read the settings bag per the useSettings convention).
function useCountUp(value, enabled) {
  const [disp, setDisp] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    if (!enabled) { fromRef.current = value; setDisp(value); return undefined; }
    const from = fromRef.current;
    if (from === value) return undefined;
    const t0 = performance.now();
    const dur = 280;
    let raf;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisp(Math.round(from + (value - from) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); fromRef.current = value; };
  }, [value, enabled]);
  return disp;
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

  const { groups, loading: evLoading, error: evError, reload: reloadEvents } = useUpcomingWindow(14, pivotDs, tick);
  const day = useDaySections(pivotDs, tick);
  const unorg = useUnorganizedItems(tick);
  const { types } = useEventTypes();

  const [modalOpen, setModalOpen] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [addingNote, setAddingNote] = useState(false);

  // Date-header month popover — the date chip IS the picker button. Positioned
  // below the trigger rect (Popover is caller-positioned; useAnchoredRect
  // anchors above-dock, so the below-anchor math lives here), clamped to the
  // viewport. Esc closes ONLY the popover: Popover's own Esc is disabled and a
  // capture-phase handler stops the event before PlannerModal's bubble-phase
  // close (the NewEventModal pattern).
  const PICKER_W = 280;
  const dateBtnRef = useRef(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPos, setPickerPos] = useState(null);
  useLayoutEffect(() => {
    if (!pickerOpen) { setPickerPos(null); return; }
    const r = dateBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PICKER_W - 8));
    setPickerPos({ top: r.bottom + 10, left });
  }, [pickerOpen]);
  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setPickerOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pickerOpen]);

  const colorFor = (typeName) => {
    if (!typeName) return 'var(--text-faint)';
    const t = types.find(x => x.name.toLowerCase() === typeName.toLowerCase());
    return t?.color || 'var(--text-faint)';
  };

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

  // Live section counters (count-up honors its Animations toggle).
  const { settings: appSettings } = usePlanner();
  const tickOn = appSettings?.animations?.['counter-tick'] !== false;
  const evDisp = useCountUp(groups.reduce((n, g) => n + g.events.length, 0), tickOn);
  const taskDoneDisp = useCountUp(day.tasks.filter(t => t.checked).length, tickOn);
  const taskTotalDisp = useCountUp(day.tasks.length, tickOn);
  const noteDisp = useCountUp(day.notes.length, tickOn);

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
  // Carryover renders only under today — own-vs-carryover stays deduped by
  // construction (daily_get_unorganized excludes today; see also the midnight
  // guard: isToday flips before the next watcher tick regroups).
  const showCarryover = isToday && !unorg.loading;
  const carryTasks = showCarryover ? groupBySource(unorg.tasks) : [];
  const carryNotes = showCarryover ? groupBySource(unorg.notes) : [];

  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      borderLeft: '1px solid var(--border)',
    }}>
      {/* Header — the date itself is the day-picker button (popover in SF4);
          a Today chip appears whenever the pane is parked off-today. */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-soft)',
        flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <button
          type="button"
          ref={dateBtnRef}
          className="candy-btn planner-date-chip"
          data-shape="chip"
          data-own-press
          aria-label="Pick a day"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(v => !v)}
        >
          <span className="candy-face" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px' }}>
            <PaneHeader variant="date">{humanDate(pivotDs)}</PaneHeader>
            <span aria-hidden style={{ fontSize: 9, color: 'var(--text-muted)' }}>▾</span>
          </span>
        </button>
        {!isToday && (
          <button type="button" className="candy-btn" data-shape="chip" data-own-press onClick={() => onPivotChange(todayDs)} aria-label="Jump to today">
            <span className="candy-face" style={{ fontSize: 10, padding: '4px 10px' }}>Today</span>
          </button>
        )}
      </div>

      {/* Sections body — one scroll container for all three sections, keyed
          by the pivot so a day switch remounts it (fresh scroll + slide). */}
      <div
        key={pivotDs}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          padding: '14px 18px',
          display: 'flex', flexDirection: 'column', gap: 20,
          ...(slideName ? { animation: `${slideName} 400ms cubic-bezier(0.16, 1, 0.3, 1)` } : {}),
        }}>
        {/* ── Events — forward agenda anchored at the viewed day ── */}
        <section>
          <div className="candy-center-row" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <PaneHeader>Events</PaneHeader>
              <CountBadge>{evDisp}</CountBadge>
            </div>
            <AddChip isToday={isToday} onClick={() => setModalOpen(true)}>
              <IconPlus size={12}/> New Event
            </AddChip>
          </div>
          {evLoading ? (
            <Subdued>Loading…</Subdued>
          ) : evError ? (
            <Subdued>Couldn’t read upcoming events.</Subdued>
          ) : groups.length === 0 ? (
            <Subdued>No upcoming events.</Subdued>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {groups.map(({ ds, events }) => (
                <div key={ds}>
                  <div style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
                    letterSpacing: '0.02em', marginBottom: 5,
                  }}>{dayLabel(ds)}</div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {events.map((ev, i) => (
                      <li key={`${ds}-${i}`} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%', marginTop: 4, flexShrink: 0,
                          background: colorFor(ev.typeName),
                        }}/>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.35 }}>
                            {ev.time12 && (
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginRight: 6 }}>{ev.time12}</span>
                            )}
                            <span>{ev.title}</span>
                          </div>
                          {ev.note && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.3 }}>{ev.note}</div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Tasks List — the viewed day's ## Tasks + today's carryover ── */}
        <section>
          <div className="candy-center-row" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <PaneHeader>Tasks List</PaneHeader>
              <CountBadge>{taskDoneDisp}/{taskTotalDisp}</CountBadge>
            </div>
            <AddCircle isToday={isToday} label="New task" onClick={() => setAddingTask(true)}/>
          </div>
          {addingTask && (
            <InlineAdd
              placeholder="New task — Enter to add, Esc to cancel"
              onSubmit={(text) => api.daySections.addTask(pivotDs, text)}
              onClose={() => setAddingTask(false)}
            />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'calc(6px + var(--candy-depth-small))' }}>
            {day.loading ? (
              <Subdued>Loading…</Subdued>
            ) : day.error ? (
              <Subdued>Couldn’t read the daily log.</Subdued>
            ) : dayTasks.length === 0 && carryTasks.length === 0 ? (
              <Subdued>No tasks.</Subdued>
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
                {carryTasks.length > 0 && (
                  <>
                    <UnorgDivider/>
                    {carryTasks.map(([ds, items]) => (
                      <Group key={ds} label={shortDate(ds)} labelColor={ageColor(ds)}>
                        {items.map(t => (
                          <TaskChip key={`${t.path}:${t.line}`} path={t.path} line={t.line} text={t.text} sourceDate={t.sourceDate} showDate={false}/>
                        ))}
                      </Group>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </section>

        {/* ── Quick Notes — the viewed day's bullets + today's carryover ── */}
        <section>
          <div className="candy-center-row" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <PaneHeader>Quick Notes</PaneHeader>
              <CountBadge>{noteDisp}</CountBadge>
            </div>
            <AddCircle isToday={isToday} label="New quick note" onClick={() => setAddingNote(true)}/>
          </div>
          {addingNote && (
            <InlineAdd
              placeholder="New quick note — Enter to add, Esc to cancel"
              onSubmit={(text) => api.daySections.addNote(pivotDs, text)}
              onClose={() => setAddingNote(false)}
            />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'calc(6px + var(--candy-depth-small))' }}>
            {day.loading ? (
              <Subdued>Loading…</Subdued>
            ) : day.error ? (
              <Subdued>Couldn’t read the daily log.</Subdued>
            ) : day.notes.length === 0 && carryNotes.length === 0 ? (
              <Subdued>No quick notes.</Subdued>
            ) : (
              <>
                {day.notes.map(n => (
                  <NoteChip key={`${pivotDs}-${n.index}-${n.text}`} text={n.text} sourceDate={pivotDs} index={n.index} showDate={false}/>
                ))}
                {carryNotes.length > 0 && (
                  <>
                    <UnorgDivider/>
                    {carryNotes.map(([ds, items]) => (
                      <Group key={ds} label={shortDate(ds)} labelColor={ageColor(ds)}>
                        {items.map(n => (
                          <NoteChip key={`${n.sourceDate}-${n.index}`} text={n.text} sourceDate={n.sourceDate} index={n.index} showDate={false}/>
                        ))}
                      </Group>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <Popover
        open={pickerOpen && !!pickerPos}
        onClose={() => setPickerOpen(false)}
        ariaLabel="Pick a day"
        accent={accent}
        escToClose={false}
        outsideExempt=".planner-date-chip"
        style={{ position: 'fixed', zIndex: 1100, top: pickerPos?.top, left: pickerPos?.left, width: PICKER_W }}
        bodyStyle={{ padding: 12 }}
      >
        <MiniMonthPicker
          value={pivotDs}
          accent={accent}
          onSelect={(ds) => { onPivotChange(ds); setPickerOpen(false); }}
        />
      </Popover>

      <NewEventModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={reloadEvents}
        accent={accent}
        initialDs={pivotDs}
      />
    </div>
  );
}

// One Routine row (Planner Consolidation — the Frame + Recurring merge).
//
// NOT a fork of TaskChip. TaskChip is bound to a daily-log LINE — its edit,
// delete and drag all call api.noteActions.* with {path, line}. A Routine item
// has no log line: it lives in Pulse/Schedule.md's frames map and its tick is a
// flip-or-insert in the log's `## Routine` section. So this row talks to the
// routine writer, and reuses the SAME shared primitives TaskChip does —
// `.candy-btn[data-shape="chip-field"]` for the face and `ChipIconBtn` for the
// tick and the delete — so the two lists read as one surface.
//
// A timed item shows its range on the right; an untimed one shows nothing there
// and lives only in this list. Hold-and-drag hands off to startPaneDrag with
// kind 'routine', which the calendar routes to a frames write rather than a
// one-off session (see PlannerProvider.handleRoutineDrop).

import { useEffect, useRef, useState } from 'react';
import { ChipIconBtn, useHoldDrag } from './ItemChips.jsx';
import { IconCheck, IconX, IconRepeat } from '../icons.jsx';
import { useAnchoredRect } from '../ui/Popover.jsx';
import RepeatPopover from './RepeatPopover.jsx';
import { hasRule, describeRule } from '../../util/recurrence.js';
import { usePlanner } from '@modules/core/planner/PlannerProvider.jsx';

const ROW = { display: 'flex', alignItems: 'center', width: '100%' };
// Panel box, owned here because the CALLER positions a Popover (the component
// supplies chrome only). Height is the eight rows plus the body padding — it
// only has to be close enough to pick a side.
const REPEAT_PANEL_W = 284;
const REPEAT_PANEL_H = 330;

// "07:00" + "08:00" -> "07:00–08:00"; 24:00 stays the end-of-day sentinel.
function range(start, end) {
  return `${start}–${end}`;
}

export default function RoutineChip({ item, ds, onToggle, onDelete, onRename, onSetRule }) {
  const { startPaneDrag } = usePlanner();
  const checked = !!item.checked;

  // REPEAT. Only offered when a host passes onSetRule, so the read-only "all
  // routine" listing keeps the row it already had. The panel is anchored off
  // the trigger's own rect rather than positioned by guess.
  //
  // NO lit state, even when the item repeats (user-directed 2026-09-20): every
  // candy button is grey at rest and accent on hover, and a standing accent here
  // would break that run. The rule is carried by the button's title instead.
  const repeatRef = useRef(null);
  const [repeatOpen, setRepeatOpen] = useState(false);
  // Which side the panel drops on is decided from the trigger's REAL position at
  // open time, not assumed: a routine row sitting low in the pane has no room
  // under it, and useAnchoredRect does not flip on its own.
  const [place, setPlace] = useState('below');
  const repeatPos = useAnchoredRect(() => repeatRef.current?.getBoundingClientRect(),
    { open: repeatOpen, width: REPEAT_PANEL_W, place });
  const repeating = hasRule(item);
  const toggleRepeat = () => {
    const r = repeatRef.current?.getBoundingClientRect();
    if (r) setPlace(r.bottom + REPEAT_PANEL_H > window.innerHeight ? 'above' : 'below');
    setRepeatOpen(o => !o);
  };

  // INLINE EDIT, the same one TaskChip has (user-directed 2026-09-20: "i cant edit
  // the text within a currently existing routinechip"). The name used to be a plain
  // <span>, so there was nothing to type into - not a broken editor, an absent one.
  // The writer differs (a frames entry by id, not a log line by {path, line}), the
  // field does not.
  const [draft, setDraft] = useState(item.name);
  const doneRef = useRef(false);
  const inputRef = useRef(null);

  // Keep the live field synced to external edits (watcher refresh) unless the user
  // is mid-edit in this very input.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(item.name);
  }, [item.name]);

  // A chip born EMPTY is one the Routine + just made, so it takes the caret.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (item.name === '') inputRef.current?.focus(); }, []);

  // Commit on blur / Enter; the doneRef guard (reset on focus) collapses the
  // Enter-then-blur double-fire. Esc reverts and bails via the same guard.
  // Empty is checked FIRST so a chip abandoned straight after + deletes itself
  // rather than living on as a nameless row.
  const commit = async () => {
    if (doneRef.current) return; doneRef.current = true;
    const v = draft.trim();
    if (v === '') { await onDelete?.(item); return; }
    if (v === item.name) return;
    await onRename?.(item, v);
  };
  const cancel = () => { doneRef.current = true; setDraft(item.name); inputRef.current?.blur(); };

  const hold = useHoldDrag({
    onPickup: (ev) => {
      inputRef.current?.blur();
      window.getSelection?.()?.removeAllRanges?.();
      startPaneDrag('routine', { taskName: item.name, routineId: item.id }, item.name, ev);
    },
  });

  return (
    <div className="candy-split" style={ROW}>
      <span
        className="candy-btn"
        data-shape="chip-field"
        data-checked={checked ? 'true' : undefined}
        title={item.timed
          ? 'Click to edit · hold and drag onto the calendar to move it'
          : 'Click to edit · hold and drag onto the calendar to give it a time'}
        onMouseDown={hold.onMouseDown}
        style={{ flex: 1 }}
      >
        <span className="candy-face">
          <input
            ref={inputRef}
            className="chip-field-input"
            value={draft}
            spellCheck={false}
            style={{ flex: 1, minWidth: 0 }}
            onChange={e => setDraft(e.target.value)}
            onFocus={() => { doneRef.current = false; }}
            onClick={() => { if (hold.draggingRef.current) { hold.draggingRef.current = false; inputRef.current?.blur(); } }}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); inputRef.current?.blur(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
            }}
          />
          {item.timed && (
            <span className="chip-meta" style={{
              fontSize: 10,
              flexShrink: 0, fontFamily: 'var(--font-mono)',
            }}>{range(item.start, item.end)}</span>
          )}
        </span>
      </span>

      {onSetRule && (
        <ChipIconBtn
          btnRef={repeatRef}
          className="routine-repeat-trigger"
          title={repeating ? describeRule(item) : 'Does not repeat'}
          onClick={toggleRepeat}
        ><IconRepeat size={12}/></ChipIconBtn>
      )}
      {onSetRule && (
        <RepeatPopover
          open={repeatOpen && !!repeatPos}
          onClose={() => setRepeatOpen(false)}
          style={{ position: 'fixed', zIndex: 1100, width: REPEAT_PANEL_W,
                   left: repeatPos?.left, top: repeatPos?.top, bottom: repeatPos?.bottom }}
          ds={ds}
          item={item}
          onPick={(rule) => onSetRule(item, rule)}
        />
      )}

      <ChipIconBtn
        title={checked ? 'Uncheck' : 'Check off'}
        active={checked}
        onClick={() => onToggle?.(item.name)}
      ><IconCheck size={12}/></ChipIconBtn>

      {/* Delete — the same round ✕ TaskChip carries, so the two lists still
          read as one surface. It drops the item from THIS weekday's frames
          entry, which is every future occurrence of it; unlike a task's ✕
          there is no undo toast behind it (the routine writer has none). Only
          rendered when a host passes onDelete. */}
      {onDelete && (
        <ChipIconBtn
          round
          title="Delete routine item"
          onClick={() => onDelete(item)}
        ><IconX/></ChipIconBtn>
      )}
    </div>
  );
}

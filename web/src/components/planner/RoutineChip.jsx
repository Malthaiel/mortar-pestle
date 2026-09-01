// One Routine row (Planner Consolidation — the Frame + Recurring merge).
//
// NOT a fork of TaskChip. TaskChip is bound to a daily-log LINE — its edit,
// delete and drag all call api.noteActions.* with {path, line}. A Routine item
// has no log line: it lives in Pulse/Schedule.md's frames map and its tick is a
// flip-or-insert in the log's `## Routine` section. So this row talks to the
// routine writer, and reuses the SAME shared primitives TaskChip does —
// `.candy-btn[data-shape="chip-field"]` for the face and `ChipIconBtn` for the
// tick — so the two lists read as one surface.
//
// A timed item shows its range on the right; an untimed one shows nothing there
// and lives only in this list. Hold-and-drag hands off to startPaneDrag with
// kind 'routine', which the calendar routes to a frames write rather than a
// one-off session (see PlannerProvider.handleRoutineDrop).

import { ChipIconBtn, useHoldDrag } from './ItemChips.jsx';
import { IconCheck } from '../icons.jsx';
import { usePlanner } from '@modules/core/planner/PlannerProvider.jsx';

const ROW = { display: 'flex', alignItems: 'center', width: '100%' };

// "07:00" + "08:00" -> "07:00–08:00"; 24:00 stays the end-of-day sentinel.
function range(start, end) {
  return `${start}–${end}`;
}

export default function RoutineChip({ item, onToggle }) {
  const { startPaneDrag } = usePlanner();
  const checked = !!item.checked;

  const hold = useHoldDrag({
    onPickup: (ev) => {
      window.getSelection?.()?.removeAllRanges?.();
      startPaneDrag('routine', { taskName: item.name, routineId: item.id }, item.name, ev);
    },
  });

  return (
    <div style={ROW}>
      <span
        className="candy-btn"
        data-shape="chip-field"
        data-checked={checked ? 'true' : undefined}
        title={item.timed
          ? 'Hold and drag onto the calendar to move it'
          : 'Hold and drag onto the calendar to give it a time'}
        onMouseDown={hold.onMouseDown}
        style={{ flex: 1 }}
      >
        <span className="candy-face">
          <span className="chip-field-input" style={{
            flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{item.name}</span>
          {item.timed && (
            <span className="chip-meta" style={{
              fontSize: 10,
              flexShrink: 0, fontFamily: 'var(--font-mono)',
            }}>{range(item.start, item.end)}</span>
          )}
        </span>
      </span>

      <ChipIconBtn
        title={checked ? 'Uncheck' : 'Check off'}
        active={checked}
        onClick={() => onToggle?.(item.name)}
      ><IconCheck size={12}/></ChipIconBtn>
    </div>
  );
}

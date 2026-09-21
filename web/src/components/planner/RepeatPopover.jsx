// Repeat chooser for a Routine item — the one new component in Planner
// Recurrence (approved 2026-09-20). Not a new SHAPE: it is the same compact
// chooser SplitChooserPopover / LogMealPopover already are — `Popover` + a
// scrolling run of borderless rows + a candy footer — so it inherits the look
// rather than inventing one.
//
// Every preset is built FROM the date the chip is being viewed on, so "Weekly
// on Sunday" means the Sunday he is looking at, never a hardcoded day. The row
// labels come from `describeRule`, the same function that labels the trigger —
// there is no second copy of the wording (measure, never predict).
//
// Picking a row writes the rule and closes; typing in an interval box does not,
// because the number is not a choice until its row is clicked.

import { useState } from 'react';
import Popover from '../ui/Popover.jsx';
import { IconCheck } from '../icons.jsx';
import { dateFromKey } from '../../util/events.js';
import { describeRule, WEEKDAY_BY_INDEX } from '../../util/recurrence.js';

export default function RepeatPopover({ open, onClose, style, accent = 'var(--accent)', ds, item, onPick }) {
  const [everyDays, setEveryDays] = useState(2);
  const [everyWeeks, setEveryWeeks] = useState(2);

  if (!ds) return null;
  const date = dateFromKey(ds);
  const weekday = WEEKDAY_BY_INDEX[date.getDay()];
  const monthday = date.getDate();
  const month = date.getMonth() + 1;
  const nth = Math.floor((monthday - 1) / 7) + 1;

  // `from` anchors both the interval rhythm and the first date the rule fires.
  const from = ds;
  const rows = [
    { key: 'none', rule: null },
    { key: 'daily', rule: { freq: 'daily', from } },
    { key: 'everyDays', rule: { freq: 'daily', interval: everyDays, from }, count: everyDays, setCount: setEveryDays, unit: 'days' },
    { key: 'weekly', rule: { freq: 'weekly', weekday, from } },
    { key: 'everyWeeks', rule: { freq: 'weekly', interval: everyWeeks, weekday, from }, count: everyWeeks, setCount: setEveryWeeks, unit: 'weeks', tail: ` on ${describeRule({ freq: 'weekly', weekday }).replace('Weekly on ', '')}` },
    { key: 'monthly', rule: { freq: 'monthly', monthday, from } },
    { key: 'monthlyNth', rule: { freq: 'monthlyNth', nth, weekday, from } },
    { key: 'yearly', rule: { freq: 'yearly', month, monthday, from } },
  ];

  // Two rules are the same choice when they READ the same — the labels are
  // generated from the rule itself, so this cannot drift from the options.
  const current = describeRule(item || {});
  const rowBtn = (active) => ({
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
    background: active ? `color-mix(in oklch, ${accent} 16%, transparent)` : 'none',
    border: 'none', borderBottom: '1px solid var(--border-soft)', color: 'var(--text)',
    padding: '8px 10px', cursor: 'pointer', font: 'inherit', fontSize: 12.5,
  });

  const pick = (rule) => { onPick?.(rule); onClose(); };

  return (
    <Popover open={open} onClose={onClose} accent={accent} ariaLabel="Repeat"
             style={style} bodyStyle={{ padding: 12 }} outsideExempt=".routine-repeat-trigger">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
        <div style={{ border: '1px solid var(--border-soft)', borderRadius: 8, overflow: 'hidden' }}>
          {rows.map((r) => {
            const label = describeRule(r.rule || {});
            const active = label === current;
            return (
              <button key={r.key} type="button" style={rowBtn(active)}
                      onClick={() => pick(r.rule)} title={label}>
                {active ? <IconCheck size={12}/> : <span style={{ width: 12, flexShrink: 0 }}/>}
                {r.count === undefined ? (
                  <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
                ) : (
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                    Every
                    <input
                      className="candy-input"
                      type="number" min={2} max={99} value={r.count}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => r.setCount(Math.max(2, Math.min(99, Number(e.target.value) || 2)))}
                      style={{ width: 46, padding: '1px 4px', fontSize: 12 }}
                    />
                    {r.unit}{r.tail || ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </Popover>
  );
}

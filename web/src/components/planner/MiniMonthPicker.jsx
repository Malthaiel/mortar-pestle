// Month-grid day picker for the New Event popup. Monday-first, reuses the
// two-layer candy `daycell` shape (shared with the planner calendar). Selecting
// a day calls onSelect(ds) with the "YYYY-MM-DD" key. Self-contained — no planner coupling.

import { useState } from 'react';
import { IconChevronLeft, IconChevronRight } from '../icons.jsx';
import { keyForDate } from '../../util/events.js';
import { candyGap } from '../../util/candy.js';

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function monthGrid(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const dow = (first.getDay() + 6) % 7; // Monday-first offset
  const start = new Date(first);
  start.setDate(1 - dow);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export default function MiniMonthPicker({ value, onSelect, accent = 'var(--accent)' }) {
  const today = new Date();
  const todayKey = keyForDate(today);
  const initial = value ? new Date(`${value}T00:00:00`) : today;
  const [anchor, setAnchor] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
  const days = monthGrid(anchor);
  const monthIdx = anchor.getMonth();
  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const step = (delta) => setAnchor(a => new Date(a.getFullYear(), a.getMonth() + delta, 1));
  const jump = (offsetDays) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    setAnchor(new Date(d.getFullYear(), d.getMonth(), 1));
    onSelect(keyForDate(d));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button type="button" data-own-press className="candy-btn" data-shape="chip" onClick={() => step(-1)} aria-label="Previous month"><span className="candy-face" style={{ padding: 4 }}><IconChevronLeft/></span></button>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>{monthLabel}</div>
        <button type="button" data-own-press className="candy-btn" data-shape="chip" onClick={() => step(1)} aria-label="Next month"><span className="candy-face" style={{ padding: 4 }}><IconChevronRight/></span></button>
      </div>

      <div className="candy-chip-row" style={{ justifyContent: 'center', margin: '8px 0', '--candy-gap': '8px' }}>
        <QuickBtn onClick={() => jump(0)}>Today</QuickBtn>
        <QuickBtn onClick={() => jump(1)}>Tomorrow</QuickBtn>
        <QuickBtn onClick={() => jump(7)}>+1 week</QuickBtn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
        {WD.map(l => (
          <div key={l} style={{
            textAlign: 'center', fontSize: 9, fontFamily: 'var(--font-mono)',
            color: 'var(--text-faint)', letterSpacing: '0.05em', paddingBottom: 4,
          }}>{l}</div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: '30px', columnGap: 4, rowGap: candyGap(4, true) }}>
        {days.map(d => {
          const ds = keyForDate(d);
          const inMonth = d.getMonth() === monthIdx;
          const isToday = ds === todayKey;
          const isSel = value && ds === value;
          return (
            <button
              key={ds}
              type="button"
              data-own-press
              onClick={() => onSelect(ds)}
              className={`candy-btn${isToday ? ' is-today' : ''}`}
              data-shape="daycell"
              style={{
                '--cal-cell-face': isSel ? accent : 'var(--surface)',
                opacity: inMonth ? 1 : 0.4,
              }}
            ><span className="candy-face" style={{
                boxShadow: isSel ? `inset 0 0 0 2px ${accent}` : undefined,
                color: isSel ? 'var(--on-accent)' : (isToday ? 'var(--accent)' : 'var(--text)'),
                fontSize: 11, fontWeight: (isToday || isSel) ? 700 : 500,
                fontFamily: 'var(--font-mono)',
              }}>{d.getDate()}</span></button>
          );
        })}
      </div>
    </div>
  );
}

function QuickBtn({ onClick, children }) {
  return (
    <button type="button" data-own-press className="candy-btn" data-shape="chip" onClick={onClick}>
      <span className="candy-face" style={{ fontSize: 10, padding: '3px 9px' }}>{children}</span></button>
  );
}

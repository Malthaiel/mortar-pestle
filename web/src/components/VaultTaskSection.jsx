import { useMemo, useState } from 'react';

function VaultTaskRow({ task, active, onSelect, onToggle, accent, onDragStart }) {
  const [hover, setHover] = useState(false);
  const priorityColor = task.priority === 'high' ? 'var(--text)'
    : task.priority === 'medium' ? '#d35400'
    : task.priority === 'low' ? '#27ae60'
    : 'var(--text-faint)';

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={e => { e.stopPropagation(); if (e.button === 0) onDragStart?.(task.display, e); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 18px 4px 20px',
        cursor: 'grab', userSelect: 'none',
        background: active ? `${accent}12` : 'transparent',
        borderRadius: 0, transition: 'background 80ms',
      }}>
      <span style={{ fontSize: 8, color: 'var(--text-faint)', fontFamily: 'DM Mono', width: 14, flexShrink: 0, textAlign: 'right' }}>
        {hover ? '⋮⋮' : ''}
      </span>
      <span style={{ width: 2, height: 2, borderRadius: '50%', background: priorityColor, flexShrink: 0 }}/>
      <button onClick={e => { e.stopPropagation(); onSelect?.(); }} style={{
        flex: 1, textAlign: 'left', fontSize: 12, fontWeight: 500,
        color: task.checked ? 'var(--text-faint)' : 'var(--text)',
        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        textDecoration: task.checked ? 'line-through' : 'none',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {task.display}
      </button>
      {task.project && (
        <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 'var(--radius-md)', background: 'var(--surface-3)', color: 'var(--text-muted)', flexShrink: 0 }}>
          {task.project}
        </span>
      )}
      <button onClick={e => { e.stopPropagation(); onToggle?.(task.raw); }}
        style={{
          width: 16, height: 16, borderRadius: 'var(--radius-sm)',
          border: `1.5px solid ${task.checked ? accent : 'var(--border)'}`,
          background: task.checked ? accent : 'transparent',
          cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.1s',
        }}>
        {task.checked && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        )}
      </button>
    </div>
  );
}

function RoutineRow({ item, accent, onToggle }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '3px 18px 3px 20px',
        userSelect: 'none', opacity: 0.85,
      }}>
      <span style={{ width: 14, flexShrink: 0 }}/>
      <span style={{ flex: 1, fontSize: 11, fontWeight: 400,
        color: item.checked ? 'var(--text-faint)' : 'var(--text-muted)',
        textDecoration: item.checked ? 'line-through' : 'none',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {item.task}
      </span>
      <button onClick={() => onToggle?.(item.task)}
        style={{
          width: 14, height: 14, borderRadius: 'var(--radius-sm)',
          border: `1.5px solid ${item.checked ? accent : 'var(--border)'}`,
          background: item.checked ? accent : 'transparent',
          cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.1s',
        }}>
        {item.checked && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        )}
      </button>
    </div>
  );
}

export default function VaultTaskSection({ tasks, activeRaw, onSelect, onToggle, accent, onDragStart, routineItems = [], onToggleRoutine }) {
  const sections = useMemo(() => {
    const m = { overdue: [], today_high: [], today_medium: [], today_low: [], daily: [], today_other: [] };
    for (const t of tasks) {
      if (t.section === 'overdue') m.overdue.push(t);
      else if (t.section === 'today') {
        if (t.priority === 'high') m.today_high.push(t);
        else if (t.priority === 'medium') m.today_medium.push(t);
        else if (t.priority === 'low') m.today_low.push(t);
        else m.today_other.push(t);
      }
      else m.daily.push(t);
    }
    return m;
  }, [tasks]);

  const sectionHeader = (label, color) => (
    <div style={{
      fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
      color, padding: '12px 20px 4px',
    }}>{label}</div>
  );

  if (tasks.length === 0 && routineItems.length === 0) return null;

  const renderRows = (group, prefix) => group.map((t, i) => (
    <VaultTaskRow key={`${prefix}-${i}`} task={t} active={t.raw === activeRaw}
      onSelect={() => onSelect(t.raw)} onToggle={onToggle}
      accent={accent} onDragStart={onDragStart}/>
  ));

  return (
    <div style={{ paddingTop: 4, paddingBottom: 8 }}>
      {sections.overdue.length > 0 && sectionHeader('Overdue', 'var(--text)')}
      {renderRows(sections.overdue, 'ov')}
      {sections.today_high.length > 0 && sectionHeader('High Priority', 'var(--text-muted)')}
      {renderRows(sections.today_high, 'th')}
      {sections.today_medium.length > 0 && sectionHeader('Medium Priority', 'var(--text-muted)')}
      {renderRows(sections.today_medium, 'tm')}
      {sections.today_low.length > 0 && sectionHeader('Low Priority', 'var(--text-muted)')}
      {renderRows(sections.today_low, 'tl')}
      {sections.today_other.length > 0 && sectionHeader('Tasks', 'var(--text-muted)')}
      {renderRows(sections.today_other, 'to')}
      {sections.daily.length > 0 && sectionHeader('Daily', 'var(--text-muted)')}
      {renderRows(sections.daily, 'd')}
      {routineItems.length > 0 && sectionHeader('Routine', 'var(--text-faint)')}
      {routineItems.map((it, i) => (
        <RoutineRow key={`r-${i}`} item={it} accent={accent} onToggle={onToggleRoutine}/>
      ))}
    </div>
  );
}

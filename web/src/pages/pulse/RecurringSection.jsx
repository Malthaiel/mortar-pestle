import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import SectionHeader, { HeaderChip, EmptyState, LoadingState } from './SectionHeader.jsx';

const RECURRING_PAGE = 'Pulse/Recurring Tasks';

export default function RecurringSection({ refetchKey, accent }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.routine()
      .then(d => setItems(d.items || []))
      .catch(err => console.warn('routine fetch failed:', err))
      .finally(() => setLoading(false));
  }, [refetchKey]);

  const total = items.length;
  const done = items.filter(it => it.checked).length;
  const pending = items.filter(it => !it.checked);
  const completed = items.filter(it => it.checked);

  const editChip = (
    <HeaderChip href={'#/page/' + encodeURIComponent(RECURRING_PAGE)} title="Edit Recurring Tasks.md">
      Edit ↗
    </HeaderChip>
  );
  const subtitle = total > 0 ? `${done} of ${total} done` : null;
  const progress = total > 0 ? done / total : null;

  return (
    <section>
      <SectionHeader
        title="Recurring"
        subtitle={subtitle}
        action={editChip}
        progress={progress}
        accent={accent}
      />
      {loading && <LoadingState/>}
      {!loading && total === 0 && (
        <EmptyState
          message="No recurring tasks defined."
          ctaLabel="Add Recurring ↗"
          ctaHref={'#/page/' + encodeURIComponent(RECURRING_PAGE)}
          accent={accent}
        />
      )}
      {!loading && total > 0 && (
        <div style={{
          padding: '12px 18px 32px',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {pending.map((it, i) => (
            <Row key={`p-${i}`} item={it} accent={accent}/>
          ))}
          {pending.length > 0 && completed.length > 0 && (
            <div style={{
              height: 1, background: 'var(--divider)',
              margin: '10px 14px',
            }}/>
          )}
          {completed.map((it, i) => (
            <Row key={`d-${i}`} item={it} accent={accent}/>
          ))}
        </div>
      )}
    </section>
  );
}

function Row({ item, accent }) {
  const done = !!item.checked;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      minHeight: 32, padding: '4px 14px',
      borderRadius: 8,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: done ? accent : 'var(--text-faint)',
        flexShrink: 0,
      }}/>
      <span style={{
        flex: 1, minWidth: 0,
        fontSize: 13, lineHeight: 1.3,
        color: done ? 'var(--text-muted)' : 'var(--text)',
        textDecoration: done ? 'line-through' : 'none',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{item.task}</span>
    </div>
  );
}

import { useMemo } from 'react';
import { StatTile } from '@host/components/ui/index.js';

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

export default function AnalyticsPanel({ sessions, accent }) {
  const dailyData = useMemo(() => {
    const map = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      map[dateKey(d)] = 0;
    }
    for (const s of sessions) {
      const dk = s.dateKey || dateKey(new Date(s.start || Date.now()));
      if (map[dk] !== undefined) map[dk] += s.durMin || 25;
    }
    return Object.entries(map).map(([date, mins]) => ({ date: date.slice(5), mins }));
  }, [sessions]);

  const totalWeek = dailyData.reduce((a, d) => a + d.mins, 0);
  const totalHours = Math.floor(totalWeek / 60);
  const totalMins = totalWeek % 60;
  const avgSession = sessions.length > 0
    ? Math.round(sessions.reduce((a, s) => a + (s.durMin || 25), 0) / sessions.length)
    : 0;
  const maxMins = Math.max(...dailyData.map(d => d.mins), 1);

  const taskData = useMemo(() => {
    const map = {};
    for (const s of sessions) {
      const t = s.task || 'Untitled';
      map[t] = (map[t] || 0) + (s.durMin || 25);
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [sessions]);

  return (
    <div className="flex-col" style={{
      height: '100%', overflowY: 'auto', padding: '18px 20px',
    }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        gap: 8, marginBottom: 22,
      }}>
        <StatTile label="This Week" value={`${totalHours}h ${totalMins}m`} accent={totalWeek > 0 ? accent : null}/>
        <StatTile label="Avg Session" value={`${avgSession}m`}/>
      </div>

      <SectionLabel>Daily Focus</SectionLabel>
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 5, height: 96,
        marginBottom: 22,
      }}>
        {dailyData.map(d => {
          const has = d.mins > 0;
          return (
            <div key={d.date} style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 5,
            }}>
              <span style={{
                fontSize: 8, color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
              }}>{has ? `${d.mins}m` : ''}</span>
              <div style={{
                width: '100%',
                height: has ? Math.max((d.mins / maxMins) * 70, 6) : 2,
                borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
                background: has ? accent : 'var(--border)',
                opacity: has ? 1 : 0.7,
                transition: 'height 200ms ease',
              }}/>
              <span style={{
                fontSize: 8, color: 'var(--text-faint)',
                fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '0.04em',
              }}>{d.date}</span>
            </div>
          );
        })}
      </div>

      {taskData.length > 0 && (
        <>
          <SectionLabel>Top Tasks</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {taskData.map(([name, mins], i) => (
              <TopTaskRow
                key={name}
                rank={i + 1}
                name={name}
                mins={mins}
                accent={accent}
                first={i === 0}
              />
            ))}
          </div>
        </>
      )}

      {sessions.length === 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 14, padding: '32px 0',
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: 'var(--text-faint)', opacity: 0.5,
          }}/>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
            No sessions yet — start a focus session.
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 600,
      fontFamily: 'var(--font-mono)',
      color: 'var(--text-faint)',
      marginBottom: 8,
      letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>{children}</div>
  );
}

function TopTaskRow({ rank, name, mins, accent, first }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 10px', borderRadius: 'var(--radius-sm)',
      background: first ? `color-mix(in oklch, ${accent} 8%, transparent)` : 'transparent',
      transition: 'background 120ms ease',
      minHeight: 28,
    }}
    onMouseEnter={e => { if (!first) e.currentTarget.style.background = 'var(--hover)'; }}
    onMouseLeave={e => { if (!first) e.currentTarget.style.background = 'transparent'; }}>
      <span style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
        color: first ? accent : 'var(--text-faint)',
        width: 16, fontWeight: first ? 700 : 500,
        letterSpacing: '0.04em',
      }}>{rank}</span>
      <span style={{
        fontSize: 12, flex: 1, color: first ? 'var(--text)' : 'var(--text-2)',
        fontWeight: first ? 600 : 500,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{name}</span>
      <span style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
        color: first ? accent : 'var(--text-muted)',
        letterSpacing: '0.04em',
      }}>{Math.round(mins / 60)}h {mins % 60}m</span>
    </div>
  );
}

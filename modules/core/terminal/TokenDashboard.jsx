// Token Dashboard — local Claude Code usage (cache-hit rate, token spend,
// 1h-vs-5m TTL split) read from ~/.claude/projects via the `claude_token_stats`
// Rust command. KPI tiles reuse the shared StatTile; the charts are minimal
// inline proportional bars (no charting dep). Data is a pull (mount + Refresh),
// local to this machine.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { StatTile, Select } from '@host/components/ui/index.js';
import { IconRotateCw } from '@host/components/icons.jsx';

const RANGES = [{ value: 'all', label: 'All time' }, { value: '30', label: 'Last 30 days' }, { value: '7', label: 'Last 7 days' }];

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
const total = (b) => (b.input || 0) + (b.output || 0) + (b.cache_read || 0) + (b.cache_create || 0);
const fresh = (b) => (b.input || 0) + (b.output || 0) + (b.cache_create || 0);
const hitPct = (b) => {
  const den = (b.input || 0) + (b.cache_read || 0);
  return den > 0 ? ((b.cache_read || 0) / den) * 100 : 0;
};
const shortModel = (m) => (m || '').replace(/^claude-/, '') || m;

function SplitBar({ a, b, max, aColor, bColor, height = 8 }) {
  const wa = max > 0 ? Math.min(100, (a / max) * 100) : 0;
  const wb = max > 0 ? Math.min(100 - wa, (b / max) * 100) : 0;
  return (
    <div style={{ flex: 1, height, borderRadius: 999, background: 'var(--surface-3)', overflow: 'hidden', display: 'flex' }}>
      <div style={{ width: `${wa}%`, background: aColor, transition: 'width 200ms ease' }} />
      <div style={{ width: `${wb}%`, background: bColor, transition: 'width 200ms ease' }} />
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

export default function TokenDashboard({ accent }) {
  const accentColor = accent || 'var(--text)';
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [range, setRange] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await invoke('claude_token_stats');
      setStats(s);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const daily = useMemo(() => {
    const d = stats?.daily || [];
    return range === 'all' ? d : d.slice(-Number(range));
  }, [stats, range]);
  const maxDay = useMemo(() => Math.max(1, ...daily.map(total)), [daily]);
  const maxModel = useMemo(() => Math.max(1, ...(stats?.by_model || []).map(total)), [stats]);

  if (loading && !stats) {
    return <Centered>Loading token usage…</Centered>;
  }
  if (error) {
    return <Centered tone="error">Failed to read usage: {error}</Centered>;
  }
  if (stats && !stats.available) {
    return <Centered>No Claude Code sessions found at<br/><code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{stats.root}</code></Centered>;
  }
  if (!stats) return <Centered>—</Centered>;

  const t = stats.total;
  const ttlTotal = (t.eph_1h || 0) + (t.eph_5m || 0);

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 18px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Token Dashboard</div>
          <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {stats.file_count} sessions · local to this machine
          </div>
        </div>
        <div style={{ width: 140, flexShrink: 0 }}>
          <Select value={range} onChange={setRange} options={RANGES} accent={accentColor} style={{ borderRadius: 'var(--radius-md)', background: 'var(--surface-2)' }} />
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          title="Refresh"
          className="candy-btn"
          style={{ '--accent': accentColor, height: 32, borderRadius: 8, flexShrink: 0, opacity: loading ? 0.6 : 1 }}
        >
          <span className="candy-face" style={{ padding: '0 12px', gap: 6, fontSize: 12 }}>
            <IconRotateCw size={14}/> {loading ? '…' : 'Refresh'}
          </span>
        </button>
      </div>

      {/* Scroll body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
          <StatTile label="Cache hit-rate" value={hitPct(t).toFixed(1) + '%'} accent={accentColor} />
          <StatTile label="Tokens saved" value={fmtNum((t.cache_read || 0) * 0.9)} accent={accentColor} />
          <StatTile label="Input (w/ cache)" value={fmtNum((t.input || 0) + (t.cache_read || 0) + (t.cache_create || 0))} />
          <StatTile label="Output" value={fmtNum(t.output)} />
          <StatTile label="Sessions" value={String(stats.sessions.length)} />
        </div>

        {/* Cache TTL split */}
        <Section title="Cache write TTL — 1 hour vs 5 minute">
          {ttlTotal > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <SplitBar a={t.eph_1h} b={t.eph_5m} max={ttlTotal} aColor={accentColor} bColor="var(--text-faint)" height={10} />
              <div style={{ display: 'flex', gap: 14, fontSize: 11, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                <span style={{ color: accentColor }}>1h {fmtNum(t.eph_1h)} ({((t.eph_1h / ttlTotal) * 100).toFixed(0)}%)</span>
                <span style={{ color: 'var(--text-muted)' }}>5m {fmtNum(t.eph_5m)}</span>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>No TTL split recorded in these sessions.</div>
          )}
        </Section>

        {/* Daily */}
        <Section title="Daily — cache read vs fresh">
          {daily.length === 0 ? (
            <Empty>No daily data.</Empty>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {daily.map((d) => (
                <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 80, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>{d.date}</span>
                  <SplitBar a={d.cache_read} b={fresh(d)} max={maxDay} aColor={accentColor} bColor="var(--text-faint)" />
                  <span style={{ width: 56, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtNum(total(d))}</span>
                  <span style={{ width: 44, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: accentColor, flexShrink: 0 }}>{hitPct(d).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* By model */}
        <Section title="By model">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(stats.by_model || []).map((m) => (
              <div key={m.model} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 150, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{shortModel(m.model)}</span>
                <SplitBar a={total(m)} b={0} max={maxModel} aColor={accentColor} bColor="transparent" />
                <span style={{ width: 56, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtNum(total(m))}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* Sessions */}
        <Section title={`Sessions (top ${Math.min(25, stats.sessions.length)} of ${stats.sessions.length})`}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              <thead>
                <tr style={{ color: 'var(--text-faint)', textAlign: 'left' }}>
                  {['session', 'date', 'tokens', 'hit %', 'model'].map((h) => (
                    <th key={h} style={{ padding: '4px 10px 6px 0', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.sessions.slice(0, 25).map((s) => (
                  <tr key={s.id} style={{ color: 'var(--text-muted)' }}>
                    <td style={{ padding: '4px 10px 4px 0' }}>{s.id.slice(0, 8)}</td>
                    <td style={{ padding: '4px 10px 4px 0' }}>{s.date}</td>
                    <td style={{ padding: '4px 10px 4px 0', color: 'var(--text)' }}>{fmtNum(total(s))}</td>
                    <td style={{ padding: '4px 10px 4px 0', color: accentColor }}>{hitPct(s).toFixed(0)}%</td>
                    <td style={{ padding: '4px 10px 4px 0' }}>{shortModel(s.model)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Centered({ children, tone }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 32, fontSize: 12, lineHeight: 1.6, color: tone === 'error' ? 'var(--error)' : 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
      <div>{children}</div>
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>{children}</div>;
}

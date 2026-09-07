// One line in the Processes window: source icon, title + subtitle, the shared
// `.candy-groove` progress bar (the same rail ExportDialog and CoachPopup use —
// no new bar), a live elapsed clock, and Stop.
//
// Elapsed ticks off the row's OWN reported start time. A source that reports no
// start time gets no clock rather than an invented one.

import { useEffect, useState } from 'react';
import { DangerOutlinedBtn } from '../components/ui';
import {
  IconFilm, IconBrain, IconMic, IconVideo, IconBroadcast, IconTerminal, IconPackage, IconActivity,
} from '../components/icons.jsx';

const ICONS = {
  render: IconFilm,
  notes: IconBrain,
  mic: IconMic,
  video: IconVideo,
  broadcast: IconBroadcast,
  terminal: IconTerminal,
  package: IconPackage,
};

// Whole units below 10 GB-ish; one decimal only where it earns its place.
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// One second tick, mounted only while a row actually shows a clock.
function Elapsed({ startedMs }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
      {fmtElapsed(now - startedMs)}
    </span>
  );
}

export default function ProcessRow({ row, accent, onCancel }) {
  const Icon = ICONS[row.kind] || IconActivity;
  const pct = row.progress == null ? null : Math.round(row.progress * 100);

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 8,
        border: '1px solid var(--border)', background: 'var(--surface)',
        opacity: row.active ? 1 : 0.72,
      }}
    >
      <span style={{ color: row.error ? 'var(--error)' : 'var(--text-muted)', flexShrink: 0, display: 'flex' }}>
        <Icon size={16} />
      </span>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>{row.title}</span>
          {row.subtitle && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.subtitle}
            </span>
          )}
        </div>

        <div style={{ fontSize: 11, color: row.error ? 'var(--error)' : 'var(--text-muted)', marginTop: 1 }}>
          {row.statusLine}
        </div>

        {row.active && pct != null && (
          <div className="candy-groove" style={{ height: 5, marginTop: 6, '--accent': accent }}>
            <div className="candy-groove__fill" style={{ width: `${pct}%`, transition: 'width 240ms ease' }} />
          </div>
        )}
      </div>

      {row.active && (row.cpuPct != null || row.rssBytes != null) && (
        <span style={{
          fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11,
          color: 'var(--text-muted)', flexShrink: 0, textAlign: 'right', minWidth: 92,
        }}>
          {row.cpuPct != null ? `${row.cpuPct.toFixed(1)}% CPU` : ''}
          {row.cpuPct != null && row.rssBytes != null ? ' · ' : ''}
          {row.rssBytes != null ? fmtBytes(row.rssBytes) : ''}
        </span>
      )}

      {row.active && row.startedMs ? <Elapsed startedMs={row.startedMs} /> : null}

      {row.active && row.canCancel && (
        <DangerOutlinedBtn onClick={() => onCancel(row)}>Stop</DangerOutlinedBtn>
      )}
    </div>
  );
}

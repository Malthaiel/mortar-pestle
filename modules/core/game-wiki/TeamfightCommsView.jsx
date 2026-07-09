// TeamfightCommsView — the Teamfight Comms Review popup (Deadlock Scrim Coaching, sub-plan 13).
// Reuses VodReportView / MatchViewPopup chrome (AppWindow); the body is new: a stacked, scrollable
// list of teamfight moments, each showing its deaths, the coached team's ordered callouts with
// Claude's good/wrong/late verdicts, the jumble label, and the calls it flags as missed (with a
// should've-said line). Read-only v1 — verdicts are Claude's guesses, no correction UI yet. Reads
// the .tfcomms sidecar (source of truth). New component approved 2026-07-09 (reuses AppWindow — no
// new primitive). Timestamps are game-clock m:ss; the coach scrubs the recording manually (no seek IPC).

import { useEffect, useState } from 'react';
import { api } from '@host/api.js';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { IconTable } from '@host/components/icons.jsx';
import { mmss } from './teamfightComms.js';

const muted = { color: 'var(--text-muted)', fontSize: 13 };
const JUMBLE_COLOR = { Jumbled: 'var(--error)', Busy: 'var(--accent)', Clear: 'var(--text-muted)' };
// Text-only marks (no decorative icons) per the app's chip-label convention.
const VERDICT = {
  good: { mark: '✓', color: 'var(--ok, #4caf50)' },
  wrong: { mark: '✕', color: 'var(--error)' },
  late: { mark: 'late', color: 'var(--accent)' },
};

function Chip({ children }) {
  return <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', borderRadius: 4, padding: '1px 6px' }}>{children}</span>;
}

function Fight({ f }) {
  const jc = JUMBLE_COLOR[f.jumble?.label] || 'var(--text-muted)';
  const deaths = f.deaths || [];
  return (
    <div style={{ paddingBottom: 14, marginBottom: 14, borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{mmss(f.tStart)}–{mmss(f.tEnd)}</span>
        <span style={{ fontSize: 12, color: jc, fontWeight: 600 }}>{f.jumble?.label || '—'}</span>
        {f.jumble?.overlap > 0 && <Chip>{f.jumble.overlap} overlapping</Chip>}
      </div>
      <div style={{ ...muted, marginBottom: 6 }}>
        deaths: {deaths.length
          ? deaths.map((d, i) => <span key={i} style={{ color: d.ours ? 'var(--text)' : 'var(--text-muted)' }}>{d.hero}{d.ours ? '' : ' (enemy)'}{i < deaths.length - 1 ? ', ' : ''}</span>)
          : '—'}
      </div>
      {(f.calls || []).length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {f.calls.map((c, i) => {
            const v = VERDICT[c.verdict];
            return (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'baseline' }}>
                <span style={{ ...muted, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{mmss(c.atGame)}</span>
                <span style={{ flexShrink: 0, color: 'var(--text-2)' }}>{c.speaker}:</span>
                <span style={{ minWidth: 0 }}>{c.text}</span>
                {v && <span style={{ flexShrink: 0, color: v.color, fontWeight: 600 }}>{v.mark}{c.note ? ` ${c.note}` : ''}</span>}
              </div>
            );
          })}
        </div>
      ) : <div style={muted}>No callouts in this fight.</div>}
      {(f.missed || []).length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {f.missed.map((m, i) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--error)' }}>
              ✕ missed: {m.what}
              {m.shouldSay ? <span style={{ color: 'var(--text-2)' }}> — should’ve: “{m.shouldSay}”</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TeamfightCommsView({ sidecarPath, accent, onClose }) {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.getRawFileMeta(sidecarPath, 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        let raw;
        try { raw = JSON.parse(r.content); } catch { setState({ status: 'parse-error' }); return; }
        setState({ status: 'ready', report: raw });
      })
      .catch(() => { if (!cancelled) setState({ status: 'missing' }); });
    return () => { cancelled = true; };
  }, [sidecarPath]);

  const { status, report } = state;
  const fights = (report && report.fights) || [];
  const s = (report && report.summary) || {};

  return (
    <AppWindow open onClose={onClose} title="Teamfight Comms Review" accent={accent} icon={<IconTable size={18} />}
      width="min(860px, 92vw)" height="min(720px, 88vh)"
      bodyStyle={{ padding: '20px 24px', overflowY: 'auto' }}>
      {status === 'loading' && <div style={muted}>Loading review…</div>}
      {status === 'missing' && <div style={muted}>No review yet — click Review Comms on the match first.</div>}
      {status === 'parse-error' && <div style={{ color: 'var(--error)', fontSize: 13 }}>Couldn’t parse the stored review.</div>}
      {status === 'ready' && (fights.length ? (
        <>
          <div style={{ ...muted, marginBottom: 14 }}>
            {fights.length} teamfight{fights.length === 1 ? '' : 's'}
            {s.jumbledShare != null && ` · ${Math.round(s.jumbledShare * 100)}% jumbled`}
            {s.missedPerFight != null && ` · ${s.missedPerFight} missed/fight`}
          </div>
          {fights.map((f) => <Fight key={f.id} f={f} />)}
        </>
      ) : <div style={muted}>No teamfights detected (needs 2+ deaths clustered in time).</div>)}
    </AppWindow>
  );
}

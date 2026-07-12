// VodReportView — the VOD Review Report popup (Deadlock Scrim Coaching, sub-plan 11). Mirrors
// MatchViewPopup's chrome exactly: AppWindow + a left rail of text-only candy-btn rows + a content
// pane, only the active section shown. Reads the .vodreport sidecar (the report object is the source
// of truth), renders each section, and persists the coach's done/pending checkbox toggles straight
// back to the sidecar (app-owned, single-writer → null-mtime overwrite). Degrades: missing sidecar →
// "generate first" prompt; bad JSON → error. New component approved 2026-07-09 (reuses AppWindow +
// candy-btn + native checkboxes — no new primitive).

import { useEffect, useState } from 'react';
import { api, invoke } from '@host/api.js';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { candyGap } from '@host/util/candy.js';
import { IconTable, IconFolder } from '@host/components/icons.jsx';
import { parseSegments } from './commsCompile.js';
import { speakerColor } from './diarize.js';

const muted = { color: 'var(--text-muted)', fontSize: 13 };

// Milliseconds → m:ss (raw-segment timestamp). "0:00" for missing/NaN. Mirrors CommsTranscriptView.
function mmss(ms) {
  const v = Number.isFinite(Number(ms)) ? Math.max(0, Math.floor(Number(ms) / 1000)) : 0;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

function RailButton({ active, accent, onClick, children }) {
  return (
    <button type="button" onClick={onClick} data-own-press
      className={`candy-btn${active ? ' is-active' : ''}`} data-shape="row"
      style={accent ? { '--accent': accent } : undefined}>
      <span className="candy-face"><span style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>{children}</span></span>
    </button>
  );
}

// Small muted m:ss label. ponytail: display-only — no video seek (no seek IPC exists); the coach
// scrubs the recording manually. Wire a jump when a player/seek command lands.
function TimeChip({ t }) {
  if (!t) return null;
  return <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', background: 'var(--surface-2)', borderRadius: 4, padding: '1px 5px', marginRight: 4 }}>{t}</span>;
}

function Empty({ children }) { return <div style={muted}>{children}</div>; }

export default function VodReportView({ sidecarPath, commsPath, mdPath, accent, onClose }) {
  const [state, setState] = useState({ status: 'loading' });
  const [report, setReport] = useState(null);
  const [segments, setSegments] = useState(null); // null = loading, [] = none/unavailable
  const [tab, setTab] = useState('tldr');

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.getRawFileMeta(sidecarPath, 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        let raw;
        try { raw = JSON.parse(r.content); } catch { setState({ status: 'parse-error' }); return; }
        setReport(raw);
        setState({ status: 'ready' });
      })
      .catch(() => { if (!cancelled) setState({ status: 'missing' }); });
    return () => { cancelled = true; };
  }, [sidecarPath]);

  // Raw diarized segments the report was built from (.vodcomms sidecar) — read-only here;
  // relabeling lives in ScrimViewer's CommsTranscriptView. Missing/bad → [] (degrades to a gap).
  useEffect(() => {
    if (!commsPath) { setSegments([]); return; }
    let cancelled = false;
    setSegments(null);
    api.getRawFileMeta(commsPath, 'gamewiki')
      .then((r) => { if (!cancelled) setSegments(parseSegments(r.content)); })
      .catch(() => { if (!cancelled) setSegments([]); });
    return () => { cancelled = true; };
  }, [commsPath]);

  const toggleItem = async (id) => {
    if (!report) return;
    const next = { ...report, actionItems: (report.actionItems || []).map((it) => it.id === id ? { ...it, status: it.status === 'done' ? 'pending' : 'done' } : it) };
    setReport(next); // optimistic
    try { await api.savePage(sidecarPath, JSON.stringify(next), null, 'gamewiki'); } catch { /* keep UI state; a failed write just isn't persisted */ }
  };

  const { status } = state;
  const r = report || {};
  const followUps = r.followUps || [];
  const TABS = [
    { id: 'tldr', label: 'TL;DR' },
    { id: 'actions', label: `Action Items${(r.actionItems || []).length ? ` (${r.actionItems.length})` : ''}` },
    { id: 'qa', label: `Q&A${(r.qa || []).length ? ` (${r.qa.length})` : ''}` },
    { id: 'keep', label: 'Keep Doing' },
    { id: 'debates', label: 'Debates' },
    ...(followUps.length ? [{ id: 'followups', label: `Follow-ups (${followUps.length})` }] : []),
    { id: 'segments', label: `Segments${(segments || []).length ? ` (${segments.length})` : ''}` },
  ];

  return (
    <AppWindow open onClose={onClose} title="VOD Review Report" accent={accent} icon={<IconTable size={18} />}
      width="min(920px, 92vw)" height="min(720px, 88vh)"
      bodyStyle={{ padding: 0, overflowY: 'hidden', display: 'flex' }}>
      {/* Left rail */}
      <div style={{ width: 186, flexShrink: 0, padding: '14px 10px', borderRight: '1px solid var(--border)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: candyGap(8), overflowY: 'auto', overflowX: 'hidden' }}>
        {TABS.map((t) => (
          <RailButton key={t.id} active={t.id === tab} accent={accent} onClick={() => setTab(t.id)}>{t.label}</RailButton>
        ))}
        {mdPath && (
          <button type="button" data-own-press className="candy-btn" data-shape="icon"
            title="Show scrim file in folder" style={{ marginTop: 'auto', alignSelf: 'flex-start', '--accent': accent }}
            onClick={() => invoke('coaching_reveal_path', { path: mdPath }).catch((e) => console.error('coaching_reveal_path failed:', e))}>
            <span className="candy-face"><IconFolder size={16} /></span>
          </button>
        )}
      </div>

      {/* Content pane */}
      <div style={{ flex: 1, minWidth: 0, padding: '20px 24px', overflowY: 'auto' }}>
        {tab !== 'segments' && status === 'loading' && <Empty>Loading report…</Empty>}
        {tab !== 'segments' && status === 'missing' && <Empty>No report yet — click Generate Report on the scrim first.</Empty>}
        {tab !== 'segments' && status === 'parse-error' && <div style={{ color: 'var(--error)', fontSize: 13 }}>Couldn’t parse the stored report.</div>}
        {tab === 'segments' && (
          segments === null ? <Empty>Loading segments…</Empty>
            : segments.length === 0 ? <Empty>Transcript unavailable — re-run Extract VOD Comms on the scrim.</Empty>
            : (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.55 }}>
                {segments.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 3, alignItems: 'baseline' }}>
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{mmss(s.t0Ms)}</span>
                    <span style={{ flexShrink: 0, minWidth: 64, fontWeight: 600, color: speakerColor(s.speaker) }}>{s.speaker || '—'}</span>
                    <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{s.text || '·'}</span>
                  </div>
                ))}
              </div>
            )
        )}
        {status === 'ready' && (
          <>
            {tab === 'tldr' && (r.tldr ? <div style={{ fontSize: 14, lineHeight: 1.6 }}>{r.tldr}</div> : <Empty>No summary.</Empty>)}

            {tab === 'actions' && ((r.actionItems || []).length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {r.actionItems.map((it) => (
                  <label key={it.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input type="checkbox" checked={it.status === 'done'} onChange={() => toggleItem(it.id)} style={{ marginTop: 3, flexShrink: 0 }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 13.5, color: it.status === 'done' ? 'var(--text-muted)' : 'var(--text)', textDecoration: it.status === 'done' ? 'line-through' : 'none' }}>
                        {it.text}
                        {it.count > 1 && <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 6 }}>×{it.count}</span>}
                        {it.player && <span style={{ fontSize: 11.5, color: 'var(--accent)', marginLeft: 6 }}>@{it.player}</span>}
                      </span>
                      {(it.timestamps || []).length > 0 && <span style={{ display: 'block', marginTop: 3 }}>{it.timestamps.map((t, i) => <TimeChip key={i} t={t} />)}</span>}
                    </span>
                  </label>
                ))}
              </div>
            ) : <Empty>No action items.</Empty>)}

            {tab === 'qa' && ((r.qa || []).length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {r.qa.map((x, i) => (
                  <div key={i}>
                    <div style={{ fontSize: 13.5 }}><TimeChip t={x.t} /><b>{x.askedBy || 'Q'}:</b> {x.q}</div>
                    <div style={{ fontSize: 13.5, color: 'var(--text-2)', marginTop: 3, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>{x.a}</div>
                  </div>
                ))}
              </div>
            ) : <Empty>No questions raised.</Empty>)}

            {tab === 'keep' && ((r.keepDoing || []).length ? (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>{r.keepDoing.map((x, i) => <li key={i}>{x}</li>)}</ul>
            ) : <Empty>Nothing flagged.</Empty>)}

            {tab === 'debates' && ((r.debates || []).length ? (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>{r.debates.map((x, i) => <li key={i}>{x}</li>)}</ul>
            ) : <Empty>No unresolved debates.</Empty>)}

            {tab === 'followups' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {followUps.map((f, i) => (
                  <div key={i} style={{ fontSize: 13.5 }}>
                    <span style={{ color: f.verdict === 'resolved' ? 'var(--ok, #4caf50)' : f.verdict === 'persisting' ? 'var(--error)' : 'var(--text-muted)', fontWeight: 600, marginRight: 6 }}>{f.verdict}</span>
                    {f.priorItem}
                    {f.evidence && <div style={{ color: 'var(--text-muted)', marginTop: 2, paddingLeft: 10 }}>{f.evidence}</div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </AppWindow>
  );
}

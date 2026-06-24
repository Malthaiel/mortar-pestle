// CommsTranscriptView — renders a match's extracted voice-comms transcript inline in the
// ScrimViewer, read from the .commstranscript.… sidecar (the segments source of truth, written
// by Extract Comms). Mirrors MatchViewPopup's sidecar-read machinery (getRawFileMeta → parse →
// loading / missing / parse-error states) but renders inline + collapsible rather than as a
// popup. Keyed on the ### Comms Transcript body in ScrimViewer, so a re-extract remounts it and
// it re-reads the fresh sidecar (reload-survival: the sidecar is the durable source).

import { useEffect, useState } from 'react';
import { api } from '@host/api.js';
import { parseSegments } from './commsCompile.js';

const muted = { color: 'var(--text-muted)', fontSize: 12 };

// Milliseconds → m:ss (per-segment timestamp). "0:00" for missing/NaN.
function mmss(ms) {
  const v = Number.isFinite(Number(ms)) ? Math.max(0, Math.floor(Number(ms) / 1000)) : 0;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

export default function CommsTranscriptView({ sidecarPath }) {
  const [state, setState] = useState({ status: 'loading' });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.getRawFileMeta(sidecarPath, 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        try { JSON.parse(r.content); } catch { setState({ status: 'parse-error' }); return; }
        setState({ status: 'ready', segs: parseSegments(r.content) });
      })
      .catch(() => { if (!cancelled) setState({ status: 'missing' }); });
    return () => { cancelled = true; };
  }, [sidecarPath]);

  const { status, segs } = state;
  if (status === 'loading') return <div style={{ ...muted, marginTop: 4 }}>Loading transcript…</div>;
  if (status === 'missing') return <div style={{ ...muted, marginTop: 4 }}>Transcript file unavailable — re-run Extract Comms.</div>;
  if (status === 'parse-error') return <div style={{ color: 'var(--error)', fontSize: 12, marginTop: 4 }}>Couldn’t parse the stored transcript.</div>;
  if (!segs || !segs.length) return <div style={{ ...muted, marginTop: 4 }}>Transcript is empty.</div>;

  const durationMs = segs[segs.length - 1].t1Ms || 0;
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" className="candy-btn" data-shape="chip"
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Collapse transcript' : 'Expand transcript'}>
        <span className="candy-face">{open ? '▾' : '▸'} {segs.length} segment{segs.length === 1 ? '' : 's'} · {mmss(durationMs)}</span>
      </button>
      {open && (
        <div style={{
          marginTop: 8, maxHeight: 320, overflowY: 'auto',
          border: '1px solid color-mix(in oklch, var(--text) 12%, transparent)',
          borderRadius: 8, padding: '8px 10px',
          fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.55,
        }}>
          {segs.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{mmss(s.t0Ms)}</span>
              <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{s.text || '·'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

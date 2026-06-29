// Dev Server control panel — Start/Stop/Restart/Status for the `mortar-pestle-dev`
// systemd *user* service (the `cargo tauri dev` surface), with a Vite health
// probe. Unlike the rest of the Dev tab this panel is built into the production
// RPM (VITE_DEV_TOOLS gate in SettingsDrawer) so the stable build can revive a
// dead dev window — you can't click a restart button inside a crashed window.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PrimaryBtn, OutlinedBtn } from '../ui/index.js';
import { invoke } from '../../api.js';

const mono = { fontFamily: 'var(--font-mono)', fontSize: 11 };

const BUSY_LABEL = {
  restart: 'Restarting…', start: 'Starting…', stop: 'Stopping…', status: 'Checking…',
};

function SectionLabel({ children, style }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
      textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
      margin: '0 0 10px', ...style,
    }}>{children}</div>
  );
}

// Mirror api.js's toast channel: failures escalate to a notification.
function emitErrorToast(message) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('agentic:notify', {
    detail: { type: 'note-error', title: 'Dev server', message: String(message || ''), accent: 'var(--error)', iconKey: 'alert', duration: 5000 },
  }));
}

export default function DevServerPanel({ accent }) {
  const [busy, setBusy] = useState(null);     // verb in flight, or null
  const [result, setResult] = useState(null); // last DevServiceResult
  const aliveRef = useRef(true);
  // Set true on (re)mount, not just at declaration: React 18 StrictMode's dev
  // mount → unmount → remount fires the cleanup (false) and an empty-body effect
  // never restores it, stranding the ref false and silently dropping guarded writes.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const run = useCallback(async (action) => {
    setBusy(action);
    try {
      const r = await invoke('dev_service_action', { action });
      if (!aliveRef.current) return;
      setResult(r);
      if (r?.error) emitErrorToast(r.error);
    } catch (e) {
      if (!aliveRef.current) return;
      const msg = e?.message || String(e);
      setResult({ action, error: msg, serving: false });
      emitErrorToast(msg);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  }, []);

  // Non-destructive status read on mount so the line isn't blank.
  useEffect(() => { run('status'); }, [run]);

  return (
    <div style={{ maxWidth: 680 }}>
      <SectionLabel style={{ marginTop: 0 }}>Dev Server</SectionLabel>
      <div style={{ ...mono, color: 'var(--text-muted)', marginBottom: 12 }}>
        mortar-pestle-dev.service · cargo tauri dev → localhost:5173
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
        <PrimaryBtn accent={accent} onClick={() => run('restart')} disabled={!!busy}>
          ⟳ Restart dev server
        </PrimaryBtn>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <OutlinedBtn small onClick={() => run('start')}  disabled={!!busy}>▶ Start</OutlinedBtn>
          <OutlinedBtn small onClick={() => run('stop')}   disabled={!!busy}>■ Stop</OutlinedBtn>
          <OutlinedBtn small onClick={() => run('status')} disabled={!!busy}>↻ Status</OutlinedBtn>
        </div>
      </div>

      <div style={{ ...mono, marginTop: 14, lineHeight: 1.6, minHeight: 16 }}>
        <StatusLine busy={busy} result={result} />
      </div>
    </div>
  );
}

function StatusLine({ busy, result }) {
  if (busy) {
    return <span style={{ color: 'var(--text-muted)' }}>⟳ {BUSY_LABEL[busy] || 'Working…'}</span>;
  }
  if (!result) return <span style={{ color: 'var(--text-faint)' }}>—</span>;
  if (result.error) {
    return <span style={{ color: 'var(--error)' }} title={result.error}>✕ {result.error}</span>;
  }

  const { serving, active, httpStatus: code, elapsedMs } = result;
  let dot, text;
  if (serving) { dot = '#4fc878'; text = `serving — HTTP ${code}`; }
  else if (active === false) { dot = '#8a8a8a'; text = 'stopped'; }
  else if (active) { dot = '#e6a24f'; text = code ? `active — HTTP ${code}` : 'active — not serving'; }
  else { dot = '#e6a24f'; text = code ? `HTTP ${code}` : 'not serving'; }
  const secs = typeof elapsedMs === 'number' ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : '';

  return (
    <span style={{ color: 'var(--text-muted)' }}>
      <span style={{ color: dot, fontWeight: 700 }}>●</span> {text}
      <span style={{ color: 'var(--text-faint)' }}> · localhost:5173{secs}</span>
    </span>
  );
}

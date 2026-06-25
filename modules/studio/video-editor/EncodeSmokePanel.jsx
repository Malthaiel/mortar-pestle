// EncodeSmokePanel — Delivery & Presets SF9 (DEV). Runs vedit_encode_smoke,
// which exercises the REAL resolve_export_encoder + video/audio_encode_args
// against a 1 s synthetic source per built-in codec family and ffprobes the
// result. Confirms the export encode matrix end-to-end on THIS machine — the
// listing lies, so only probe-available encoders are exercised (a family with
// no working encoder shows "—", not a failure).

import { useState } from 'react';
import AppWindow from '@host/components/ui/AppWindow.jsx';
import { PrimaryBtn } from '@host/components/ui/Button.jsx';
import { IconClapperboard } from '@host/components/icons.jsx';

const mono = { fontFamily: '"DM Mono", monospace' };

export default function EncodeSmokePanel({ onClose, api, accent }) {
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');

  const run = async () => {
    setRunning(true);
    setRows([]);
    setStatus('encoding…');
    try {
      const res = (await api.invoke('vedit_encode_smoke', {})) || [];
      setRows(res);
      const tested = res.filter((r) => r.encoder);
      const pass = tested.length > 0 && tested.every((r) => r.ok);
      setStatus(`${tested.filter((r) => r.ok).length}/${tested.length} available codecs OK${pass ? '' : ' — FAIL'}`);
      console.info('[vedit-encode-smoke]\n' + res.map((r) => `${r.codec}: ${r.ok ? 'OK' : 'FAIL'} ${r.detail}`).join('\n'));
    } catch (e) {
      setStatus(`failed: ${e?.message || e}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <AppWindow open onClose={onClose} title="Encode Smoke Battery" icon={<IconClapperboard />} accent={accent} width={520} height="auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PrimaryBtn small accent={accent} onClick={run} disabled={running}>Run battery</PrimaryBtn>
          <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-faint)' }}>{status}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((r) => (
            <div key={r.codec} style={{ ...mono, fontSize: 11.5, display: 'flex', gap: 8, alignItems: 'center', color: r.encoder ? (r.ok ? 'var(--text)' : 'var(--error)') : 'var(--text-faint)' }}>
              <span style={{ minWidth: 48 }}>{r.codec}</span>
              <span style={{ minWidth: 14 }}>{!r.encoder ? '—' : r.ok ? '✓' : '✗'}</span>
              <span style={{ flex: 1 }}>{r.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </AppWindow>
  );
}

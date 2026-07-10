// SP4 remux utility — one AppWindow (no new primitive): pick a recording (recent
// clips or Browse), remux to a sibling .mp4 with -c copy (every track kept) via
// the broadcast_remux_start host command, which reuses S4's build_remux_argv +
// .partial rename. Parent (BroadcastSettingsTab) owns the open flag.

import React, { useEffect, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { AppWindow } from '@host/components/ui';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';

const baseName = (p) => (p ? p.split(/[\\/]/).pop() : '');
const toMp4 = (p) => {
  if (!p) return '';
  const out = p.replace(/\.[^.\\/]+$/, '.mp4');
  return out === p ? p.replace(/\.[^.\\/]+$/, ' (remux).mp4') : out;
};

export default function RemuxWindow({ api, accent, onClose }) {
  const [clips, setClips] = useState([]);
  const [input, setInput] = useState('');
  const [state, setState] = useState('idle'); // idle | running | done | error
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.invoke('capture_list_clips').then((list) => setClips(Array.isArray(list) ? list : [])).catch(() => setClips([]));
  }, [api]);

  const browse = async () => {
    const picked = await openDialog({
      multiple: false, title: 'Choose a recording to remux',
      filters: [{ name: 'Video', extensions: ['mkv', 'flv', 'mov', 'mp4', 'ts', 'm2ts', 'webm', 'avi'] }],
    });
    const p = Array.isArray(picked) ? picked[0] : picked;
    if (typeof p === 'string') setInput(p);
    else if (p?.path) setInput(p.path);
  };

  const output = useMemo(() => toMp4(input), [input]);
  const run = () => {
    if (!input || state === 'running') return;
    setState('running'); setMessage('');
    api.invoke('broadcast_remux_start', { input, output })
      .then(() => { setState('done'); setMessage('Done — saved ' + baseName(output)); })
      .catch((e) => { setState('error'); setMessage((e && e.message) || String(e) || 'Remux failed'); });
  };

  const clipOpts = clips.map((c) => ({ value: c.path, label: c.name }));

  return (
    <AppWindow
      open title="Remux to MP4" accent={accent} onClose={onClose} width={560}
      footer={<PrimaryBtn onClick={run} accent={accent} disabled={!input || state === 'running'}>{state === 'running' ? 'Remuxing…' : 'Remux'}</PrimaryBtn>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Rewrap a recording as MP4 without re-encoding — fast, lossless, keeps every audio track.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <CandySelect value={input} options={clipOpts} onChange={setInput} placeholder={clipOpts.length ? 'Recent recordings…' : 'No recordings yet'} title="Recent recordings" />
          </div>
          <OutlinedBtn small onClick={browse} title="Pick any video file">Browse…</OutlinedBtn>
        </div>
        {input && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>→ {baseName(output)}</div>
        )}
        {message && (
          <div style={{ fontSize: 12, color: state === 'error' ? 'var(--error)' : 'var(--text-muted)' }}>{message}</div>
        )}
      </div>
    </AppWindow>
  );
}

// Broadcast settings tab (SP2) — single flat Engine section: live status
// chips, Restart engine, Open log, collection-path readout. Self-sufficient
// like CaptureSettingsTab: settings tabs receive {settings, setSetting,
// accent} (no `api`), so this talks to the backend directly via invoke/listen.

import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { OutlinedBtn } from '@host/components/ui/Button.jsx';
import { StatChip } from '@host/components/ui';

export default function BroadcastSettingsTab({ accent }) {
  // EngineStatus (camelCase) — 'unknown' until the first event: the
  // supervisor's boot emit predates UI load (capture-mirror gap).
  const [engine, setEngine] = useState(null);
  const [paths, setPaths] = useState(null);

  useEffect(() => {
    const sub = listen('broadcast-engine-status', (e) => { if (e.payload) setEngine(e.payload); });
    invoke('broadcast_paths').then(setPaths).catch(() => {});
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, []);

  const lastExit = engine?.lastExitCode;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 2px' }}>
      <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        Engine
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <StatChip label="state" value={engine?.state || 'unknown'} />
        <StatChip label="restarts" value={engine ? String(engine.restartCount) : '—'} />
        <StatChip label="last exit" value={lastExit == null ? '—' : String(lastExit)} />
      </div>
      {engine?.message && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{engine.message}</div>
      )}
      <div className="candy-chip-row" style={{ display: 'flex', gap: 10 }}>
        <OutlinedBtn small onClick={() => invoke('broadcast_restart_engine').catch(() => {})} title="Kill and respawn the Broadcast engine (also revives a crash-looped one)">
          Restart engine
        </OutlinedBtn>
        <OutlinedBtn small onClick={() => invoke('broadcast_open_log').catch(() => {})} title="Open mortar-pestle-broadcast.log">
          Open log file
        </OutlinedBtn>
      </div>
      {paths?.collectionPath && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
          Scene collection: {paths.collectionPath}
        </div>
      )}
    </div>
  );
}

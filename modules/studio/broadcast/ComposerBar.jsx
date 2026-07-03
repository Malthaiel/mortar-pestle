// Composer bar (SP2 SF5) — the fixed bottom transport skeleton, per DESIGN
// § Composer surfaces: one row of candy controls; the pane scrolls, the bar
// doesn't. Record is live (SP1 verbs); Replay + GO LIVE are visible-disabled
// placeholders whose titles name the sub-plan that lights them up (locked
// decision — limitations stay user-visible, never hidden).

import React, { useEffect, useState } from 'react';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { StatChip } from '@host/components/ui';

function formatUptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export default function ComposerBar({ alive, recording, elapsedNs, busy, onToggleRecord, lastError, accent }) {
  // Uptime ticks locally while recording: the engine pushes state on
  // mutations, not per-second — anchor wall-clock to the snapshot's elapsed.
  const [now, setNow] = useState(() => Date.now());
  const [anchor, setAnchor] = useState(null); // Date.now() at recording start
  useEffect(() => {
    if (!recording) { setAnchor(null); return undefined; }
    setAnchor(Date.now() - elapsedNs / 1e6);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
    // Re-anchor only on the recording edge — elapsedNs updates ride snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const uptime = recording && anchor != null ? formatUptime(now - anchor) : '—';

  return (
    <div className="bcast-controlbar">
      <PrimaryBtn onClick={onToggleRecord} disabled={!alive || busy} accent={accent} title="Toggle recording (rebindable in Settings ▸ Keybinds)">
        {recording ? 'Stop' : 'Record'}
      </PrimaryBtn>
      <StatChip label="uptime" value={uptime} />
      <div style={{ flex: 1 }} />
      {lastError?.message && (
        <span className="bcast-lasterror" title={lastError.code || ''}>{lastError.message}</span>
      )}
      <OutlinedBtn disabled title="Replay Buffer — enabled in Broadcast SP4 (Recording & Replay)">Replay</OutlinedBtn>
      <OutlinedBtn disabled title="Streaming — enabled in Broadcast SP5 (Streaming)">GO LIVE</OutlinedBtn>
    </div>
  );
}

// Composer bar (SP2 skeleton, SP4 transport) — the fixed bottom row of candy
// controls; the pane scrolls, the bar doesn't (per DESIGN § Composer surfaces).
// Record/Pause/Split + Replay Arm/Save are live (SP4 verbs via the page's
// broadcast_request passthrough); GO LIVE stays a visible-disabled placeholder
// whose title names the sub-plan that lights it up (locked decision —
// limitations stay user-visible, never hidden). Pure presentational: every bit
// of engine state + every handler arrives as a prop from BroadcastPage.

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

export default function ComposerBar({
  alive, recording, paused, elapsedNs, busy, onToggleRecord,
  armed, canSplit, onPause, onSplit, onReplayArm, onReplaySave,
  lastError, accent,
}) {
  // Uptime ticks locally while recording: the engine pushes state on mutations,
  // not per-second — anchor wall-clock to the snapshot's (pause-adjusted)
  // elapsed. Re-anchor on the recording AND paused edges: while paused the
  // engine freezes elapsed_ns, so we snap `now` once and stop ticking (the chip
  // holds at the pause instant); on resume we re-anchor to the advanced elapsed
  // and resume ticking. Both sides must change or the chip lies.
  const [now, setNow] = useState(() => Date.now());
  const [anchor, setAnchor] = useState(null); // Date.now() - elapsed at (re)anchor
  useEffect(() => {
    if (!recording) { setAnchor(null); return undefined; }
    const nowMs = Date.now();
    setAnchor(nowMs - elapsedNs / 1e6);
    setNow(nowMs);
    if (paused) return undefined;              // frozen at the exact pause elapsed
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, paused]);

  const uptime = recording && anchor != null ? formatUptime(now - anchor) : '—';

  return (
    <div className="bcast-controlbar">
      <PrimaryBtn onClick={onToggleRecord} disabled={!alive || busy} accent={accent} title="Toggle recording (Meta+Shift+B; rebindable in Settings ▸ Keybinds)">
        {recording ? 'Stop' : 'Record'}
      </PrimaryBtn>
      {recording && (
        <OutlinedBtn onClick={onPause} disabled={!alive} title={paused ? 'Resume recording (Meta+Shift+P)' : 'Pause recording (Meta+Shift+P)'}>
          {paused ? 'Resume' : 'Pause'}
        </OutlinedBtn>
      )}
      {canSplit && (
        <OutlinedBtn onClick={onSplit} disabled={!alive || paused} title="Split into a new file now (Meta+Shift+X)">
          Split
        </OutlinedBtn>
      )}
      <StatChip label="uptime" value={uptime} />
      <div style={{ flex: 1 }} />
      {lastError?.message && (
        <span className="bcast-lasterror" title={lastError.code || ''}>{lastError.message}</span>
      )}
      <OutlinedBtn onClick={onReplayArm} disabled={!alive} title={armed ? 'Disarm the replay buffer' : 'Arm the replay buffer — keeps a rolling window you can save at any time'}>
        {armed ? 'Disarm' : 'Arm Replay'}
      </OutlinedBtn>
      <OutlinedBtn onClick={onReplaySave} disabled={!alive || !armed} title="Save the last N seconds from the replay buffer (Meta+Shift+S)">
        Save
      </OutlinedBtn>
      <OutlinedBtn disabled title="Streaming — enabled in Broadcast SP5 (Streaming)">GO LIVE</OutlinedBtn>
    </div>
  );
}

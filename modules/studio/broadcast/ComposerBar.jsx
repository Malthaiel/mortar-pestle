// Composer bar (SP2 skeleton, SP4 transport, SP5 go-live) — the fixed bottom
// row of candy controls; the pane scrolls, the bar doesn't (per DESIGN §
// Composer surfaces). Record/Pause/Split, Replay Arm/Save and GO LIVE are all
// live verbs via the page's broadcast_request passthrough. Pure presentational:
// every bit of engine state + every handler arrives as a prop from
// BroadcastPage.

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

// Uptime ticks locally: the engine pushes state on mutations, not per-second —
// anchor wall-clock to the snapshot's elapsed. Re-anchor on the active AND
// frozen edges: recording freezes elapsed_ns while paused, so we snap `now`
// once and stop ticking (the chip holds at the pause instant); on resume we
// re-anchor to the advanced elapsed and tick again. Both sides must change or
// the chip lies. Streaming passes frozen=false — it has no pause, and a
// reconnect deliberately keeps counting.
function useUptime(active, elapsedNs, frozen) {
  const [now, setNow] = useState(() => Date.now());
  const [anchor, setAnchor] = useState(null); // Date.now() - elapsed at (re)anchor
  useEffect(() => {
    if (!active) { setAnchor(null); return undefined; }
    const nowMs = Date.now();
    setAnchor(nowMs - elapsedNs / 1e6);
    setNow(nowMs);
    if (frozen) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, frozen]);
  return active && anchor != null ? formatUptime(now - anchor) : '—';
}

// status → [button label, whether the click is disabled]. `idle` and `error`
// both offer another go; `stopping` is the one state with nothing to click.
const STREAM_LABEL = {
  idle: 'GO LIVE',
  error: 'GO LIVE',
  connecting: 'Connecting',
  live: 'END STREAM',
  reconnecting: 'Reconnecting',
  stopping: 'Stopping',
};

export default function ComposerBar({
  alive, recording, paused, elapsedNs, busy, onToggleRecord,
  armed, canSplit, onPause, onSplit, onReplayArm, onReplaySave,
  streamStatus, streamElapsedNs, streamError, streamStats, onGoLive,
  confirmStream, onConfirmStream, onCancelStream,
  lastError, accent,
}) {
  const uptime = useUptime(recording, elapsedNs, paused);
  const streaming = streamStatus === 'live' || streamStatus === 'reconnecting';
  const streamUptime = useUptime(streaming, streamElapsedNs, false);

  const total = streamStats?.total_frames || 0;
  const dropped = streamStats?.frames_dropped || 0;
  const dropPct = total ? (dropped / total) * 100 : 0;
  const congestion = streamStats?.congestion || 0;

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
      {/* The OBS status bar, one for one: live time, bitrate, dropped-frame %,
          connection quality. OBS keeps the deep table in a separate Stats dock,
          never floating over the preview — and here it CAN'T float over it (the
          native preview child occludes all DOM), so no popover. Congestion is a
          number, not OBS's coloured square: DESIGN bans red/green status colour. */}
      {streaming && (
        <>
          <StatChip label="live" value={streamUptime} />
          <StatChip label="kbps" value={streamStats?.kbps ?? '—'} />
          <StatChip label="drops" value={`${dropped} (${dropPct.toFixed(1)}%)`} />
          <StatChip label="congestion" value={`${Math.round(congestion * 100)}%`} />
        </>
      )}
      <div style={{ flex: 1 }} />
      {streamStatus === 'error' && streamError && (
        <span className="bcast-lasterror" title="Stream">{streamError}</span>
      )}
      {lastError?.message && (
        <span className="bcast-lasterror" title={lastError.code || ''}>{lastError.message}</span>
      )}
      <OutlinedBtn onClick={onReplayArm} disabled={!alive} title={armed ? 'Disarm the replay buffer' : 'Arm the replay buffer — keeps a rolling window you can save at any time'}>
        {armed ? 'Disarm' : 'Arm Replay'}
      </OutlinedBtn>
      <OutlinedBtn onClick={onReplaySave} disabled={!alive || !armed} title="Save the last N seconds from the replay buffer (Meta+Shift+S)">
        Save
      </OutlinedBtn>
      {/* The confirm lives INSIDE the bar, not in a floating modal: the preview
          is a native child window that occludes every DOM overlay (same reason
          the Inspector is a flex sibling). A centered ConfirmModal renders
          behind it — observed, not theorised. */}
      {confirmStream ? (
        <>
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {confirmStream.stopping
              ? 'End the stream? Everyone watching gets cut off.'
              : `Go live to ${confirmStream.service}?`}
          </span>
          <OutlinedBtn onClick={onConfirmStream}>
            {confirmStream.stopping ? 'End stream' : 'Go live'}
          </OutlinedBtn>
          <OutlinedBtn onClick={onCancelStream}>Cancel</OutlinedBtn>
        </>
      ) : (
        <OutlinedBtn
          onClick={onGoLive}
          disabled={!alive || streamStatus === 'stopping'}
          title={streaming ? 'End the stream' : 'Start streaming to your configured service (Settings ▸ Broadcast ▸ Stream)'}
        >
          {STREAM_LABEL[streamStatus] || 'GO LIVE'}
        </OutlinedBtn>
      )}
    </div>
  );
}

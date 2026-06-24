// Transport island (Projection Booth direction, SF5 creative checkpoint):
// a floating candy island under the video — frame-step chevrons flanking a
// big primary play/pause, DM Mono timecode (20 px) left of a faint frame
// counter. The groove scrub rail lives above the island in PreviewPlayer and
// BLOOMS 2px→6px on hover/scrub. SF9 adds (sequence mode only): the 1×/2×/4×
// forward-rate chip and the master-volume slider — volume commits on release
// so each adjustment is ONE undo entry.

import { useState } from 'react';
import { IconBtn } from '@host/components/ui/Button.jsx';
import { IconPlay, IconPause, IconChevronLeft, IconChevronRight } from '@host/components/icons.jsx';
import { candyGap } from '@host/util/candy.js';

const mono = { fontFamily: '"DM Mono", monospace' };

const chip = {
  ...mono,
  fontSize: 10.5,
  color: 'var(--text-faint)',
  background: 'none',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '2px 6px',
  cursor: 'pointer',
};

export function fmtTimecode(t, fps) {
  const sec = Math.max(0, t || 0);
  const f = fps && fps > 0 ? fps : 30;
  const whole = Math.floor(sec);
  const ff = Math.min(Math.floor((sec - whole) * f), Math.ceil(f) - 1);
  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}·${p2(ff)}`;
}

export default function TransportBar({
  playing,
  time,
  duration,
  fps,
  accent,
  onTogglePlay,
  onStep,            // (dir: -1 | +1)
  benchText,
  onBench,           // dev-only scrub benchmark (source mode; null otherwise)
  seqMode,
  rate,
  onCycleRate,
  masterVolume,
  onMasterVolume,    // (v) commit-on-release — one undo entry per adjustment
  onSwapStats,       // dev-only swap stats (sequence mode; null otherwise)
}) {
  const f = fps && fps > 0 ? fps : 30;
  const frame = Math.floor((time || 0) * f + 1e-6);
  const totalFrames = Math.max(0, Math.round((duration || 0) * f));
  const [volDraft, setVolDraft] = useState(null);
  const vol = volDraft ?? masterVolume ?? 1;
  const commitVol = () => {
    if (volDraft != null) {
      onMasterVolume?.(volDraft);
      setVolDraft(null);
    }
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexWrap: 'wrap',           // dev chips + stats text must never push controls off-pane
        justifyContent: 'center',
        maxWidth: 'calc(100% - 24px)',
        gap: 14,
        // after the `gap` shorthand (which would reset it); wrapped candy
        // rows need depth clearance — the icon shape runs small depth
        rowGap: candyGap(8, true),
        padding: '10px 16px',
        borderRadius: 14,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconBtn size={30} title="Back one frame (←)" onClick={() => onStep(-1)}>
          <IconChevronLeft />
        </IconBtn>
        <IconBtn size={38} primary accent={accent} title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={onTogglePlay}>
          {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
        </IconBtn>
        <IconBtn size={30} title="Forward one frame (→)" onClick={() => onStep(1)}>
          <IconChevronRight />
        </IconBtn>
      </div>
      <div style={{ ...mono, fontSize: 20, color: 'var(--text)', letterSpacing: '0.02em', minWidth: 148, textAlign: 'center' }}>
        {fmtTimecode(time, f)}
      </div>
      <div style={{ ...mono, fontSize: 12, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
        {frame} / {totalFrames}
      </div>
      {seqMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)' }}>SPEED</span>
          <button style={{ ...chip, minWidth: 30, fontSize: 11.5 }} onClick={onCycleRate} title="Playback rate — cycles 1× / 2× / 4× (L)">
            {rate}×
          </button>
        </div>
      )}
      {seqMode && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onPointerUp={commitVol}
          onKeyUp={commitVol}
        >
          <span style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)' }}>VOL</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={vol}
            onChange={(e) => setVolDraft(Number(e.target.value))}
            style={{ width: 90, accentColor: accent }}
          />
          <span style={{ ...mono, fontSize: 11, color: 'var(--text-muted)', width: 38 }}>
            {Math.round(vol * 100)}%
          </span>
        </div>
      )}
      {onBench && (
        <button onClick={onBench} title="Dev: 30-seek scrub benchmark" style={chip}>
          bench
        </button>
      )}
      {onSwapStats && (
        <button onClick={onSwapStats} title="Dev: boundary swap stats since open" style={chip}>
          swaps
        </button>
      )}
      {benchText && (
        <div style={{ ...mono, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{benchText}</div>
      )}
    </div>
  );
}

// Spine: three stacked sideways-rendered sections — top 40x40 album cover
// (closest to the Toolkit button), middle track-info box (rotated track on
// the right, artist on the left via writing-mode: vertical-rl), bottom time
// box (live waveform + cosmetic playback slider between rotated current/
// total time, inner block rotated +90deg so the text reads the same head-
// tilt-right direction as the middle box). Whole tile = tap to toggle play.

import { useEffect, useRef, useState } from 'react';
import { useMusicPlayer } from '../MusicPlayerProvider.jsx';
import { mediaUrl } from '@host/api.js';

const BAR_COUNT = 9;
const FFT_BINS = 32;

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function Spine({ accent }) {
  const {
    currentTrack, isPlaying, position, duration, toggle, getAnalyser,
  } = useMusicPlayer();
  const hasTrack = !!currentTrack;
  const cover = hasTrack ? mediaUrl(currentTrack.albumImage) || null : null;
  const trackName = hasTrack ? (currentTrack.title || '—') : 'No Track';
  const artistName = hasTrack ? (currentTrack.artist || '') : '';
  const pct = (hasTrack && duration > 0)
    ? Math.max(0, Math.min(100, (position / duration) * 100))
    : 0;

  const [bars, setBars] = useState(() => Array.from({ length: BAR_COUNT }, () => 0.18));
  const rafRef = useRef(null);
  const analyserRef = useRef(null);
  const freqBufRef = useRef(null);
  const tRef = useRef(0);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      setBars(Array.from({ length: BAR_COUNT }, () => 0.15));
      return;
    }
    if (!analyserRef.current && getAnalyser) {
      analyserRef.current = getAnalyser();
      if (analyserRef.current) {
        freqBufRef.current = new Uint8Array(analyserRef.current.frequencyBinCount);
      }
    }
    let cancelled = false;
    function tick() {
      if (cancelled) return;
      tRef.current += 1;
      let next;
      const analyser = analyserRef.current;
      const buf = freqBufRef.current;
      if (analyser && buf) {
        analyser.getByteFrequencyData(buf);
        const usable = Math.min(FFT_BINS, buf.length);
        const chunkSize = Math.max(1, Math.floor(usable / BAR_COUNT));
        next = Array.from({ length: BAR_COUNT }, (_, i) => {
          let sum = 0;
          let count = 0;
          for (let j = 0; j < chunkSize; j++) {
            const idx = i * chunkSize + j;
            if (idx < usable) { sum += buf[idx]; count++; }
          }
          const avg = count > 0 ? sum / count : 0;
          return Math.max(0.18, Math.min(1, avg / 255));
        });
      } else {
        const t = tRef.current;
        next = Array.from({ length: BAR_COUNT }, (_, i) => {
          const phase = (i / BAR_COUNT) * Math.PI * 2;
          const base = (Math.sin(t * 0.08 + phase) + 1) / 2;
          const noise = Math.random() * 0.35;
          return Math.max(0.18, Math.min(1, base * 0.65 + noise));
        });
      }
      setBars(next);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying, getAnalyser]);

  const title = hasTrack
    ? (currentTrack.title + (currentTrack.artist ? ' · ' + currentTrack.artist : ''))
    : 'No Track';

  return (
    <button
      type="button"
      onClick={() => hasTrack && toggle()}
      disabled={!hasTrack}
      aria-label={hasTrack ? (isPlaying ? 'Pause' : 'Play') : 'No track'}
      title={title}
      style={{
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 8, padding: '10px 4px',
        background: 'transparent', border: 'none',
        cursor: hasTrack ? 'pointer' : 'default',
        color: 'var(--text)',
        overflow: 'hidden',
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 6,
        overflow: 'hidden', flexShrink: 0,
        background: cover ? 'transparent' : 'var(--surface-2, rgba(255,255,255,0.04))',
        boxShadow: 'inset 0 0 0 1px var(--border)',
      }}>
        {cover && <img src={cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>}
      </div>

      <TrackInfoBox
        trackName={trackName}
        artistName={artistName}
        hasTrack={hasTrack}
      />

      {hasTrack && (
        <TimeBox
          accent={accent}
          bars={bars}
          positionLabel={fmtTime(position)}
          durationLabel={fmtTime(duration)}
          pct={pct}
        />
      )}
    </button>
  );
}

function TimeBox({ accent, bars, positionLabel, durationLabel, pct }) {
  return (
    <div style={{
      flex: '0 0 auto',
      width: 40, height: 132,
      borderRadius: 6,
      background: 'var(--surface-2, rgba(255,255,255,0.04))',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    }}>
      <div style={{
        width: 120, height: 40,
        transform: 'rotate(90deg)',
        transformOrigin: 'center',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, height: 18,
        }}>
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)', letterSpacing: '0.02em',
            flexShrink: 0,
          }}>{positionLabel}</span>
          <div style={{
            flex: 1, height: 14, minWidth: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 2,
          }}>
            {bars.map((h, i) => (
              <div key={i} style={{
                width: 3,
                height: `${Math.max(2, h * 14)}px`,
                minHeight: 2,
                borderRadius: 1,
                background: accent || 'var(--accent)',
                opacity: 0.85,
                transition: 'height 90ms ease, opacity 200ms ease',
              }}/>
            ))}
          </div>
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)', letterSpacing: '0.02em',
            flexShrink: 0,
          }}>{durationLabel}</span>
        </div>
        <div style={{
          width: '100%', height: 4, borderRadius: 2,
          background: 'var(--border)', position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', top: 0, left: 0, bottom: 0,
            width: `${pct}%`,
            background: accent || 'var(--accent)',
            borderRadius: 2,
            transition: 'width 220ms cubic-bezier(0.32, 0.72, 0, 1)',
          }}/>
        </div>
      </div>
    </div>
  );
}

function TrackInfoBox({ trackName, artistName, hasTrack }) {
  return (
    <div style={{
      flex: 1, minHeight: 80,
      width: 40,
      borderRadius: 6,
      background: 'var(--surface-2, rgba(255,255,255,0.04))',
      padding: '8px 4px',
      display: 'flex', flexDirection: 'row-reverse',
      alignItems: 'stretch', justifyContent: 'center',
      gap: 4,
      overflow: 'hidden',
    }}>
      <span style={{
        writingMode: 'vertical-rl',
        textOrientation: 'mixed',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxHeight: '100%',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        lineHeight: 1.15,
        color: hasTrack ? 'var(--text)' : 'var(--text-faint)',
      }}>{trackName}</span>
      {hasTrack && artistName && (
        <span style={{
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxHeight: '100%',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          lineHeight: 1.15,
          color: 'var(--text-muted)',
        }}>{artistName}</span>
      )}
    </div>
  );
}

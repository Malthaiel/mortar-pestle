// Live Waveform: small album swatch at top, vertical animated waveform
// bars filling the pillar. Entire tile = tap to toggle play. Drives the
// bars from the MusicPlayerProvider's shared AnalyserNode when available;
// falls back to a pseudo-envelope (sine + noise) when the AudioContext
// isn't usable (headless test contexts, iframe with no user gesture yet,
// or a browser without WebAudio support).

import { useEffect, useRef, useState } from 'react';
import { useMusicPlayer } from '../MusicPlayerProvider.jsx';
import { mediaUrl } from '@host/api.js';

const BAR_COUNT = 9;
const FFT_BINS = 32; // fftSize/2 with provider's fftSize: 64

export default function LiveWaveform({ accent }) {
  const { currentTrack, isPlaying, toggle, getAnalyser } = useMusicPlayer();
  const hasTrack = !!currentTrack;
  const cover = hasTrack ? mediaUrl(currentTrack.albumImage) || null : null;
  const [bars, setBars] = useState(() => Array.from({ length: BAR_COUNT }, () => 0.2));
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
    // Try to acquire (or reuse) the shared analyser. If unavailable, fall
    // through to pseudo-envelope.
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
        // Reduce FFT_BINS down to BAR_COUNT by chunked-mean across the
        // perceptually-useful lower half (sub-2kHz biases visual intensity
        // toward vocals/percussion which read better at 9 bars).
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
          // Normalize 0..255 → 0.18..1.0 (floor so bars never disappear)
          return Math.max(0.18, Math.min(1, avg / 255));
        });
      } else {
        // Fallback: pseudo-envelope (rAF + sine/noise mix)
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

  const label = hasTrack ? (currentTrack.title || '—') : 'No Track';

  return (
    <button
      type="button"
      onClick={() => hasTrack && toggle()}
      disabled={!hasTrack}
      aria-label={hasTrack ? (isPlaying ? 'Pause' : 'Play') : 'No track'}
      title={label}
      style={{
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 16, padding: '14px 4px',
        background: 'transparent', border: 'none',
        cursor: hasTrack ? 'pointer' : 'default',
        color: 'var(--text)',
        overflow: 'hidden',
      }}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 5,
        overflow: 'hidden', flexShrink: 0,
        background: cover ? 'transparent' : 'var(--surface-2, rgba(255,255,255,0.04))',
        boxShadow: 'inset 0 0 0 1px var(--border)',
      }}>
        {cover && <img src={cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>}
      </div>
      <div style={{
        flex: 1, minHeight: 0, width: '100%',
        display: 'flex', flexDirection: 'column-reverse',
        alignItems: 'center', justifyContent: 'center',
        gap: 2,
        padding: '4px 0',
      }}>
        {bars.map((h, i) => (
          <div key={i} style={{
            width: 18,
            height: `${h * 12}px`,
            minHeight: 2,
            borderRadius: 2,
            background: hasTrack ? accent : 'var(--text-faint)',
            opacity: hasTrack ? 0.85 : 0.4,
            transition: 'height 90ms ease, opacity 200ms ease',
          }}/>
        ))}
      </div>
    </button>
  );
}

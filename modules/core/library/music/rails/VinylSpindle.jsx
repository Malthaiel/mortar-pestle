// Vinyl Spindle: animated mini vinyl disc (spins when playing, freezes on
// pause via animation-play-state). Album art sits in the center spindle.
// Vertical title alongside, play/pause icon at bottom.

import { useMusicPlayer } from '../MusicPlayerProvider.jsx';
import { mediaUrl } from '@host/api.js';

export default function VinylSpindle({ accent }) {
  const { currentTrack, isPlaying, toggle } = useMusicPlayer();
  const hasTrack = !!currentTrack;
  const cover = hasTrack ? mediaUrl(currentTrack.albumImage) || null : null;
  const label = hasTrack
    ? (currentTrack.title + (currentTrack.artist ? ' · ' + currentTrack.artist : ''))
    : 'No Track';

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
      <style>{`
        @keyframes toolkit-vinyl-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      <div style={{
        width: 44, height: 44, borderRadius: '50%',
        position: 'relative', flexShrink: 0,
        overflow: 'hidden',
        background: cover ? 'transparent' : 'radial-gradient(circle at 50% 50%, #2b2b2b 0%, #111 60%, #000 100%)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06), 0 1px 3px rgba(0,0,0,0.3)',
        animation: 'toolkit-vinyl-spin 4s linear infinite',
        animationPlayState: isPlaying ? 'running' : 'paused',
      }}>
        {cover && <img src={cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>}
        <div aria-hidden style={{
          position: 'absolute', top: '50%', left: '50%',
          width: 9, height: 9, marginLeft: -4.5, marginTop: -4.5,
          borderRadius: '50%',
          background: '#000',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.22), inset 0 0 3px rgba(0,0,0,0.9)',
          pointerEvents: 'none',
        }}/>
      </div>
      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', width: '100%',
      }}>
        <span style={{
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          transform: 'translateX(-1px)',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontWeight: 600,
          lineHeight: 1.15,
          color: hasTrack ? 'var(--text-muted)' : 'var(--text-faint)',
          maxHeight: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>{label}</span>
      </div>
    </button>
  );
}

// Album Stack: current track on top with an accent ring, two most-recent
// queue items below as smaller tiles. Vertical track title alongside.
// Play/pause icon at bottom. Whole tile = tap to toggle.

import { useMusicPlayer } from '../MusicPlayerProvider.jsx';
import { mediaUrl } from '@host/api.js';

export default function AlbumStack({ accent }) {
  const { currentTrack, queue, index, isPlaying, toggle } = useMusicPlayer();
  const hasTrack = !!currentTrack;
  const cover = hasTrack ? mediaUrl(currentTrack.albumImage) || null : null;

  const recent = (() => {
    if (!Array.isArray(queue) || queue.length === 0) return [];
    const out = [];
    for (let i = (index ?? 0) - 1; i >= 0 && out.length < 2; i--) {
      const t = queue[i];
      if (t && t.albumImage) out.push(t);
    }
    return out;
  })();

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
      <div style={{
        position: 'relative', width: 36, height: 36, flexShrink: 0,
      }}>
        {recent[1] && (
          <Tile src={mediaUrl(recent[1].albumImage)} style={{
            position: 'absolute', top: 6, left: 6, width: 26, height: 26,
            opacity: 0.55, transform: 'rotate(-4deg)',
          }}/>
        )}
        {recent[0] && (
          <Tile src={mediaUrl(recent[0].albumImage)} style={{
            position: 'absolute', top: 3, left: 3, width: 30, height: 30,
            opacity: 0.8, transform: 'rotate(3deg)',
          }}/>
        )}
        <Tile src={cover} ring={accent} style={{
          position: 'relative', width: 36, height: 36,
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

function Tile({ src, style, ring }) {
  return (
    <div style={{
      borderRadius: 5,
      overflow: 'hidden',
      background: src ? 'transparent' : 'var(--surface-2, rgba(255,255,255,0.04))',
      boxShadow: ring
        ? `0 0 0 1.5px ${ring}, 0 1px 4px rgba(0,0,0,0.25)`
        : 'inset 0 0 0 1px var(--border)',
      ...style,
    }}>
      {src && <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>}
    </div>
  );
}

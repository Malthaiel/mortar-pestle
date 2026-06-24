// Single episode row in SeriesDetail. Click to play, hover affordances for
// open-page + watched indicator.

import { useState } from 'react';

export default function EpisodeRow({ ep, idx, accent, seriesPath, watched, playing, progress, onPlay }) {
  const [hover, setHover] = useState(false);
  const unavailable = !ep.available;
  const filled = watched || playing;

  const onPopout = (e) => {
    e.stopPropagation();
    if (unavailable || !seriesPath) return;
    const encoded = seriesPath.split('/').map(encodeURIComponent).join('/');
    const url = window.location.origin + '/#/player/' + encoded + '?ep=' + idx;
    window.open(url, 'video-popout-' + idx, 'popup,width=1280,height=720');
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => !unavailable && onPlay()}
      title={unavailable ? 'episode not downloaded' : (ep.title || '')}
      className={'candy-btn' + (playing ? ' is-playing' : '') + (unavailable ? ' is-unavailable' : '')}
      data-shape="track"
      style={{
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <div className="candy-face" style={{ minHeight: 52, padding: '8px 14px' }}>
      {/* Number tile */}
      <div style={{
        width: 28, height: 28, flexShrink: 0,
        borderRadius: 7,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: playing ? '#fff' : (filled ? accent : 'var(--surface-2)'),
        border: filled ? 'none' : '1px solid var(--border)',
        color: playing ? accent : (filled ? 'white' : 'var(--text-muted)'),
        fontSize: 11, fontFamily: 'var(--font-mono)',
        fontWeight: filled ? 700 : 500,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
        boxShadow: 'none',
        transition: 'background 100ms ease, color 100ms ease, box-shadow 120ms ease',
      }}>
        {playing ? '▶' : (watched ? '✓' : String(ep.n).padStart(2, '0'))}
      </div>

      {/* Title + date stack */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, lineHeight: 1.25,
          fontWeight: playing ? 600 : 500,
          color: playing ? '#fff' : (watched ? 'var(--text-muted)' : 'var(--text)'),
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{ep.title}</div>
        {ep.aired && (
          <div style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: playing ? 'rgba(255,255,255,0.7)' : 'var(--text-faint)',
            letterSpacing: '0.04em',
            marginTop: 3,
            fontVariantNumeric: 'tabular-nums',
          }}>{ep.aired}</div>
        )}
      </div>

      {/* Popout button (hover reveal) */}
      {!unavailable && (
        <button
          onClick={onPopout}
          title="Open in separate window"
          data-own-press
          className="candy-btn"
          data-shape="circle"
          style={{
            opacity: hover ? 1 : 0,
            pointerEvents: hover ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
            flexShrink: 0,
          }}
        ><span className="candy-face">↗</span></button>
      )}
      </div>

      {/* Progress sliver along the bottom edge */}
      {progress != null && progress > 0 && (
        <div style={{
          position: 'absolute',
          left: 0, right: 0, bottom: 0,
          height: 2,
          background: `color-mix(in oklch, ${accent} 14%, transparent)`,
          pointerEvents: 'none',
        }}>
          <div style={{
            width: `${Math.min(100, Math.max(0, progress * 100))}%`,
            height: '100%',
            background: accent,
            transition: 'width 200ms ease',
          }}/>
        </div>
      )}
    </div>
  );
}

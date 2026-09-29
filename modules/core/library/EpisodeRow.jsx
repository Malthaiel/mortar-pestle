// Single episode row in SeriesDetail. Click to play, watched indicator.
//
// The hover-reveal pop-out arrow was DELETED 2026-09-06. It called
// `window.open`, which returns null in WebView2 and creates no OS window, and
// the standalone player route it targeted lost its picture host when Phase 4 of
// the Native Video Player plan dropped pop-out. So it opened an empty window,
// every time. Playback is the mpv lane only; there is no second window to open.
// `hover`/`setHover` and the `seriesPath` prop existed solely for that arrow.
//
// `onDownload` is the TV Shows lane (Anime never passes it): Torrentio needs a
// season AND an episode number, and the row is the only place that knows both.
// It is hidden once the file is on disk — a downloaded row just plays.
// `dlPct` replaces it with live progress while that episode's job runs.

import { IconDownload, IconCheck, IconPlayMark } from '@host/components/icons.jsx';

export default function EpisodeRow({ ep, idx, accent, watched, playing, progress, onPlay, onDownload, dlPct }) {
  const unavailable = !ep.available;
  const filled = watched || playing;

  return (
    <div
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
        borderRadius: 'calc(var(--corner) * 14px)',
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
        {playing ? <IconPlayMark size="1.1em"/> : (watched ? <IconCheck size="0.9em"/> : String(ep.n).padStart(2, '0'))}
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

      {dlPct != null ? (
        <div style={{
          flexShrink: 0, fontSize: 10.5, fontFamily: 'var(--font-mono)',
          color: accent, fontVariantNumeric: 'tabular-nums',
        }}>{Math.round(dlPct)}%</div>
      ) : onDownload && unavailable ? (
        <button
          type="button"
          title={`Download episode ${ep.n}`}
          data-own-press
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          style={{
            flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            // The track face is pointer-events:none; a nested row button has to
            // re-enable it on itself or the row swallows the click (styles.css
            // "nested row buttons re-enable pointer-events on themselves").
            pointerEvents: 'auto',
            width: 26, height: 26, padding: 0, cursor: 'pointer',
            borderRadius: 'calc(var(--corner) * 13px)',
            border: '1px solid var(--border)', background: 'var(--surface-2)',
            color: 'var(--text-muted)',
          }}
        >
          <IconDownload size={13}/>
        </button>
      ) : null}

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

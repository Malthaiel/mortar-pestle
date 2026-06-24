// Music player tile — candy-styled big-button shell wrapping the current
// track. Prototype that will eventually replace `SidebarMusicSlot`. Reads
// from the shared `MusicPlayerProvider` context so cover / title / artist /
// position / live waveform mirror the real player state.
//
// Layout: [cover (square, fills inner height)] [info column: title, artist,
// time + live waveform], with a candy scrub rail across the bottom.

import { useEffect, useRef, useState } from 'react';
import { useMusicPlayer } from '@modules/core/library/music/MusicPlayerProvider.jsx';
import LyricsPanel from '@modules/core/library/music/LyricsPanel.jsx';
import QueuePanel from '@modules/core/library/music/QueuePanel.jsx';
import { mediaUrl } from '../api.js';
import { navigate } from '../router.js';

const BAR_COUNT = 36;

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function MusicPlayerWidget() {
  const {
    currentTrack, isPlaying, position, duration,
    shuffle, repeat, volume,
    toggle, next, prev, seek, setVolume, toggleShuffle, cycleRepeat,
  } = useMusicPlayer();
  const scrubRef = useRef(null);
  const draggingRef = useRef(false);
  const [openPanel, setOpenPanel] = useState(null); // null | 'lyrics' | 'queue'
  const accent = 'var(--accent)';                   // mirrors SidebarMusicSlot
  const hasTrack = !!currentTrack;
  const cover   = hasTrack ? mediaUrl(currentTrack.albumImage) || null : null;
  const title   = hasTrack ? (currentTrack.title  || '—') : '';
  const artist  = hasTrack ? (currentTrack.artist || '')  : '';

  const stop = (e) => e.stopPropagation();
  const openAlbum = (e) => {
    e.stopPropagation();
    if (!currentTrack?.albumPath) return;
    const encoded = currentTrack.albumPath.split('/').map(encodeURIComponent).join('/');
    navigate('/tools/library/music/downloaded/' + encoded);
  };
  const primarySize = {
    width:    'calc(40 * var(--tile-px))',
    height:   'calc(40 * var(--tile-px))',
  };
  const tileGlyph = { fontSize: 'calc(16 * var(--tile-px))' };

  const seekToClientX = (clientX) => {
    const el = scrubRef.current;
    if (!el || !duration) return;
    const rect = el.getBoundingClientRect();
    const pctClamped = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seek(pctClamped * duration);
  };
  const onWheel = (e) => {
    e.stopPropagation();
    const dir = e.deltaY < 0 ? +1 : -1;
    setVolume(Math.max(0, Math.min(1, volume + dir * 0.05)));
  };
  const onScrubDown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!hasTrack) return;
    draggingRef.current = true;
    seekToClientX(e.clientX);
    const onMove = (ev) => { if (draggingRef.current) seekToClientX(ev.clientX); };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Close the open panel on Escape or a click outside it. `.candy-modal` is the
  // panels' root class (clicks inside don't close); `[data-music-toggle]` exempts
  // the Lyrics/Queue buttons so their own onClick stays the sole toggle authority.
  useEffect(() => {
    if (!openPanel) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpenPanel(null); };
    const onDown = (e) => {
      if (e.target.closest?.('.candy-modal, [data-music-toggle]')) return;
      setOpenPanel(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [openPanel]);

  return (
    // Outer query-container wrapper. `cqw` units resolve against the nearest
    // ancestor container, not the element itself — so `.music-tile`
    // needs an ancestor with `container-type` for its OWN `height: calc(N *
    // var(--tile-px))` to scale. Inner controls scaled fine before because
    // they ARE descendants of `.music-tile`, but the tile height
    // was reading viewport-cqw (always capped at 1px). This wrapper fixes it.
    <>
    <div style={{ containerType: 'inline-size', width: '100%' }} onWheel={onWheel}>
    <div className="candy-btn music-tile" data-shape="tile" aria-label="Music player tile">
      <div className="candy-face" style={{
        display: 'flex', flexDirection: 'column',
        width: '100%', height: '100%',
        padding: 'calc(12 * var(--tile-px))', gap: 'calc(10 * var(--tile-px))',
        boxSizing: 'border-box',
      }}>
        <div style={{
          display: 'flex', gap: 'calc(12 * var(--tile-px))',
          flex: 1, minHeight: 0,
        }}>
          <div
            className="music-tile-cover"
            data-aos-name="AlbumCover"
            onMouseDown={stop}
            onClick={openAlbum}
            style={{
              width: 'calc(130 * var(--tile-px))', height: 'calc(130 * var(--tile-px))',
              alignSelf: 'center',
              flexShrink: 0,
              background: 'var(--surface-2)',
              border: 'calc(4.375 * var(--tile-px)) solid color-mix(in oklch, var(--surface), black 22%)',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
            }}>
            {cover && (
              <img src={cover} alt="" style={{
                width: '100%', height: '100%',
                objectFit: 'cover', display: 'block',
              }}/>
            )}
          </div>
          <div style={{
            flex: 1, minWidth: 0,
            display: 'flex', flexDirection: 'column',
            gap: 'calc(4 * var(--tile-px))', textAlign: 'left',
          }}>
            <div data-aos-name="Title" style={{
              fontSize: 'calc(26 * var(--tile-px))', fontWeight: 900,
              color: 'var(--text)',
              lineHeight: 1.2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{title}</div>
            <div data-aos-name="Artist" style={{
              fontSize: 'calc(17 * var(--tile-px))', fontWeight: 800,
              color: 'var(--text-muted)',
              lineHeight: 1.25,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{artist}</div>
            <div
              data-aos-name="Controls"
              onClick={stop}
              onMouseDown={stop}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
                gap: 'calc(6 * var(--tile-px))', flexShrink: 0,
                marginTop: 'calc(18 * var(--tile-px))',
              }}
            >
              <button type="button" data-own-press data-music-toggle
                className={`candy-btn${openPanel === 'lyrics' ? ' is-active' : ''}`}
                data-shape="icon"
                onClick={(e) => { stop(e); setOpenPanel(p => p === 'lyrics' ? null : 'lyrics'); }}
                style={primarySize}
                title="Lyrics"
                aria-pressed={openPanel === 'lyrics'}>
                <span className="candy-face" style={tileGlyph}>
                  <span style={{ fontWeight: 700, letterSpacing: '-0.02em', fontFamily: 'var(--font-mono)' }}>Aa</span>
                </span>
              </button>
              <button type="button" data-own-press
                className={`candy-btn${shuffle ? ' is-active' : ''}`}
                data-shape="icon"
                onClick={(e) => { stop(e); toggleShuffle(); }}
                style={primarySize}
                title={`Shuffle: ${shuffle ? 'on' : 'off'}`}
                aria-pressed={shuffle}><span className="candy-face" style={tileGlyph}>⤮</span></button>
              <button type="button" data-own-press
                className="candy-btn"
                data-shape="icon"
                onClick={(e) => { stop(e); prev(); }}
                disabled={!hasTrack}
                style={primarySize}
                title="Previous"><span className="candy-face" style={tileGlyph}>⏮</span></button>
              <button type="button" data-own-press
                className={`candy-btn${isPlaying ? ' is-active' : ''}`}
                data-shape="icon"
                onClick={(e) => { stop(e); toggle(); }}
                disabled={!hasTrack}
                style={primarySize}
                title={isPlaying ? 'Pause' : 'Play'}
                aria-label={isPlaying ? 'Pause' : 'Play'}>
                <span className="candy-face" style={tileGlyph}>{isPlaying ? '⏸' : '▶'}</span>
              </button>
              <button type="button" data-own-press
                className="candy-btn"
                data-shape="icon"
                onClick={(e) => { stop(e); next(); }}
                disabled={!hasTrack}
                style={primarySize}
                title="Next"><span className="candy-face" style={tileGlyph}>⏭</span></button>
              <button type="button" data-own-press
                className={`candy-btn${repeat !== 'off' ? ' is-active' : ''}`}
                data-shape="icon"
                onClick={(e) => { stop(e); cycleRepeat(); }}
                style={primarySize}
                title={`Repeat: ${repeat}`}
                aria-pressed={repeat !== 'off'}>
                <span className="candy-face" style={tileGlyph}>{repeat === 'one' ? '↻¹' : '↻'}</span>
              </button>
              <button type="button" data-own-press data-music-toggle
                className={`candy-btn${openPanel === 'queue' ? ' is-active' : ''}`}
                data-shape="icon"
                onClick={(e) => { stop(e); setOpenPanel(p => p === 'queue' ? null : 'queue'); }}
                style={primarySize}
                title="Queue"
                aria-pressed={openPanel === 'queue'}><span className="candy-face" style={tileGlyph}>≡</span></button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}/>
          </div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'calc(8 * var(--tile-px))',
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: 'calc(18 * var(--tile-px))', fontFamily: 'var(--font-mono)',
            fontWeight: 900,
            color: 'white',
            minWidth: 'calc(50 * var(--tile-px))', textAlign: 'left',
            fontVariantNumeric: 'tabular-nums',
          }}>{fmt(position)}</span>
          <div
            ref={scrubRef}
            className="music-tile-scrub"
            data-no-drag
            onMouseDown={onScrubDown}
            onClick={stop}
            style={{
              flex: 1, height: 'calc(28 * var(--tile-px))',
              display: 'flex', alignItems: 'center',
              gap: 'calc(2 * var(--tile-px))',
              cursor: hasTrack && duration ? 'pointer' : 'default',
              userSelect: 'none',
            }}>
            {Array.from({ length: BAR_COUNT }).map((_, i) => {
              const fraction = (i + 0.5) / BAR_COUNT;
              const played = duration > 0 && fraction <= (position / duration);
              return (
                <div key={i}
                  className="music-tile-pulse-bar"
                  data-played={played ? 'true' : 'false'}
                  data-playing={isPlaying && hasTrack ? 'true' : 'false'}
                  style={{ animationDelay: `${(i * 73) % 900}ms` }}
                />
              );
            })}
          </div>
          <span style={{
            fontSize: 'calc(18 * var(--tile-px))', fontFamily: 'var(--font-mono)',
            fontWeight: 900,
            color: 'white',
            minWidth: 'calc(50 * var(--tile-px))', textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}>{fmt(duration)}</span>
        </div>
      </div>
    </div>
    </div>
    <LyricsPanel open={openPanel === 'lyrics'} onClose={() => setOpenPanel(null)} accent={accent}/>
    <QueuePanel  open={openPanel === 'queue'}  onClose={() => setOpenPanel(null)} accent={accent}/>
    </>
  );
}

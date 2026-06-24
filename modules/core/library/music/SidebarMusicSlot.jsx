// Slim sidebar music slot. Compact row layout: caption, cover-left/text-right
// row, scrub bar with inline times, three primary controls. Extras row
// (lyrics / shuffle / repeat / queue + volume) slides in on hover or while
// queue/lyrics panel is open.

import { useState } from 'react';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import QueuePanel from './QueuePanel.jsx';
import LyricsPanel from './LyricsPanel.jsx';
import { IconVolume } from '@host/components/icons.jsx';
import { IconBtn, Dot } from '@host/components/ui/index.js';
import { navigate } from '@host/router.js';
import { mediaUrl } from '@host/api.js';

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function SidebarMusicSlot() {
  // Music sidebar inherits the global app accent via `var(--accent)` so the
  // user's accent picker drives every accent surface (transport buttons, scrub
  // bar, volume) directly from :root.
  const accent = 'var(--accent)';
  const {
    currentTrack, isPlaying, position, duration,
    volume, shuffle, repeat,
    toggle, next, prev, seek, setVolume, cycleRepeat, toggleShuffle,
  } = useMusicPlayer();
  const [queueOpen, setQueueOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [scrubHover, setScrubHover] = useState(false);
  const [slotHover, setSlotHover] = useState(false);

  const hasTrack = !!currentTrack;
  const pct = hasTrack && duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  const onScrubDown = (e) => {
    if (!hasTrack || !duration) return;
    const el = e.currentTarget;
    const apply = (clientX) => {
      const r = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      seek(x * duration);
    };
    apply(e.clientX);
    const move = (ev) => apply(ev.clientX);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const cover = hasTrack ? mediaUrl(currentTrack.albumImage) || null : null;

  const openAlbum = () => {
    if (!hasTrack || !currentTrack.albumPath) return;
    navigate('/tools/library/music/downloaded/' + encodeURIComponent(currentTrack.albumPath));
  };

  const extrasOpen = hasTrack && (slotHover || queueOpen || lyricsOpen);

  return (
    <>
      <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} accent={accent}/>
      <LyricsPanel open={lyricsOpen} onClose={() => setLyricsOpen(false)} accent={accent}/>
      <div
        onMouseEnter={() => setSlotHover(true)}
        onMouseLeave={() => setSlotHover(false)}
        className="candy-row"
        style={{
          padding: '12px 16px 14px',
          flex: '0 0 auto',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Caption */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Dot color={isPlaying ? accent : 'var(--text-faint)'} glow={isPlaying} size={5}/>
          <span style={{
            fontSize: 9, fontFamily: 'var(--font-mono)',
            color: 'var(--text-faint)',
            letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>
            {hasTrack ? (isPlaying ? 'Now Playing' : 'Paused') : 'No Track'}
          </span>
        </div>

        {/* Cover + title/artist */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginTop: 10,
        }}>
          <button
            onClick={openAlbum}
            title={hasTrack ? 'Open album' : undefined}
            disabled={!hasTrack}
            style={{
              width: 64, height: 64, padding: 0, border: 'none',
              background: 'transparent',
              cursor: hasTrack ? 'pointer' : 'default',
              borderRadius: 'var(--radius-md)', overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {cover ? (
              <img src={cover} alt="" style={{
                width: '100%', height: '100%', objectFit: 'cover',
                display: 'block', background: 'var(--surface-2)',
              }}/>
            ) : (
              <div style={{
                width: '100%', height: '100%',
                background: 'var(--surface-2)',
                border: '1px dashed var(--border)',
                borderRadius: 'var(--radius-md)',
              }}/>
            )}
          </button>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{
              fontSize: 13, fontWeight: 600,
              color: hasTrack ? 'var(--text)' : 'var(--text-faint)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              letterSpacing: '-0.005em',
            }}>{hasTrack ? currentTrack.title : '—'}</div>
            <div style={{
              fontSize: 11, color: 'var(--text-muted)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {hasTrack
                ? (currentTrack.artist + (currentTrack.albumTitle ? ' · ' + currentTrack.albumTitle : ''))
                : ' '}
            </div>
          </div>
        </div>

        {/* Scrub + inline times */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginTop: 10,
        }}>
          <div
            data-no-drag
            onMouseDown={onScrubDown}
            onMouseEnter={() => setScrubHover(true)}
            onMouseLeave={() => setScrubHover(false)}
            style={{
              flex: 1, height: 14,
              display: 'flex', alignItems: 'center',
              cursor: hasTrack && duration ? 'pointer' : 'default',
            }}
          >
            <div style={{
              width: '100%', height: scrubHover && hasTrack ? 4 : 3,
              background: `color-mix(in oklch, ${accent} 14%, transparent)`,
              borderRadius: 2,
              position: 'relative',
              transition: 'height 100ms ease',
            }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: pct + '%', background: accent, borderRadius: 2,
                transition: 'width 100ms linear',
              }}/>
              {hasTrack && (
                <div style={{
                  position: 'absolute', top: '50%', left: `calc(${pct}% - 5px)`,
                  width: 10, height: 10, borderRadius: '50%',
                  background: accent, transform: 'translateY(-50%)',
                  opacity: scrubHover ? 1 : 0,
                  pointerEvents: 'none',
                  transition: 'opacity 120ms ease',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                }}/>
              )}
            </div>
          </div>
          <span style={{
            fontSize: 9, color: 'var(--text-muted)', flexShrink: 0,
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.04em',
          }}>{fmt(position)} / {fmt(duration)}</span>
        </div>

        {/* Primary transport */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          marginTop: 10,
        }}>
          <IconBtn title="Previous" onClick={prev} accent={accent} size={28} disabled={!hasTrack}>⏮</IconBtn>
          <IconBtn title={isPlaying ? 'Pause' : 'Play'} onClick={toggle}
                   size={30} accent={accent} primary playing={isPlaying} disabled={!hasTrack}>
            {isPlaying ? '⏸' : '▶'}
          </IconBtn>
          <IconBtn title="Next" onClick={next} accent={accent} size={28} disabled={!hasTrack}>⏭</IconBtn>
        </div>

        {/* Hover-revealed extras: lyrics, shuffle, repeat, queue + volume */}
        <div style={{
          marginTop: extrasOpen ? 8 : 0,
          maxHeight: extrasOpen ? 32 : 0,
          opacity: extrasOpen ? 1 : 0,
          overflow: 'hidden',
          transition: 'max-height 200ms ease, opacity 160ms ease, margin-top 200ms ease',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <IconBtn title="Lyrics" onClick={() => setLyricsOpen(o => !o)}
                     accent={accent} active={lyricsOpen} size={24}>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '-0.02em',
                fontFamily: 'var(--font-mono)',
              }}>Aa</span>
            </IconBtn>
            <IconBtn title={`Shuffle: ${shuffle ? 'on' : 'off'}`} onClick={toggleShuffle}
                     accent={accent} active={shuffle} size={24}>⤮</IconBtn>
            <IconBtn title={`Repeat: ${repeat}`} onClick={cycleRepeat}
                     accent={accent} active={repeat !== 'off'} size={24}>
              {repeat === 'one' ? '↻¹' : '↻'}
            </IconBtn>
            <IconBtn title="Queue" onClick={() => setQueueOpen(o => !o)}
                     accent={accent} active={queueOpen} size={24}>≡</IconBtn>
            <span style={{ width: 6, flexShrink: 0 }}/>
            <span style={{ color: 'var(--text-muted)', display: 'inline-flex', flexShrink: 0 }}>
              <IconVolume size={12}/>
            </span>
            <VolumeSlider value={volume} onChange={setVolume} accent={accent}/>
          </div>
        </div>
      </div>
    </>
  );
}

function VolumeSlider({ value, onChange, accent }) {
  const pct = Math.round(value * 100);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const onDown = (e) => {
    const el = e.currentTarget;
    const apply = (clientX) => {
      const r = el.getBoundingClientRect();
      onChange(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
    };
    setDragging(true);
    apply(e.clientX);
    const move = (ev) => apply(ev.clientX);
    const up = () => {
      setDragging(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const showHandle = dragging || hover;
  return (
    <div
      data-no-drag
      onMouseDown={onDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Volume ${pct}%`}
      style={{
        flex: 1, height: 14,
        display: 'flex', alignItems: 'center',
        cursor: 'pointer',
      }}
    >
      <div style={{
        width: '100%', height: showHandle ? 4 : 3,
        background: `color-mix(in oklch, ${accent} 14%, transparent)`,
        borderRadius: 2,
        position: 'relative',
        transition: 'height 100ms ease',
      }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: pct + '%', background: accent, borderRadius: 2,
        }}/>
        <div style={{
          position: 'absolute', top: '50%', left: `calc(${pct}% - 5px)`,
          width: dragging ? 11 : 9, height: dragging ? 11 : 9,
          background: accent,
          borderRadius: '50%',
          transform: 'translateY(-50%)',
          opacity: showHandle ? 1 : 0,
          transition: 'opacity 120ms ease, width 100ms ease, height 100ms ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
          pointerEvents: 'none',
        }}/>
      </div>
    </div>
  );
}

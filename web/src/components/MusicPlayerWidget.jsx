// Music player tile — candy-styled big-button shell wrapping the current
// track. THE live sidebar player — it superseded `SidebarMusicSlot`, which was
// deleted 2026-08-08 after a grep proved nothing mounted it. Reads
// from the shared `MusicPlayerProvider` context so cover / title / artist /
// position / live waveform mirror the real player state.
//
// Layout: [cover (square, fills inner height)] [info column: title, artist,
// time + live waveform], with a candy scrub rail across the bottom.

import { useEffect, useRef, useState } from 'react';
import { useMusicPlayer } from '@modules/core/library/music/MusicPlayerProvider.jsx';
import LyricsPanel from '@modules/core/library/music/LyricsPanel.jsx';
import QueuePanel from '@modules/core/library/music/QueuePanel.jsx';
import { useSongMenu } from '@modules/core/library/music/contextMenus.js';
import { mediaUrl } from '../api.js';
import { navigate } from '../router.js';

const BAR_COUNT = 12;   // 36 → 18 → 12 over 2026-09-03 — fewer, chunkier bars
// Frozen bar skyline survives an app restart (decision 2026-09-02: pausing
// holds the shape, closing the app keeps it).
const LS_BARS = 'music:bars';
// The meter is SIDEWAYS (user-directed 2026-09-03): a full-height strip down the
// tile's right edge whose bars grow right-to-left, so a bar's LEVEL is its width.
// Bar 0 (bass) sits at the TOP and treble descends (flipped 2026-09-03).
const METER_W   = 135; // tile-px, the strip's total width
const BAR_FLOOR = 5;   // tile-px, the flat resting width
const BAR_RISE  = 117; // tile-px added at full level → 122 inside the 135-wide strip
// getByteFrequencyData is dB-scaled across the analyser's -100..-30 dB window,
// so on real music the whole signal lives in roughly 100..255 — mapping raw
// 0..255 pinned every bass bar at the top. Measured on a downloaded track:
// bass ≈ 205, mids ≈ 150, near-silence ≈ 100. Stretch that band to fill the row.
const BAR_NOISE = 100; // at or below this, the bar rests on the floor
const BAR_CEIL  = 255; // at or above this, the bar is full width
// Snap up on a transient, ease down after it — a raw per-frame height reads as
// jitter, not as a beat.
const BAR_FALL = 0.88;

// Log-spaced sampling POSITIONS (fractional), not integer slices. Provider runs
// fftSize 256 → 128 bins, one bin ≈ 187 Hz; bin 90 ≈ 17 kHz. Integer slices put
// the first six bars on the same bin and painted the left third as one solid
// plateau — reading the array at a fractional position and interpolating gives
// each bar its own value all the way down.
const BAR_POS = (() => {
  const MIN = 1, MAX = 90;
  return Array.from({ length: BAR_COUNT }, (_, i) =>
    MIN * Math.pow(MAX / MIN, i / (BAR_COUNT - 1)));
})();

function loadBars() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_BARS));
    if (Array.isArray(raw) && raw.length === BAR_COUNT) {
      return raw.map(v => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0));
    }
  } catch {}
  return Array.from({ length: BAR_COUNT }, () => 0);
}
function saveBars(levels) {
  try { localStorage.setItem(LS_BARS, JSON.stringify(levels.map(v => +v.toFixed(3)))); } catch {}
}
const barWidth = (v) => `calc(${(BAR_FLOOR + v * BAR_RISE).toFixed(1)} * var(--tile-px))`;

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function MusicPlayerWidget() {
  const {
    currentTrack, isPlaying, position, duration,
    shuffle, repeat, volume, resolvingStream,
    toggle, next, prev, seek, setVolume, toggleShuffle, cycleRepeat,
    getAnalyser,
  } = useMusicPlayer();
  const scrubRef = useRef(null);
  const meterRef = useRef(null);
  const volDraggingRef = useRef(false);
  // Bar heights are written straight to the DOM, never through state — 36
  // style writes a frame is cheap, 36 re-renders of this tile a frame is not.
  const barRefs  = useRef([]);
  const levelsRef = useRef(loadBars());
  const draggingRef = useRef(false);
  const [openPanel, setOpenPanel] = useState(null); // null | 'lyrics' | 'queue'
  const accent = 'var(--accent)';
  const hasTrack = !!currentTrack;
  const cover   = hasTrack ? mediaUrl(currentTrack.albumImage) || null : null;
  const title   = hasTrack ? (currentTrack.title  || '—') : '';
  // While a stream track's URL is being fetched, the artist line reads
  // "Finding track" (decision 5 — plain words, no trailing dots).
  const artist  = hasTrack
    ? (resolvingStream ? 'Finding track' : (currentTrack.artist || ''))
    : '';

  const stop = (e) => e.stopPropagation();

  // Right-click anywhere on the tile for the shared song menu on what's playing
  // (Save / Download / Add to playlist). No track playing → return before
  // openMenu so the app-wide default menu still appears.
  const { openMenu: openSongMenu, modalEl: playlistModal } = useSongMenu(accent);
  const onTileContextMenu = (e) => {
    if (!hasTrack) return;
    openSongMenu(e, currentTrack);
  };
  const openAlbum = (e) => {
    e.stopPropagation();
    if (!currentTrack?.albumPath) return;
    const encoded = currentTrack.albumPath.split('/').map(encodeURIComponent).join('/');
    navigate('/tools/library/music/downloaded/' + encoded);
  };
  // Size through --cbtn-size, never a hard width/height pair (styles.css § icon
  // shape says so, and .candy-split derives both the fused corner radius and the
  // trailing half's overlap compensation from this var — an inline width would
  // beat those rules and break the seam).
  const primarySize = { '--cbtn-size': 'calc(40 * var(--tile-px))' };
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
  // The meter strip IS the volume fader (user-directed 2026-09-03): the bars
  // dance to the music AND the lit run up from the bottom shows the level.
  // Read the strip's live rect every drag frame rather than caching it — the
  // tile resizes with the sidebar.
  const volumeFromClientY = (clientY) => {
    const el = meterRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.height) return;
    setVolume(Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height)));
  };
  const onMeterDown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    volDraggingRef.current = true;
    volumeFromClientY(e.clientY);
    const onMove = (ev) => { if (volDraggingRef.current) volumeFromClientY(ev.clientY); };
    const onUp = () => {
      volDraggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
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

  // Paint the restored skyline once on mount, so a fresh app start shows the
  // shape the last pause left behind instead of a flat line.
  useEffect(() => {
    levelsRef.current.forEach((v, i) => {
      const el = barRefs.current[i];
      if (el) el.style.width = barWidth(v);
    });
    return () => saveBars(levelsRef.current);
  }, []);

  // Live spectrum. Reads the provider's shared AnalyserNode every frame while
  // playing; on pause the loop stops and the bars keep their last heights.
  useEffect(() => {
    if (!isPlaying) { saveBars(levelsRef.current); return; }
    const analyser = getAnalyser?.();
    if (!analyser) return; // no WebAudio → bars simply hold their frozen shape
    const buf = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      const lv = levelsRef.current;
      const last = buf.length - 1;
      for (let i = 0; i < BAR_COUNT; i++) {
        const f = BAR_POS[i];
        const i0 = Math.min(last, Math.floor(f));
        const i1 = Math.min(last, i0 + 1);
        const frac = f - i0;
        const raw = buf[i0] * (1 - frac) + buf[i1] * frac;
        const target = Math.max(0, Math.min(1, (raw - BAR_NOISE) / (BAR_CEIL - BAR_NOISE)));
        lv[i] = target > lv[i] ? target : lv[i] * BAR_FALL;
        const el = barRefs.current[i];
        if (el) el.style.width = barWidth(lv[i]);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, getAnalyser]);

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
    // ancestor container, not the element itself — so `.rail-tile`
    // needs an ancestor with `container-type` for its OWN `height: calc(N *
    // var(--tile-px))` to scale. Inner controls scaled fine before because
    // they ARE descendants of `.rail-tile`, but the tile height
    // was reading viewport-cqw (always capped at 1px). This wrapper fixes it.
    <>
    {playlistModal}
    <div style={{ containerType: 'inline-size', width: '100%' }} onWheel={onWheel} onContextMenu={onTileContextMenu}>
    <div className="candy-btn rail-tile is-music" data-shape="tile" aria-label="Music player tile">
      {/* The meter is a LAYER, not a column (user-directed 2026-09-03): it runs
          the full height of the tile's right side and the title, artist and
          control row sit OVER it. So the face is a positioning context and the
          content spans the whole width — nothing is reserved for the strip. */}
      <div className="candy-face" style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column',
        width: '100%', height: '100%',
        padding: 'calc(12 * var(--tile-px))',
        boxSizing: 'border-box',
        // The meter runs to the face's outer edge, so its square bar corners
        // would poke past the face's rounded ones. Clip to the face's own
        // radius rather than restating it on the strip (the corner knob owns
        // that number). Nothing inside the tile is meant to overflow.
        overflow: 'hidden',
      }}>
        {/* The meter strip: bars grow right-to-left, bar 0 (bass) at the top.
            The strip IS the volume fader — drag it up or down; the lit run from
            the bottom is the level. */}
        <div
          ref={meterRef}
          className="music-tile-meter"
          data-no-drag
          onMouseDown={onMeterDown}
          onClick={stop}
          style={{
            position: 'absolute', zIndex: 0,
            // Child of the FACE, not of the cover+info row (2026-09-03): an
            // absolute box resolves against its containing block's PADDING box,
            // so 0/0/0 here is the widget's full top-to-bottom edge — behind the
            // time rail, out through the face's own padding, with no restated
            // pixel number to drift when the tile resizes.
            top: 0, bottom: 0, right: 0,
            width: `calc(${METER_W} * var(--tile-px))`,
            // Flipped VERTICALLY (user-directed 2026-09-03): plain `column` puts
            // bar 0 (bass) at the TOP and treble descends. Bars stay anchored on
            // the strip's right edge and grow leftward.
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
            gap: 'calc(3 * var(--tile-px))',
            cursor: 'ns-resize', userSelect: 'none',
          }}
          title={`Volume: ${Math.round(volume * 100)}%`}>
          {Array.from({ length: BAR_COUNT }).map((_, i) => (
            <div key={i}
              ref={(el) => { barRefs.current[i] = el; }}
              className="music-tile-meter-bar"
            />
          ))}
        </div>
        <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', flexDirection: 'column',
        flex: 1, minWidth: 0, minHeight: 0,
        gap: 'calc(10 * var(--tile-px))',
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
              position: 'relative', zIndex: 1,
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
            position: 'relative', zIndex: 1,
            flex: 1, minWidth: 0,
            display: 'flex', flexDirection: 'column',
            gap: 'calc(4 * var(--tile-px))', textAlign: 'left',
          }}>
            {/* flexShrink:0 — the second control row (2026-09-03) pushed the
                column over the tile's height and flex shrank these two lines to
                ~3px of clipped glyph instead. They own their height; the spacer
                below absorbs whatever slack is left. */}
            <div data-aos-name="Title" style={{
              fontSize: 'calc(26 * var(--tile-px))', fontWeight: 900,
              color: 'var(--text)',
              lineHeight: 1.2, flexShrink: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{title}</div>
            <div data-aos-name="Artist" style={{
              fontSize: 'calc(17 * var(--tile-px))', fontWeight: 800,
              color: 'var(--text-muted)',
              lineHeight: 1.25, flexShrink: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{artist}</div>
            {/* ONE fused run of all seven (user-directed 2026-09-03), the same
                .candy-split the Planner section heads use — straight seams
                between halves, round only on the run's two outer ends. The row
                sits OVER the meter strip; the strip is the layer behind. */}
            <div
              data-aos-name="Controls"
              onClick={stop}
              onMouseDown={stop}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
                flexShrink: 0,
                marginTop: 'calc(14 * var(--tile-px))',
              }}
            >
              <div className="candy-split">
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
              {/* No is-active while playing (user-directed 2026-09-03): inside a
                  .candy-split an active half is HELD DOWN and lit, which made play
                  read as having fallen out of the run. The glyph carries the state. */}
              <button type="button" data-own-press
                className="candy-btn"
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
          {/* Time is a plain slim rail now (user-directed 2026-09-03) — the bars
              it used to be moved to the meter strip on the right, and two sets
              of bars in one tile read as noise. Still click + drag to seek. */}
          <div
            ref={scrubRef}
            className="music-tile-rail"
            data-no-drag
            onMouseDown={onScrubDown}
            onClick={stop}
            style={{
              flex: 1,
              cursor: hasTrack && duration ? 'pointer' : 'default',
              userSelect: 'none',
            }}>
            <div
              className="music-tile-rail-fill"
              style={{ width: duration > 0 ? `${Math.max(0, Math.min(1, position / duration)) * 100}%` : '0%' }}
            />
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
    </div>
    <LyricsPanel open={openPanel === 'lyrics'} onClose={() => setOpenPanel(null)} accent={accent}/>
    <QueuePanel  open={openPanel === 'queue'}  onClose={() => setOpenPanel(null)} accent={accent}/>
    </>
  );
}

// Native Video Player — the controls layer.
//
// A borderless transparent ALWAYS-ON-TOP window stacked over the mpv picture
// (`src-tauri/src/player_host.rs`), sized to the whole picture rect. Everything
// the user touches lives here, because the picture is a child window painted
// above the main web layer: anything the app draws under it is invisible.
//
// It may span the whole picture — verified 2026-08-23: with a full-size overlay
// on top, mpv reported `osd-dimensions 1440x900`, the complete rect, so a
// transparent top-level window costs the picture nothing. (An earlier attempt
// used a transparent CHILD WEBVIEW instead and cut its own height out of the
// video; that is why this is a separate window and must stay one.)
//
// Spanning the picture is also what lets click-to-pause live here rather than
// being routed through the app underneath.
//
// The bar is `VideoControls` VERBATIM. It reads everything from
// `useVideoPlayer()` and takes no props, so this file supplies that context
// from an mpv backend instead of forking a parallel bar. Every value is READ
// FROM mpv, never modelled here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import {
  VideoPlayerContext, HeaderBtn, PiPBtn, LS, loadJSON, saveJSON,
} from '@modules/core/library/VideoPlayerProvider.jsx';
import VideoControls from '@modules/core/library/VideoControls.jsx';
import { candyGap } from '@host/util/candy.js';

// mpv owns the clock. Poll it rather than running a local timer that drifts
// against real playback.
const POLL_MS = 200;
// Below this the window is the PiP thumbnail, not the modal. Read from the
// window itself — the mode is not restated here, it is measured.
const PIP_MAX_W = 480;
// Chrome fades after this much stillness, exactly as the old modal did.
const IDLE_MS = 2500;

function surfaceOf() {
  const q = window.location.hash.split('?')[1] || '';
  return new URLSearchParams(q).get('surface') || 'modal';
}

/// mpv's `track-list` → the `probe` shape VideoControls already understands.
function toProbe(tracks, chapters) {
  const of = (type) => (tracks || [])
    .filter((t) => t.type === type)
    .map((t) => ({ id: t.id, language: t.lang, title: t.title }));
  return {
    audio: of('audio'),
    subtitles: of('sub'),
    chapters: (chapters || []).map((c, i) => ({
      id: i, start: c.time, title: c.title || `Chapter ${i + 1}`,
    })),
  };
}

export default function PlayerControlsView() {
  const surface = useRef(surfaceOf()).current;
  const [live, setLive] = useState({
    time: 0, duration: 0, paused: true, volume: 100, speed: 1, aid: null, sid: null,
  });
  const [probe, setProbe] = useState(null);
  const [meta, setMeta] = useState(null);
  const [idle, setIdle] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth <= PIP_MAX_W);
  const idleTimer = useRef(null);
  const clickTimer = useRef(null);

  // Transparent root, or the webview paints opaque over the picture and the
  // whole layering exercise is wasted (the overlay-toast lesson).
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prev = [html.style.background, body.style.background];
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    body.classList.add('video-cinema');
    return () => {
      html.style.background = prev[0];
      body.style.background = prev[1];
      body.classList.remove('video-cinema');
    };
  }, []);

  // Modal or PiP is whatever size this window actually is. The app moves the
  // window; nothing here predicts where it went.
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= PIP_MAX_W);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // What is playing. The app owns the playlist, so the title line arrives as an
  // event — this window has no provider stack to read it from.
  // Asking is not optional: this window is BUILT by the same call that opens the
  // player, so the episode event has already been and gone by the time anything
  // here is listening. Subscribe, then ask for a repeat.
  useEffect(() => {
    let un;
    listen('player-meta', (e) => {
      if (e.payload && e.payload.surface === surface) setMeta(e.payload);
    }).then((f) => {
      un = f;
      return emit('player-meta-request', { surface });
    }).catch(() => {});
    return () => { if (un) un(); };
  }, [surface]);

  const cmd = useMemo(
    () => (args) => invoke('player_command', { surface, args }),
    [surface],
  );

  const send = useCallback(
    (action) => emit('player-control', { surface, action }).catch(() => {}),
    [surface],
  );

  // Track list and chapters change only when the file does, so they are pulled
  // once rather than polled.
  useEffect(() => {
    let alive = true;
    Promise.all([cmd(['get_property', 'track-list']), cmd(['get_property', 'chapter-list'])])
      .then(([t, c]) => { if (alive) setProbe(toProbe(t, c)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [cmd, meta]);

  useEffect(() => {
    let alive = true;
    const props = ['time-pos', 'duration', 'pause', 'volume', 'speed', 'aid', 'sid'];
    const tick = async () => {
      try {
        const [time, duration, paused, volume, speed, aid, sid] =
          await Promise.all(props.map((p) => cmd(['get_property', p])));
        if (alive) setLive({ time, duration, paused, volume, speed, aid, sid });
      } catch { /* mpv gone or still starting — the next tick retries */ }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [cmd]);

  // Chrome fades on stillness, and never while paused — the same rule the old
  // modal used, so the player feels unchanged.
  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); };
  }, [wake]);

  // Single click toggles play, double click toggles fullscreen. The delay lets
  // a second click within ~260 ms cancel the first, so a double click does not
  // also pause.
  const onPictureClick = () => {
    if (clickTimer.current) return;
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      cmd(['set_property', 'pause', !live.paused]).catch(() => {});
    }, 260);
  };
  const onPictureDblClick = () => {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    send('fullscreen');
  };

  // The context VideoControls consumes. mpv track ids are 1-based and the bar
  // indexes into `probe.audio`, so the two are translated at this boundary.
  // Volume is the other translation: the bar works in 0..1, mpv in 0..100.
  const value = useMemo(() => {
    const audio = (probe && probe.audio) || [];
    const dur = Number.isFinite(live.duration) ? live.duration : 0;
    const time = Number.isFinite(live.time) ? live.time : 0;
    const vol = Number.isFinite(live.volume) ? live.volume : 100;
    return {
      isPlaying: !live.paused,
      duration: dur,
      effectiveTime: time,
      volume: Math.min(1, Math.max(0, vol / 100)),
      speed: Number.isFinite(live.speed) ? live.speed : 1,
      probe,
      audioIdx: Math.max(0, audio.findIndex((t) => t.id === live.aid)),
      // Held at -1 on purpose: the only control keyed off it is the subtitle
      // settings gear, and that panel still edits the DOM-overlay renderer the
      // mpv lane replaced. Phase 5 rewires it to mpv's own subtitle properties
      // and this becomes the real sid index. A gear that opens a panel wired to
      // nothing would be worse than no gear.
      subIdx: -1,
      toggle: () => cmd(['set_property', 'pause', !live.paused]),
      seek: (sec) => cmd(['seek', sec, 'absolute']),
      skip: (delta) => cmd(['seek', delta, 'relative']),
      // Persisted to the same keys the app reads on the next open, so a change
      // made here survives the episode ending.
      setVolume: (n) => {
        const c = Math.min(1, Math.max(0, n));
        saveJSON(LS.volume, c);
        return cmd(['set_property', 'volume', Math.round(c * 100)]);
      },
      setSpeed: (n) => {
        saveJSON(LS.speed, n);
        return cmd(['set_property', 'speed', n]);
      },
      setAudioTrack: (i) => {
        if (!audio[i]) return undefined;
        saveJSON(LS.audPref, audio[i].language);
        return cmd(['set_property', 'aid', audio[i].id]);
      },
      // Episode stepping, refresh and fullscreen belong to whoever owns the
      // playlist and the window — not to this bar. They go out as one event the
      // app picks up, rather than inventing commands here.
      next: () => send('next'),
      prev: () => send('prev'),
      refresh: () => send('refresh'),
      requestFullscreen: () => send('fullscreen'),
    };
  }, [cmd, send, live, probe]);

  // ── PiP: the thumbnail in the corner, not the modal ──────────────────────
  // Two buttons and a click-to-expand body, exactly what the old PiP host had.
  if (narrow) {
    return (
      <VideoPlayerContext.Provider value={value}>
        <div
          className="video-cinema"
          onClick={() => send('expand')}
          title="Click to expand"
          style={{
            position: 'fixed', inset: 0, background: 'transparent',
            cursor: 'pointer',
          }}
        >
          <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 4 }}>
            <PiPBtn onClick={(e) => {
              e.stopPropagation();
              cmd(['set_property', 'pause', !live.paused]).catch(() => {});
            }}>{live.paused ? '▶' : '❚❚'}</PiPBtn>
            <PiPBtn onClick={(e) => { e.stopPropagation(); send('close'); }}>×</PiPBtn>
          </div>
        </div>
      </VideoPlayerContext.Provider>
    );
  }

  // ── Modal ────────────────────────────────────────────────────────────────
  const chromeHidden = idle && !live.paused;
  const fade = {
    opacity: chromeHidden ? 0 : 1,
    pointerEvents: chromeHidden ? 'none' : 'auto',
    transition: 'opacity 0.25s ease',
  };

  return (
    <VideoPlayerContext.Provider value={value}>
      <div
        className="video-cinema"
        onMouseMove={wake}
        onMouseDown={wake}
        onKeyDown={(e) => {
          if (e.key === ' ') { e.preventDefault(); cmd(['set_property', 'pause', !live.paused]); }
          if (e.key === 'ArrowRight') cmd(['seek', 10, 'relative']);
          if (e.key === 'ArrowLeft') cmd(['seek', -10, 'relative']);
          if (e.key === 'Escape') send('close');
        }}
        tabIndex={-1}
        style={{
          position: 'fixed', inset: 0, background: 'transparent',
          display: 'flex', flexDirection: 'column',
          cursor: chromeHidden ? 'none' : 'auto',
          outline: 'none',
        }}
      >
        {/* Title + window buttons. Was an overlay on the <video>; under mpv the
            picture is above the web layer, so it lives here instead — same
            gradient, same buttons, reaching the app as events. */}
        <div style={{
          ...fade,
          padding: '14px 24px 32px',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.7), rgba(0,0,0,0))',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 16, flexShrink: 0,
        }}>
          <div style={{
            color: 'var(--text-faint)', fontSize: 14, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.04em', minWidth: 0,
          }}>
            {meta && (
              <span>
                <span style={{ color: 'rgba(255,255,255,0.65)' }}>
                  {meta.title}
                  {meta.season && <span style={{ opacity: 0.7 }}> — {meta.season}</span>}
                </span>
                <span style={{ margin: '0 8px', opacity: 0.5 }}>·</span>
                <span style={{ color: '#fff' }}>
                  Ep {String(meta.n).padStart(2, '0')}
                  {meta.episodeTitle ? ` — ${meta.episodeTitle}` : ''}
                </span>
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {/* No pop-out button: `window.open` creates no OS window in this
                WebView2 config, so the pop-out has to be rebuilt as a real
                Tauri window before a button for it means anything. */}
            <HeaderBtn onClick={() => send('minimise')} title="Minimize to mini player">▾</HeaderBtn>
            <HeaderBtn onClick={() => send('close')} title="Close player">×</HeaderBtn>
          </div>
        </div>

        {/* The picture. Nothing is drawn here — mpv is behind this region — but
            it is the click target, so play/pause and fullscreen stay where the
            hand expects them. */}
        <div
          onClick={onPictureClick}
          onDoubleClick={onPictureDblClick}
          style={{ flex: 1, minHeight: 0 }}
        />

        {/* Bottom controls — opaque candy deck, same padding rule as the modal:
            bottom pad = top column gap (10) + the small candy depth, so the
            controls read vertically centred between the seek bar and the deck's
            bottom edge. */}
        <div className="candy-deck" style={{
          ...fade,
          margin: '0 16px 16px',
          padding: `12px 16px ${candyGap(10, true)} 16px`,
          flexShrink: 0,
        }}>
          <VideoControls/>
        </div>
      </div>
    </VideoPlayerContext.Provider>
  );
}

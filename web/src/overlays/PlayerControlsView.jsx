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
  DEFAULT_SUB_SETTINGS,
} from '@modules/core/library/VideoPlayerProvider.jsx';
import VideoControls from '@modules/core/library/VideoControls.jsx';
import { candyGap } from '@host/util/candy.js';
import { IconCaretDown, IconPause, IconPlayMark, IconX } from '../components/icons.jsx';

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

/// The subtitle panel's units → mpv's, the same boundary the volume (0..1 vs
/// 0..100) and track-id translations already live at. Verified against
/// `mpv --list-options` on the bundled v0.41 build, not from memory.
///
/// `sub-ass-override` is the gate everything else hangs off: at its default
/// `scale` mpv deliberately ignores our styling so ASS signs and karaoke render
/// as the release typeset them, and only sub-scale / sub-pos / sub-delay bite.
/// `force` makes the rest apply and flattens the signs, so it is the user's
/// explicit choice, off by default.
function subProps(s) {
  const hex2 = (n) => Math.round(Math.min(1, Math.max(0, n)) * 255)
    .toString(16).padStart(2, '0').toUpperCase();
  // mpv colours are #AARRGGBB. In outline-and-shadow, sub-back-color IS the
  // shadow colour (sub-shadow-color is an alias for it), so 'shadow' needs an
  // opaque one or the shadow it draws is invisible.
  const back = s.bgStyle === 'box' ? `#${hex2(s.bgOpacity)}000000`
    : s.bgStyle === 'shadow' ? '#FF000000'
    : '#00000000';
  return {
    'sub-ass-override': s.assOverride ? 'force' : 'scale',
    'sub-scale': s.size / DEFAULT_SUB_SETTINGS.size,
    'sub-pos': Math.round(s.position * 100),
    'sub-border-style': s.bgStyle === 'box' ? 'background-box' : 'outline-and-shadow',
    'sub-back-color': back,
    'sub-outline-size': s.bgStyle === 'outline' ? s.outlineSize : 0,
    'sub-shadow-offset': s.bgStyle === 'shadow' ? s.shadowSize : 0,
    'sub-bold': s.fontWeight >= 700,
    'sub-spacing': Math.min(10, Math.max(-10, s.letterSpacing)),
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
  // Subtitle appearance. Same localStorage keys the app writes, so a change made
  // here is the one the next open reads — this window and the main one share an
  // origin, exactly as volume and speed already rely on.
  const [subSettings, setSubSettings] = useState(() => ({
    ...DEFAULT_SUB_SETTINGS,
    ...(loadJSON(LS.subSettings, {}) || {}),
  }));
  const [subSyncMap, setSubSyncMap] = useState(() => loadJSON(LS.subSync, {}) || {});
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

  // Subtitle appearance and the per-episode sync offset, pushed into mpv. The
  // same effect covers the first open and every later edit, so there is one path
  // and no launch-argument copy of these values to drift against.
  // ponytail: mpv paints its default look for the ~200 ms before this lands on a
  // fresh open; add launch arguments only if that flash is ever actually seen.
  const fileAbs = (meta && meta.fileAbs) || '';
  const subSync = Number(subSyncMap[fileAbs] || 0);
  useEffect(() => {
    const props = { ...subProps(subSettings), 'sub-delay': subSync };
    for (const [p, val] of Object.entries(props)) {
      cmd(['set_property', p, val]).catch(() => {});
    }
  }, [cmd, meta, subSettings, subSync]);

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
  // The panel's own writers. Deliberately local rather than shared with the
  // provider's identically-named copies: those belong to the old <video> lane
  // and go with it in Phase 6, so a shared hook would outlive its second caller
  // by one phase.
  const updateSubSetting = useCallback((key, val) => {
    setSubSettings((prev) => {
      const next = { ...prev, [key]: val };
      saveJSON(LS.subSettings, next);
      return next;
    });
  }, []);
  const resetSubSettings = useCallback(() => {
    setSubSettings(DEFAULT_SUB_SETTINGS);
    saveJSON(LS.subSettings, DEFAULT_SUB_SETTINGS);
  }, []);
  const writeSync = useCallback((next) => {
    if (!fileAbs) return;
    setSubSyncMap((prev) => {
      const map = { ...prev };
      if (next === null) delete map[fileAbs];
      else map[fileAbs] = next;
      saveJSON(LS.subSync, map);
      return map;
    });
  }, [fileAbs]);

  const value = useMemo(() => {
    const audio = (probe && probe.audio) || [];
    const subs = (probe && probe.subtitles) || [];
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
      // The real track, read from mpv. `sid` is `false` when subtitles are off,
      // which matches no track id, so the -1 the bar means by "off" falls out on
      // its own.
      subIdx: subs.findIndex((t) => t.id === live.sid),
      subSettings,
      subSync,
      updateSubSetting,
      resetSubSettings,
      nudgeSubSync: (delta) => writeSync(Math.round((subSync + delta) * 100) / 100),
      resetSubSync: () => writeSync(null),
      setSubtitleTrack: (i) => {
        const t = subs[i];
        saveJSON(LS.subPref, t ? (t.language || 'und') : 'off');
        return cmd(['set_property', 'sid', t ? t.id : 'no']);
      },
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
  }, [
    cmd, send, live, probe,
    subSettings, subSync, updateSubSetting, resetSubSettings, writeSync,
  ]);

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
            }}>{live.paused ? <IconPlayMark size="1.1em"/> : <IconPause size="0.8em"/>}</PiPBtn>
            <PiPBtn onClick={(e) => { e.stopPropagation(); send('close'); }}><IconX size="0.65em"/></PiPBtn>
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
            buttons, reaching the app as events. NO backing gradient: the scrim
            that used to fade down from the top read as a shadow cast onto the
            picture. */}
        <div
          onMouseDown={(e) => {
            // Empty bar space drags the APP window. Anything interactive keeps
            // its own click: a drag started on a button eats the press.
            if (e.button !== 0 || e.target.closest('button, input, a, [role="button"]')) return;
            send('drag');
          }}
          style={{
          ...fade,
          padding: '14px 24px 32px',
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
            <HeaderBtn onClick={() => send('minimise')} title="Minimize to mini player"><IconCaretDown size="0.7em"/></HeaderBtn>
            <HeaderBtn onClick={() => send('close')} title="Close player"><IconX size="0.65em"/></HeaderBtn>
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

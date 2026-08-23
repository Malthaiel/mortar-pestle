// Native Video Player — the see-through controls layer.
//
// Its own transparent child webview, stacked above the mpv picture (see
// `src-tauri/src/player_host.rs`). It has to be a separate layer because the
// main web layer is opaque: the picture sits ABOVE it, so controls left in the
// main app would be hidden behind the video.
//
// SIZE IS LOAD-BEARING: this webview must be no bigger than the bar it draws.
// A transparent webview occludes the mpv child across its whole rect, even
// where it paints nothing — stretched over the picture, the video disappears.
//
// The bar itself is `VideoControls` VERBATIM. It reads everything from
// `useVideoPlayer()` and takes no props, so rather than fork a parallel bar
// this file supplies the same context from an mpv backend. Every value is READ
// FROM mpv, never modelled here.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { VideoPlayerContext } from '@modules/core/library/VideoPlayerProvider.jsx';
import VideoControls from '@modules/core/library/VideoControls.jsx';

// mpv owns the clock. Poll it rather than running a local timer that drifts
// against real playback.
const POLL_MS = 200;

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

  const cmd = useMemo(
    () => (args) => invoke('player_command', { surface, args }),
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
  }, [cmd]);

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

  // The context VideoControls consumes. mpv track ids are 1-based and the bar
  // indexes into `probe.audio`, so the two are translated at this boundary.
  const value = useMemo(() => {
    const audio = probe?.audio || [];
    const subs = probe?.subtitles || [];
    const dur = Number.isFinite(live.duration) ? live.duration : 0;
    const time = Number.isFinite(live.time) ? live.time : 0;
    return {
      isPlaying: !live.paused,
      duration: dur,
      effectiveTime: time,
      volume: Number.isFinite(live.volume) ? live.volume : 100,
      speed: Number.isFinite(live.speed) ? live.speed : 1,
      probe,
      audioIdx: Math.max(0, audio.findIndex((t) => t.id === live.aid)),
      subIdx: subs.findIndex((t) => t.id === live.sid),
      toggle: () => cmd(['set_property', 'pause', !live.paused]),
      seek: (sec) => cmd(['seek', sec, 'absolute']),
      skip: (delta) => cmd(['seek', delta, 'relative']),
      setVolume: (n) => cmd(['set_property', 'volume', n]),
      setSpeed: (n) => cmd(['set_property', 'speed', n]),
      setAudioTrack: (i) => audio[i] && cmd(['set_property', 'aid', audio[i].id]),
      // Episode stepping, refresh and fullscreen belong to whoever owns the
      // playlist and the window — not to this bar. They go out as one event the
      // main app picks up (Phase 4), rather than inventing commands here that
      // nothing implements yet.
      next: () => emit('player-control', { surface, action: 'next' }),
      prev: () => emit('player-control', { surface, action: 'prev' }),
      refresh: () => emit('player-control', { surface, action: 'refresh' }),
      requestFullscreen: () => emit('player-control', { surface, action: 'fullscreen' }),
    };
  }, [cmd, live, probe, surface]);

  return (
    <VideoPlayerContext.Provider value={value}>
      <div className="video-cinema" style={{
        position: 'fixed', inset: 0, background: 'transparent',
        display: 'flex', alignItems: 'flex-end', padding: '0 12px 8px',
      }}>
        <VideoControls/>
      </div>
    </VideoPlayerContext.Provider>
  );
}

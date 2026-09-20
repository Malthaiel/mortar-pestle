// Native Video Player — the app-side half of the mpv lane.
//
// Replaces <video> for anime playback. What this component actually renders is
// a BLACK RECTANGLE: the picture is an mpv-owned child window stacked above the
// web layer (`src-tauri/src/player_host.rs`), and the controls are their own
// transparent always-on-top window. This div exists only to be MEASURED — its
// live rect is what the picture and the controls are placed against.
//
// Ownership split:
//   • this file   — playlist, position bookkeeping, window geometry, teardown
//   • the overlay — every control the user touches (PlayerControlsView.jsx)
//   • mpv         — decode, seek, tracks, subtitle rendering
//
// Nothing here models mpv's state. Position and duration are READ from mpv on a
// timer; the rect is READ from the DOM. A restated value would be a bug with a
// delay on it.

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useVideoPlayer, LS, loadJSON, saveJSON } from './VideoPlayerProvider.jsx';
import { videoApi } from './api.js';

// One surface id for the whole in-app player. Modal and PiP are the SAME
// picture at a different rect — moved with player_bounds, never reopened — so
// they must not be two surfaces. The pop-out window gets its own id when it
// exists.
const SURFACE = 'modal';

// How often mpv is asked where it is. Only bookkeeping rides on this (resume
// position, mark-watched, end of episode); the controls layer polls mpv itself
// at its own rate, so this can stay slow and cheap.
const POLL_MS = 5000;

// Round to whole pixels before comparing: a fractional rect that jitters by
// 0.001 would re-place two OS windows on every animation frame.
const px = (n) => Math.round(n);

// Every open and close goes through one queue, in the order it was issued.
//
// Rust serialises the two against each other (OPEN_LOCK), but nothing decides
// which of two IN-FLIGHT calls reaches that lock first — that is task
// scheduling, not send order. Changing episode fires close(old) then open(new)
// back to back, so when the open wins the race the late close kills the player
// that just started. Silently: kill_proc drops the pid before the process dies,
// so the supervisor's "was this ours" check says no and never emits
// `player-exit`, leaving a black rectangle with no error on it. Measured
// 2026-08-23: two of three episode changes died this way.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

export default function MpvHost() {
  const v = useVideoPlayer();
  const boxRef = useRef(null);
  const rectRef = useRef(null);      // last rect actually sent
  const openedRef = useRef(null);    // fileAbs currently open in mpv
  const watchedRef = useRef(new Set());
  // Bumped to reopen the SAME file (the refresh button). `startRef` carries the
  // second to reopen at, filled from mpv's own clock rather than from a
  // position this side kept a copy of.
  const [reopenNonce, setReopenNonce] = useState(0);
  const startRef = useRef(null);

  const fileAbs = v.currentEpisode?.fileAbs || null;

  // ── Geometry ────────────────────────────────────────────────────────────
  // The picture and the controls are placed against this div's LIVE rect —
  // measured, never derived from the mode. Both windows take the SAME rect: the
  // controls layer spans the whole picture (verified 2026-08-23 — mpv reported
  // osd-dimensions 1440x900 with a full-size overlay stacked on top, so a
  // transparent top-level window costs the picture nothing).
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const push = () => {
      const r = el.getBoundingClientRect();
      const next = [px(r.x), px(r.y), px(r.width), px(r.height)];
      if (next[2] < 2 || next[3] < 2) return;          // collapsed / hidden
      const prev = rectRef.current;
      if (prev && prev.every((n, i) => n === next[i])) return;
      rectRef.current = next;
      if (!openedRef.current) return;                  // nothing open yet
      const [x, y, w, h] = next;
      invoke('player_bounds', { surface: SURFACE, x, y, w, h }).catch(() => {});
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    // Resizing the app window can MOVE this div without resizing it, and the
    // observer never fires for that.
    window.addEventListener('resize', push);
    return () => { ro.disconnect(); window.removeEventListener('resize', push); };
  });

  // ── Open / switch episode ───────────────────────────────────────────────
  useEffect(() => {
    if (!fileAbs) return;
    let cancelled = false;
    const r = boxRef.current?.getBoundingClientRect();
    const rect = rectRef.current
      || (r ? [px(r.x), px(r.y), px(r.width), px(r.height)] : null);
    if (!rect) return;
    const [x, y, w, h] = rect;
    v.setPreparing(true);
    v.setStreamError(null);
    // A refresh reopens at the position mpv last reported; a fresh episode
    // opens at the resume target playEpisodeAt worked out.
    const start = startRef.current != null
      ? startRef.current
      : (v.resumePosRef?.current || 0);
    startRef.current = null;
    // Queued whole, not just the invoke: the controls window and the restored
    // volume/speed are part of opening, and a close that cut in halfway would
    // tear down a window this is still setting up.
    serial(() => invoke('player_open', {
      surface: SURFACE, path: fileAbs, x, y, w, h, start: String(start),
    }).then(async () => {
      if (cancelled) return;
      openedRef.current = fileAbs;
      // Restore the persisted volume and speed into mpv. They live in the same
      // localStorage keys the old lane used, and the controls layer writes them
      // back — one store, both windows, same origin.
      const vol = Math.min(1, Math.max(0, loadJSON(LS.volume, 0.8)));
      const spd = loadJSON(LS.speed, 1);
      // Controls FIRST: without them the picture is a video with no way to
      // pause it, so a failure here has to be loud, not swallowed.
      await invoke('player_controls_attach', { surface: SURFACE, x, y, w, h });
      const set = (p, val) => invoke('player_command', {
        surface: SURFACE, args: ['set_property', p, val],
      }).catch(() => {});
      await set('volume', Math.round(vol * 100));
      await set('speed', spd);
      if (!cancelled) v.setPreparing(false);
    }).catch((e) => {
      if (cancelled) return;
      v.setPreparing(false);
      v.setStreamError(String(e && e.message ? e.message : e));
    }));
    // Teardown belongs to THIS effect, not a separate mount-scoped one. Closing
    // the player must not leave an mpv decoding a 2 GB file with nothing on
    // screen (one was found alive 50 minutes after its session ended,
    // 2026-08-23) — but a close that fires on its own schedule races the open:
    // React's StrictMode double-invokes effects, so a standalone teardown
    // effect tore down the window the second mount had just built. Paired with
    // the open, the sequence is always open → close → open — and the queue
    // above is what keeps it in that order once it reaches Rust.
    return () => {
      cancelled = true;
      openedRef.current = null;
      serial(() => invoke('player_close', { surface: SURFACE }).catch(() => {}));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileAbs, reopenNonce, v.reloadNonce]);

  // ── Tell the controls layer what is playing ─────────────────────────────
  // It has no provider stack of its own, so the title and the episode line
  // reach it as an event rather than as shared state.
  //
  // Pushed on every change AND on request. The push alone loses the first one:
  // the episode changes before `player_controls_attach` has even built the
  // window, so the layer is not listening yet and the title stayed blank
  // (measured 2026-08-23). The layer asks once it is mounted; this answers.
  const meta = v.currentEpisode && {
    surface: SURFACE,
    mode: v.mode,
    title: (v.series && v.series.title) || '',
    season: v.currentEpisode.seasonName || '',
    n: v.currentEpisode.n,
    episodeTitle: v.currentEpisode.title || '',
    // The subtitle sync offset is saved per episode under this key, and the
    // controls window has no other way to learn which file is playing.
    fileAbs: v.currentEpisode.fileAbs || '',
  };
  const metaRef = useRef(null);
  metaRef.current = meta;

  useEffect(() => {
    if (meta) emit('player-meta', meta).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.currentEpisode, v.series, v.mode]);

  useEffect(() => {
    const un = listen('player-meta-request', () => {
      if (metaRef.current) emit('player-meta', metaRef.current).catch(() => {});
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);

  // ── Controls layer → app ────────────────────────────────────────────────
  // Everything the bar cannot do itself: the playlist, the window, the route.
  useEffect(() => {
    const un = listen('player-control', (e) => {
      const a = e.payload && e.payload.action;
      if (a === 'next') v.next();
      else if (a === 'prev') {
        // Restart the current episode when we are more than 3 s in, else step
        // back one. The provider's own prev() branches on effectiveTime, which
        // is permanently 0 under mpv (nothing writes videoTime any more), so it
        // can only ever step back. Decide here instead, against mpv's real
        // position — this is the only place that owns the live clock.
        invoke('player_command', { surface: SURFACE, args: ['get_property', 'time-pos'] })
          .then((t) => {
            if (Number.isFinite(t) && t > 3) {
              return invoke('player_command', { surface: SURFACE, args: ['seek', 0, 'absolute'] });
            }
            return v.prev();
          })
          .catch(() => v.prev());   // no answer from mpv — step back, as before
      }
      else if (a === 'refresh') {
        // Ask mpv where it is BEFORE killing it, so the restart lands on the
        // same frame. If it cannot answer, it is already wedged — start over.
        invoke('player_command', { surface: SURFACE, args: ['get_property', 'time-pos'] })
          .then((t) => { startRef.current = Number.isFinite(t) ? t : 0; })
          .catch(() => { startRef.current = 0; })
          .finally(() => setReopenNonce((n) => n + 1));
      }
      // The picture is `inset: 0`, so it buries the app's own drag strip
      // (TitleBar.jsx) under an OS window no stacking order in the page can
      // reach — the app could not be dragged at all while a video was open.
      // The bar asks; THIS window drags, because `startDragging` moves the
      // window it is called from and the controls layer is not that window.
      else if (a === 'drag') getCurrentWindow().startDragging().catch(() => {});
      else if (a === 'fullscreen') v.requestFullscreen();
      else if (a === 'close') v.closePlayer();
      else if (a === 'minimise') window.location.hash = '/pulse/today';
      else if (a === 'expand') {
        const p = v.series
          ? v.series.path.split('/').map(encodeURIComponent).join('/')
          : '';
        window.location.hash = '/tools/library/anime/' + p;
      }
    });
    return () => { un.then(f => f()).catch(() => {}); };
  }, [v]);

  // ── mpv died on its own ─────────────────────────────────────────────────
  // Decision 8: say so in plain words. Never fall back silently to the lane
  // this one replaces.
  useEffect(() => {
    const un = listen('player-exit', (e) => {
      if (!e.payload || e.payload.surface !== SURFACE) return;
      openedRef.current = null;
      v.setStreamError('The video player stopped unexpectedly. Press refresh to start it again.');
    });
    return () => { un.then(f => f()).catch(() => {}); };
  }, [v]);

  // ── Bookkeeping: resume position, mark-watched, end of episode ──────────
  useEffect(() => {
    if (!fileAbs) return;
    const id = setInterval(async () => {
      if (!openedRef.current) return;
      let time, dur, eof;
      try {
        [time, dur, eof] = await Promise.all([
          invoke('player_command', { surface: SURFACE, args: ['get_property', 'time-pos'] }),
          invoke('player_command', { surface: SURFACE, args: ['get_property', 'duration'] }),
          invoke('player_command', { surface: SURFACE, args: ['get_property', 'eof-reached'] }),
        ]);
      } catch { return; }               // mpv busy or gone — the next tick retries
      if (!Number.isFinite(time) || !Number.isFinite(dur) || dur <= 0) return;
      const map = loadJSON(LS.progress, {}) || {};
      map[fileAbs] = { time, duration: dur, savedAt: Date.now() };
      saveJSON(LS.progress, map);
      if (time / dur >= 0.9 && !watchedRef.current.has(fileAbs) && v.series) {
        watchedRef.current.add(fileAbs);
        videoApi.markEpisodeWatched(
          v.series.path, v.currentEpisode.n, v.currentEpisode.seasonName || null,
        ).catch(() => {});
      }
      // --keep-open=yes holds the last frame instead of exiting, so the end of
      // an episode is a property, not a process exit.
      if (eof === true) v.next();
    }, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileAbs, v.series, v.currentEpisode]);

  // ── The measured rectangle ──────────────────────────────────────────────
  // Black, because mpv's letterbox bars and this div must read as one surface —
  // the picture is composited above it and never blends with it.
  // Mounted for the whole app session (LibraryRoot), so with nothing playing it
  // draws nothing. Every hook above has already run — this guard is deliberately
  // AFTER them.
  if (!v.playerOpen) return null;

  const modal = v.mode !== 'pip';
  // Also the provider's fullscreen target: going fullscreen grows this div to
  // the screen, the observer above sees the new rect, and the picture and the
  // controls follow it. Nothing has to know a fullscreen size in advance.
  const setBox = (el) => {
    boxRef.current = el;
    if (v.fullscreenHostRef) v.fullscreenHostRef.current = el;
  };
  return (
    <div
      ref={setBox}
      className="video-cinema"
      style={modal
        ? { position: 'fixed', inset: 0, background: '#000', zIndex: 1500 }
        : {
            position: 'fixed', right: 312, bottom: 16,
            width: 280, height: 158, background: '#000',
            zIndex: 1400, overflow: 'hidden',
          }}
    >
      {v.streamError && (
        <div className="candy-panel" style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          maxWidth: 520, padding: '20px 24px',
          color: 'var(--text)', fontFamily: 'var(--font-mono)',
          fontSize: 13, lineHeight: 1.5, zIndex: 1700,
        }}>
          <div style={{
            color: 'rgba(255,120,120,0.95)', fontSize: 11,
            letterSpacing: '0.08em', marginBottom: 8,
          }}>Playback failed</div>
          <div style={{ wordBreak: 'break-word' }}>{v.streamError}</div>
        </div>
      )}
    </div>
  );
}

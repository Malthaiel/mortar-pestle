// usePlaybackEngine (SF9) — sequence playback over the two permanent <video>
// elements. Swap design (evolved from the SF1 spike at the SF9 gate):
//
//   FLIP-THEN-PLAY. The muted standby pre-seeks to the next segment's
//   in-point mid-segment, so its EXACT first frame is already decoded and
//   composited at opacity 0.0001. At the boundary the flip is one synchronous
//   style+audio write (instant, frame-exact); play() is called right after,
//   and the pipeline's start-up latency (~75 ms measured) shows as a brief
//   motion-hold on the CORRECT incoming frame — not a stall on the outgoing
//   one. Gate-measured failures that shaped this: pausing the outgoing at the
//   boundary corks its PipeWire sink (~220 ms stall); leaving it playing
//   into end-of-stream makes the NEXT prep seek hang (~2 s — EOS pipelines
//   re-seek unreliably, so prep reloads ended elements); waiting for the
//   standby's first frame advance BEFORE flipping burned 30 ms of rAF ticks
//   + the start-up latency as a visible freeze.
//
//   The outgoing element is muted at the boundary (cheap volume op), keeps
//   playing hidden through the flip, and is paused by the DEFERRED prep
//   (350 ms later, off the critical path). Late path (standby not ready at
//   t1): outgoing pauses to hold its last frame and the flip fires the
//   moment prep completes (counted late).
//
// rVFC never fires on WebKitGTK (SF1): frame advance is observed by the rAF
// loop sampling currentTime. Time model: segments carry seconds; seconds
// advance 1:1 across domains at rate 1, so seqTime = t0 + (currentTime -
// srcIn). All state lives in refs — ONE rAF loop, zero per-frame React
// state; onTick fans time out and the caller decides what re-renders.

import { useCallback, useEffect, useRef, useState } from 'react';

// SF7c — WebView2 (Windows/Chromium) needs none of the WebKitGTK video workarounds
// below; gate them off there. Exact-form `import.meta.env.VITE_TARGET_OS` so the prod
// build folds the dead branch.
const IS_WEBVIEW2 = import.meta.env.VITE_TARGET_OS === 'windows';

const VIS = (el, on) => {
  if (!el) return;
  // WebKitGTK culls the video pipeline at opacity:0, so it parks at 0.0001 (never 0);
  // WebView2 doesn't cull, so 0 is both correct and truly invisible (SF7c).
  el.style.opacity = on ? '1' : (IS_WEBVIEW2 ? '0' : '0.0001');
  el.style.zIndex = on ? '2' : '1';
};

export default function usePlaybackEngine({ vidA, vidB, enabled, segments, urlFor, graph, trackParams, onTick }) {
  const segsRef = useRef(segments);
  segsRef.current = segments;
  const urlForRef = useRef(urlFor);
  urlForRef.current = urlFor;
  // Audio Post SF1a: the Web Audio mixer is the sole volume authority. Held in
  // a ref so the API's render identity never churns the rAF-loop effects.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  // SF3: resolve a segment's track → { volume, pan, audible } for its mixer
  // chain (ref'd to keep the loop effects stable).
  const trackParamsRef = useRef(trackParams);
  trackParamsRef.current = trackParams;
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);

  const st = useRef({
    activeKey: 'a',
    playing: false,
    rate: 1,
    segIdx: -1,
    t: 0,
    gapClock: 0,
    prepped: { segIdx: -1, ready: false },
    pendingSwap: null, // LATE path only: { i2, boundaryWall }
    playWatch: null,   // { baseline, startedWall } on the fresh active — motion detection
    prepAfterMotion: null, // segIdx whose successor preps once motion starts
    prepTimer: 0,
    seekBusy: false,
    pendingSeek: null,
    stats: { swaps: 0, late: 0, worst: 0, worstPlay: 0 },
    raf: 0,
  });

  const active = () => (st.current.activeKey === 'a' ? vidA.current : vidB.current);
  const standby = () => (st.current.activeKey === 'a' ? vidB.current : vidA.current);
  const end = () => {
    const segs = segsRef.current;
    return segs.length ? segs[segs.length - 1].t1 : 0;
  };

  // SF1a/SF3: route the active segment's clip gain + its TRACK fader/pan to the
  // active element's chain. No element-volume write — that double-applied
  // against the clip node and clamped +gain at the 1.0 ceiling.
  const applyVolume = useCallback(() => {
    const seg = segsRef.current[st.current.segIdx];
    const g = graphRef.current;
    if (!seg || !g) return;
    g.setElementGain(st.current.activeKey, seg.gain ?? 1);
    g.setElementTrack(st.current.activeKey, seg.trackId, trackParamsRef.current?.(seg.trackId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nextMediaIdx = (from) => {
    const segs = segsRef.current;
    for (let i = from; i < segs.length; i++) if (segs[i].mediaId) return i;
    return -1;
  };

  // Pre-seek the standby (muted, paused) to segment i's in-point. EOS-safe:
  // an ended pipeline re-seeks unreliably on WebKitGTK, so it reloads its src
  // to re-preroll instead. The pause cork (~200 ms PipeWire drain) is fine
  // HERE because prep runs mid-segment, off the swap's critical path.
  const prepStandby = useCallback((i) => {
    const s = st.current;
    const seg = segsRef.current[i];
    s.prepped = { segIdx: i, ready: false };
    if (!seg?.mediaId) return;
    const sb = standby();
    if (!sb) return;
    const url = urlForRef.current(seg.mediaId);
    if (!url) return;
    const onSeeked = () => {
      if (s.prepped.segIdx === i) s.prepped.ready = true;
    };
    const seekIt = () => {
      if (s.prepped.segIdx !== i) return;
      sb.addEventListener('seeked', onSeeked, { once: true });
      sb.currentTime = seg.srcIn;
    };
    sb.muted = true;
    try { sb.pause(); } catch {}
    if (sb.dataset.url !== url) {
      sb.dataset.url = url;
      sb.addEventListener('loadeddata', seekIt, { once: true });
      sb.src = url;
      sb.load();
    } else if (sb.ended) {
      // WebKitGTK re-seeks an ended pipeline unreliably, so it reloads the src to
      // re-preroll; WebView2/Chromium re-seeks an ended <video> reliably, so seek
      // directly and skip the reload churn (SF7c).
      if (IS_WEBVIEW2) {
        seekIt();
      } else {
        sb.addEventListener('loadeddata', seekIt, { once: true });
        sb.load();
      }
    } else {
      seekIt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The boundary handler: ONE synchronous flip — opacity + audio handoff —
  // then play(). The cut is instant and frame-exact; pipeline start-up shows
  // as a short motion-hold on the incoming frame (tracked as worstPlay).
  const flipTo = useCallback((i2, now, boundaryWall, wasLate) => {
    const s = st.current;
    const seg = segsRef.current[i2];
    const sb = standby();
    const act = active();
    if (!sb || !seg) return;
    VIS(sb, true);
    VIS(act, false);
    if (act) act.muted = true;
    // Incoming element becomes active (activeKey flips below): set its clip
    // gain + track fader/pan chain.
    const inKey = s.activeKey === 'a' ? 'b' : 'a';
    graphRef.current?.setElementGain(inKey, seg.gain ?? 1);
    graphRef.current?.setElementTrack(inKey, seg.trackId, trackParamsRef.current?.(seg.trackId));
    sb.muted = false;
    if (sb.playbackRate !== s.rate) sb.playbackRate = s.rate; // rate writes flush — only when it differs
    sb.play().catch(() => {});
    s.activeKey = s.activeKey === 'a' ? 'b' : 'a';
    s.segIdx = i2;
    s.t = seg.t0;
    s.pendingSwap = null;
    s.playWatch = { baseline: sb.currentTime, startedWall: now };
    const lat = now - boundaryWall;
    s.stats.swaps += 1;
    s.stats.worst = Math.max(s.stats.worst, lat);
    if (wasLate) s.stats.late += 1;
    console.info('[vedit-swap]', `flip ${lat.toFixed(0)} ms${wasLate ? ' LATE' : ''}`);
    // Prep the next segment as soon as the fresh pipeline's motion starts
    // (~90 ms — the earliest point where pausing/corking the old element
    // can't stall a state change). The timer is only a fallback in case
    // motion detection never fires.
    s.prepAfterMotion = i2;
    clearTimeout(s.prepTimer);
    s.prepTimer = setTimeout(() => {
      if (s.prepAfterMotion === i2) {
        s.prepAfterMotion = null;
        prepStandby(nextMediaIdx(i2 + 1));
      }
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepStandby]);

  const beginBoundary = useCallback((now) => {
    const s = st.current;
    const segs = segsRef.current;
    const i2 = s.segIdx + 1;
    if (i2 >= segs.length) { // end of program
      s.playing = false;
      setPlaying(false);
      s.t = end();
      try { active()?.pause(); } catch {}
      onTickRef.current?.(s.t);
      return;
    }
    const seg2 = segs[i2];
    if (!seg2.mediaId) { // gap: hide both, wall-clock time
      const act = active();
      try { act?.pause(); } catch {}
      VIS(act, false);
      VIS(standby(), false);
      s.segIdx = i2;
      s.t = seg2.t0;
      s.gapClock = now;
      if (s.prepped.segIdx !== nextMediaIdx(i2 + 1)) prepStandby(nextMediaIdx(i2 + 1));
      return;
    }
    // media → media
    if (s.prepped.segIdx === i2 && s.prepped.ready) {
      flipTo(i2, now, now, false);
    } else {
      // Late: hold the outgoing's last frame until prep completes.
      const act = active();
      if (act) act.muted = true;
      try { act?.pause(); } catch {}
      s.pendingSwap = { i2, boundaryWall: now };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepStandby, flipTo]);

  // ONE rAF loop drives playback, late-swap completion, and gap time.
  useEffect(() => {
    if (!enabled) return undefined;
    const s = st.current;
    const loop = (now) => {
      const segs = segsRef.current;
      if (s.playing) {
        if (s.pendingSwap) {
          if (s.prepped.segIdx === s.pendingSwap.i2 && s.prepped.ready) {
            flipTo(s.pendingSwap.i2, now, s.pendingSwap.boundaryWall, true);
          }
        } else {
          const seg = segs[s.segIdx];
          if (!seg) {
            s.playing = false;
            setPlaying(false);
          } else if (seg.mediaId) {
            const el = active();
            if (el) {
              if (s.playWatch && el.currentTime > s.playWatch.baseline + 1e-4) {
                s.stats.worstPlay = Math.max(s.stats.worstPlay, now - s.playWatch.startedWall);
                s.playWatch = null;
                if (s.prepAfterMotion != null) {
                  const after = s.prepAfterMotion;
                  s.prepAfterMotion = null;
                  clearTimeout(s.prepTimer);
                  prepStandby(nextMediaIdx(after + 1));
                }
              }
              const t = seg.t0 + (el.currentTime - seg.srcIn);
              s.t = Math.min(Math.max(t, seg.t0), seg.t1);
              if (el.currentTime >= seg.srcOut - 0.0008 || el.ended || t >= seg.t1) {
                beginBoundary(now);
              }
            }
          } else { // gap
            s.t += ((now - s.gapClock) / 1000) * s.rate;
            s.gapClock = now;
            if (s.t >= seg.t1) {
              s.t = seg.t1;
              beginBoundary(now);
            }
          }
        }
        onTickRef.current?.(st.current.t);
      }
      s.raf = requestAnimationFrame(loop);
    };
    s.raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(s.raf);
  }, [enabled, beginBoundary, flipTo]);

  // Freshest-wins seek (SF5 throttle pattern): position the active element
  // for sequence time t, switching its src when the segment's media differs.
  const seekTo = useCallback((t) => {
    const s = st.current;
    const segs = segsRef.current;
    if (!segs.length) return;
    const clamped = Math.max(0, Math.min(t, end() - 1e-4));
    if (s.seekBusy) { s.pendingSeek = clamped; return; }
    const i = segs.findIndex(g => clamped >= g.t0 && clamped < g.t1);
    if (i === -1) return;
    const seg = segs[i];
    s.pendingSwap = null;
    s.playWatch = null;
    s.prepAfterMotion = null;
    clearTimeout(s.prepTimer);
    s.segIdx = i;
    s.t = clamped;
    onTickRef.current?.(s.t);
    if (!seg.mediaId) { // gap: black
      VIS(active(), false);
      VIS(standby(), false);
      if (s.playing) s.gapClock = performance.now();
      prepStandby(nextMediaIdx(i + 1));
      return;
    }
    const el = active();
    if (!el) return;
    const url = urlForRef.current(seg.mediaId);
    if (!url) return;
    const off = seg.srcIn + (clamped - seg.t0);
    const finish = () => {
      s.seekBusy = false;
      applyVolume();
      if (s.playing && el.paused) {
        if (el.playbackRate !== s.rate) el.playbackRate = s.rate;
        el.play().catch(() => {});
      }
      if (s.pendingSeek != null) {
        const nxt = s.pendingSeek;
        s.pendingSeek = null;
        seekTo(nxt);
      }
    };
    s.seekBusy = true;
    if (el.dataset.url !== url) {
      el.dataset.url = url;
      el.addEventListener('loadeddata', () => {
        el.addEventListener('seeked', finish, { once: true });
        el.currentTime = off;
      }, { once: true });
      el.src = url;
      el.load();
    } else if (el.ended) {
      el.addEventListener('loadeddata', () => {
        el.addEventListener('seeked', finish, { once: true });
        el.currentTime = off;
      }, { once: true });
      el.load();
    } else {
      el.addEventListener('seeked', finish, { once: true });
      el.currentTime = off;
    }
    VIS(el, true);
    VIS(standby(), false);
    el.muted = false;
    prepStandby(nextMediaIdx(i + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepStandby, applyVolume]);

  const play = useCallback(() => {
    const s = st.current;
    const segs = segsRef.current;
    if (!segs.length) return;
    graphRef.current?.ensure(); // create/resume the mixer on this play gesture
    if (s.t >= end() - 1e-4) s.t = 0; // replay from the top
    if (s.segIdx === -1 || !segs[s.segIdx] || !(s.t >= segs[s.segIdx].t0 && s.t < segs[s.segIdx].t1)) {
      seekTo(s.t);
    }
    const seg = segs[st.current.segIdx];
    s.playing = true;
    setPlaying(true);
    if (seg?.mediaId) {
      const el = active();
      if (el) {
        if (el.playbackRate !== s.rate) el.playbackRate = s.rate;
        applyVolume();
        el.muted = false;
        el.play().catch(() => {});
      }
    } else {
      s.gapClock = performance.now();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTo, applyVolume]);

  const pause = useCallback(() => {
    const s = st.current;
    s.playing = false;
    setPlaying(false);
    try { active()?.pause(); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(() => {
    (st.current.playing ? pause : play)();
  }, [play, pause]);

  const setRate = useCallback((r) => {
    st.current.rate = r;
    setRateState(r);
    const el = active();
    if (el) el.playbackRate = r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetStats = useCallback(() => {
    st.current.stats = { swaps: 0, late: 0, worst: 0, worstPlay: 0 };
  }, []);

  // Hard reset when leaving sequence mode or the segment list empties.
  useEffect(() => {
    if (enabled) return undefined;
    const s = st.current;
    s.playing = false;
    s.segIdx = -1;
    s.t = 0;
    s.pendingSwap = null;
    s.playWatch = null;
    s.prepAfterMotion = null;
    s.prepped = { segIdx: -1, ready: false };
    clearTimeout(s.prepTimer);
    setPlaying(false);
    return undefined;
  }, [enabled]);

  useEffect(() => () => clearTimeout(st.current.prepTimer), []);

  return {
    playing,
    rate,
    play,
    pause,
    toggle,
    seekTo,
    setRate,
    resetStats,
    stats: () => ({ ...st.current.stats }),
    timeRef: () => st.current.t,
    segIdxRef: () => st.current.segIdx, // SF3 grade lookup: which segment is the picture
  };
}

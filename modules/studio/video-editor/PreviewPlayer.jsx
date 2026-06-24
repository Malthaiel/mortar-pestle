// Preview (Projection Booth): a PERMANENT dark room — near-black in both
// themes, like a grading monitor — the video floats with a soft vignette and
// zero chrome; the candy transport island + blooming groove rail sit below.
// Surrounding panes follow the app theme; this pane deliberately does not.
//
// Two <video> elements are permanently in the DOM and composited; visibility
// flips via opacity/z-index ONLY (hidden = opacity 0.0001, NEVER 0 or
// display:none — WebKitGTK culls/throttles fully hidden pipelines; SF1
// finding). Manual style writes survive React re-renders because React diffs
// style vdom-vs-vdom, and the rendered values never change.
//
// TWO MODES (SF9): with timeline clips present, the pane plays the SEQUENCE
// via usePlaybackEngine (flattened segments; bin selection no longer drives
// the picture); with an empty timeline it is the SF5 single-clip source
// preview. rVFC is dead on this platform (SF1): readouts are rAF samplers
// over currentTime, and frame-steps trust the accurate seek target.

import { useCallback, useEffect, useRef, useState } from 'react';
import TransportBar from './TransportBar.jsx';
import usePlaybackEngine from './usePlaybackEngine.js';
import useMixerGraph from './audio/mixerGraph.js';
import { resolveTrackParams } from './audio/mix.js';
import useGlDisplay from './color/useGlDisplay.js';
import useCompositeLayers from './useCompositeLayers.js';
import { drawTitle } from './drawTitle.js';
import { getLutFor, gradeDraft } from './color/gradePipeline.js';
import TransformHandles from './TransformHandles.jsx';
import { xformDraft } from './transformDraft.js';
import { transformAtFrame, evaluate } from './keyframes/engine.js';

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function setVisible(el, on) {
  el.style.opacity = on ? '1' : '0.0001';
  el.style.zIndex = on ? '2' : '1';
}

export default function PreviewPlayer({
  url, fps, accent,
  segments, compositeRegions, urlFor, seqFps, seqW, seqH, masterVolume, onMasterVolume, onPlayheadTime,
  controlsRef, gradeBypass, mixer, audioRef, selectedClipId, onSetTransform,
}) {
  const vidA = useRef(null);
  const vidB = useRef(null);
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const activeKey = useRef('a'); // source-mode active element
  const seekState = useRef({ inFlight: false, pending: null });
  const scrubRef = useRef(false);
  const railRef = useRef(null);
  const [playing, setPlaying] = useState(false); // source-mode play state
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);   // source-mode duration
  const [railHot, setRailHot] = useState(false);
  const [benchText, setBenchText] = useState('');

  const seqMode = (segments?.length || 0) > 0;
  const seqEnd = seqMode ? segments[segments.length - 1].t1 : 0;

  const onTickRef = useRef(null);
  onTickRef.current = (t) => {
    setTime(prev => (Math.abs(prev - t) > 0.0005 ? t : prev));
    onPlayheadTime?.(t);
    // SF8 clip-gain automation: push the kf-evaluated gain to the playing
    // element's chain each frame (idempotent setValueAtTime → no churn for
    // non-keyframed clips, which are skipped by the guard). Track-volume
    // automation is authored (MixSuite) + exported (SF9) but NOT previewed live
    // — per-frame fader re-apply risks EQ clicks; documented in the Update Queue.
    const seg = segmentsRef.current?.[engine.segIdxRef ? engine.segIdxRef() : -1];
    if (seg && seg.kf && seg.kf.gain) {
      const el = [vidA.current, vidB.current].find(e => e && e.style.opacity === '1' && e.videoWidth > 0);
      if (el) graph.setElementGain(el === vidA.current ? 'a' : 'b', evaluate(seg.kf.gain, Math.round(t * seqFps)));
    }
  };

  // Audio Post SF1a/SF3: the Web Audio mixer graph, owned here (the two <video>
  // elements + the engine live here and persist across mode switches). It is
  // the sole volume authority — el.volume is no longer written.
  const graph = useMixerGraph({ vidA, vidB });
  useEffect(() => { graph.setMaster(masterVolume); }, [masterVolume, graph]);

  // SF3: resolve a track's preview params from the live mixer (ref'd so the
  // engine's loop callbacks never churn on it).
  const mixerRef = useRef(mixer);
  mixerRef.current = mixer;
  const trackParamsFor = useCallback((trackId) => resolveTrackParams(mixerRef.current, trackId), []);

  // Push committed mixer changes (faders/pan/mute/solo, undo/redo) to the live
  // graph; setTrackLive updates whichever element is currently playing each
  // track. Drags preview imperatively via audioRef during the gesture.
  useEffect(() => {
    if (!mixer) return;
    for (const id of Object.keys(mixer.tracks || {})) graph.setTrackLive(id, resolveTrackParams(mixer, id));
    graph.setMasterEq(mixer.master?.eq || null);
    graph.setMasterComp(mixer.master?.comp || null);
  }, [mixer, graph]);

  // Imperative surface for the Mix-mode strips (live fader/pan/master during a
  // drag, before the op commits).
  useEffect(() => {
    if (!audioRef) return undefined;
    audioRef.current = {
      setTrackLive: (id, params) => graph.setTrackLive(id, params),
      setMaster: (v) => graph.setMaster(v),
      setMasterEq: (eq) => graph.setMasterEq(eq),
      setMasterComp: (c) => graph.setMasterComp(c),
      meter: () => graph.meter(),
      analyser: () => graph.analyser(),
    };
    return () => { audioRef.current = null; };
  }, [audioRef, graph]);

  const engine = usePlaybackEngine({
    vidA, vidB,
    enabled: seqMode,
    segments,
    urlFor,
    graph,
    trackParams: trackParamsFor,
    onTick: (t) => onTickRef.current(t),
  });

  // Always-on WebGL2 display (Color Grading SF1): the canvas composites the
  // active <video> each rAF tick; when GL is unavailable the canvas is absent
  // and the videos underneath are the display, exactly the pre-canvas tree.
  //
  // Grade lookup (SF3): the engine's segIdx names the picture's segment, the
  // segment carries its clip's grade (flattenEditList), gradePipeline maps
  // grade → compiled LUT. Ref-fed and repopulated every render so the
  // mount-once GL loop never reads stale segments. Source mode previews
  // ungraded by design (grades are timeline-clip properties).
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const bypassRef = useRef(false);
  bypassRef.current = !!gradeBypass;
  const getLutRef = useRef(null);
  getLutRef.current = () => {
    if (!seqMode) return null;
    if (bypassRef.current) return null; // SF10 bypass: ungraded preview, drafts included
    const seg = segmentsRef.current[engine.segIdxRef()];
    if (!seg) return null;
    // Gesture drafts (SF7) override the committed grade for their clip —
    // checked per tick, so wheel drags hit the GL path with no React render.
    const g = gradeDraft.clipId && gradeDraft.clipId === seg.clipId ? gradeDraft.grade : seg.grade;
    return g ? getLutFor(g) : null;
  };
  // SF4 compositing: the active segment's clip transform (null = identity →
  // render() path). Rides flattenEditList exactly like grade; reassigned every
  // render so the mount-once GL loop reads fresh seq dims + transform per tick.
  const getXformRef = useRef(null);
  getXformRef.current = () => {
    if (!seqMode) return null;
    const seg = segmentsRef.current[engine.segIdxRef()];
    if (!seg) return null;
    // SF6: a live handle gesture overrides per tick. SF8: otherwise evaluate the
    // clip's keyframes at the playhead (a clip with kf but no static transform
    // still routes here — transformAtFrame returns the animated transform).
    if (xformDraft.clipId && xformDraft.clipId === seg.clipId) {
      return xformDraft.transform ? { transform: xformDraft.transform, seqW, seqH } : null;
    }
    const frame = Math.round((engine.timeRef ? engine.timeRef() : 0) * seqFps);
    const tr = transformAtFrame(seg.transform, seg.kf, frame);
    if (!tr) return null;
    return { transform: tr, seqW, seqH };
  };

  // SF5 multi-layer compositor feed. The engine still plays the TOPMOST layer;
  // useCompositeLayers manages the underlay elements (the region's layers minus
  // the top). getCompositeRef assembles [underlays…, engine-top] for
  // renderComposite, or null when there are no underlays (→ single-layer path
  // unchanged). gradeDraft/xformDraft overrides apply to the topmost just like
  // the single-layer path.
  const compositeRegionsRef = useRef(compositeRegions);
  compositeRegionsRef.current = compositeRegions;
  const enginePlayingRef = useRef(false);
  enginePlayingRef.current = engine.playing;
  const compInputRef = useRef(null);
  compInputRef.current = () => {
    const t = engine.timeRef ? engine.timeRef() : 0;
    const region = (compositeRegionsRef.current || []).find(r => t >= r.t0 && t < r.t1) || null;
    return { region, time: t, playing: enginePlayingRef.current, urlFor, seqFps };
  };
  const underlaysRef = useCompositeLayers(compInputRef);
  // Title canvases for the compositor, cached per clipId and re-rastered ONLY
  // when the title model reference changes (drawTitle is deterministic; setTitle
  // mints a new ref on edit) — playback never re-rasterizes. (Compositing SF10)
  const titleCacheRef = useRef(new Map());
  const getCompositeRef = useRef(null);
  getCompositeRef.current = () => {
    if (!seqMode) return null;
    const t = engine.timeRef ? engine.timeRef() : 0;
    const region = (compositeRegionsRef.current || []).find(r => t >= r.t0 && t < r.t1) || null;
    if (!region || !region.layers.length) return null;
    const hasTitle = region.layers.some(l => l.kind === 'title' && l.title);
    const mediaLayers = region.layers.filter(l => l.mediaId);
    // Single media layer with no title → leave the proven single-element
    // render() path untouched (a no-overlap, title-free project returns null
    // here, so that path stays byte-identical).
    if (mediaLayers.length <= 1 && !hasTitle) return null;
    const frame = Math.round(t * seqFps);
    const unders = underlaysRef.current ? underlaysRef.current() : [];
    const underById = new Map(unders.map(u => [u.clipId, u]));
    const topEl = [vidA.current, vidB.current].find(el => el && el.style.opacity === '1' && el.videoWidth > 0);
    const topMediaId = mediaLayers.length ? mediaLayers[mediaLayers.length - 1].clipId : null;
    // SF6/SF8: a live handle gesture overrides per tick; else evaluate keyframes
    // at the playhead frame (transformAtFrame returns the static transform when
    // the layer has no kf).
    const txOf = (l) => (xformDraft.clipId === l.clipId)
      ? xformDraft.transform
      : transformAtFrame(l.transform, l.kf, frame);
    const live = new Set();
    const layers = [];
    for (const l of region.layers) {                          // bottom → top
      if (l.kind === 'title' && l.title) {
        live.add(l.clipId);
        let entry = titleCacheRef.current.get(l.clipId);
        if (!entry || entry.title !== l.title) {
          entry = { title: l.title, canvas: drawTitle(l.title, 1) };
          titleCacheRef.current.set(l.clipId, entry);
        }
        layers.push({ el: entry.canvas, transform: txOf(l) || null, lut: null, isTitle: true });
      } else if (l.mediaId) {
        if (l.clipId === topMediaId && topEl) {
          const g = (gradeDraft.clipId === l.clipId) ? gradeDraft.grade : l.grade;
          layers.push({ el: topEl, transform: txOf(l) || null, lut: g ? getLutFor(g) : null });
        } else {
          const u = underById.get(l.clipId);
          if (u) layers.push({ el: u.el, transform: u.transform || null, lut: u.grade ? getLutFor(u.grade) : null });
        }
      }
    }
    // Free canvases for titles no longer in the active region.
    for (const id of titleCacheRef.current.keys()) if (!live.has(id)) titleCacheRef.current.delete(id);
    if (!layers.length) return null;
    return { layers, seqW, seqH };
  };
  const { glOk } = useGlDisplay({ stageRef, canvasRef, vidA, vidB, getLutRef, getXformRef, getCompositeRef });

  const active = () => (activeKey.current === 'a' ? vidA.current : vidB.current);
  const standby = () => (activeKey.current === 'a' ? vidB.current : vidA.current);

  // Mode switch: hard-reset both elements so source/sequence logic never
  // fights over them; entering sequence mode shows the first program frame.
  useEffect(() => {
    for (const el of [vidA.current, vidB.current]) {
      if (!el) continue;
      try { el.pause(); } catch {}
      el.removeAttribute('src');
      delete el.dataset.url;
      try { el.load(); } catch {}
    }
    activeKey.current = 'a';
    seekState.current = { inFlight: false, pending: null };
    setPlaying(false);
    setTime(0);
    setDuration(0);
    if (seqMode) engine.seekTo(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seqMode]);

  // Paused edits restructure the program: re-derive segment + picture for the
  // current time against the fresh edit list.
  useEffect(() => {
    if (seqMode && !engine.playing) engine.seekTo(engine.timeRef());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments]);

  // ── Source mode (SF5): clip switch via the standby, flip on loadeddata ──
  useEffect(() => {
    if (seqMode) return undefined;
    const sb = standby();
    const act = active();
    if (!url || !sb) return undefined;
    let cancelled = false;
    const onReady = () => {
      if (cancelled) return;
      setVisible(sb, true);
      setVisible(act, false);
      try { act.pause(); } catch {}
      try { act.removeAttribute('src'); act.load(); } catch {}
      activeKey.current = activeKey.current === 'a' ? 'b' : 'a';
      seekState.current = { inFlight: false, pending: null };
      setDuration(sb.duration || 0);
      setTime(0);
      setPlaying(false);
    };
    sb.addEventListener('loadeddata', onReady, { once: true });
    sb.src = url;
    sb.load();
    return () => {
      cancelled = true;
      sb.removeEventListener('loadeddata', onReady);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, seqMode]);

  // Source-mode rAF readout sampler (rVFC unavailable).
  useEffect(() => {
    if (seqMode) return undefined;
    let raf;
    const loop = () => {
      const el = active();
      if (el) {
        const t = el.currentTime || 0;
        setTime(prev => (Math.abs(prev - t) > 0.0005 ? t : prev));
        const d = el.duration || 0;
        setDuration(prev => (d && Math.abs(prev - d) > 0.01 ? d : prev));
        if (el.ended) setPlaying(p => (p ? false : p));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seqMode]);

  const togglePlay = () => {
    if (seqMode) { engine.toggle(); return; }
    const el = active();
    if (!el || !el.src) return;
    if (el.paused) {
      // Source mode also routes through the mixer once it exists: unity clip
      // gain on the active element (master applies via the shared node).
      graph.ensure();
      graph.setElementGain(activeKey.current, 1);
      el.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  // Frame-step. Sequence mode steps the program clock; source mode the clip.
  // (n+0.5)/fps addressing keeps floor(t·fps) drift-safe; WebKitGTK seeks are
  // always accurate (decode-to-time).
  const step = (dir) => {
    if (seqMode) {
      engine.pause();
      const f = Math.max(0, Math.floor(time * seqFps + 1e-6) + dir);
      engine.seekTo(Math.min((f + 0.5) / seqFps, Math.max(0, seqEnd - 0.001)));
      return;
    }
    const el = active();
    if (!el || !el.src) return;
    const f = fps && fps > 0 ? fps : 30;
    el.pause();
    setPlaying(false);
    const cur = Math.floor((el.currentTime || 0) * f + 1e-6);
    const target = Math.max(0, cur + dir);
    const t = Math.min((target + 0.5) / f, Math.max(0, (el.duration || 0) - 0.001));
    queueSeek(t);
  };

  // ONE in-flight accurate seek; freshest pending target wins (source mode —
  // the engine carries its own identical throttle for sequence seeks).
  const queueSeek = (t) => {
    const el = active();
    if (!el || !el.src) return;
    const s = seekState.current;
    if (s.inFlight) {
      s.pending = t;
      return;
    }
    s.inFlight = true;
    const onSeeked = () => {
      s.inFlight = false;
      if (s.pending != null) {
        const next = s.pending;
        s.pending = null;
        queueSeek(next);
      }
    };
    el.addEventListener('seeked', onSeeked, { once: true });
    try {
      el.currentTime = t;
    } catch {
      el.removeEventListener('seeked', onSeeked);
      s.inFlight = false;
    }
  };

  const shownDuration = seqMode ? seqEnd : duration;
  const ratioFromEvent = (e) => {
    const r = railRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const railSeek = (ratio) => {
    if (seqMode) engine.seekTo(ratio * seqEnd);
    else queueSeek(ratio * duration);
  };
  const onRailDown = (e) => {
    if (!shownDuration) return;
    if (!seqMode && !active()?.src) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubRef.current = true;
    setRailHot(true);
    railSeek(ratioFromEvent(e));
  };
  const onRailMove = (e) => {
    if (!scrubRef.current) return;
    railSeek(ratioFromEvent(e));
  };
  const onRailUp = () => {
    scrubRef.current = false;
    setRailHot(false);
  };

  // Dev-only scrub benchmark (source mode): 30 random accurate seeks;
  // seek-to-paint = `seeked` + one rAF tick (totalVideoFrames is dead on
  // paused seeks — SF1/SF5 findings).
  const runBench = import.meta.env.DEV && !seqMode
    ? async () => {
        const el = active();
        if (!el || !el.src || !duration) return;
        el.pause();
        setPlaying(false);
        setBenchText('benching…');
        const samples = [];
        for (let i = 0; i < 30; i++) {
          const t = Math.random() * Math.max(0.5, duration - 0.5);
          // eslint-disable-next-line no-await-in-loop
          const ms = await new Promise((res) => {
            const t0 = performance.now();
            const onSeeked = () => {
              requestAnimationFrame(() => res(performance.now() - t0));
            };
            el.addEventListener('seeked', onSeeked, { once: true });
            el.currentTime = t;
          });
          samples.push(ms);
        }
        const med = median(samples);
        const p95 = [...samples].sort((a, b) => a - b)[Math.min(28, samples.length - 1)];
        const txt = `median ${med.toFixed(0)} ms · p95 ${p95.toFixed(0)} ms · n=${samples.length}`;
        setBenchText(txt);
        console.info('[scrub-bench]', txt, samples.map(s => +s.toFixed(1)));
      }
    : null;

  // Dev-only swap stats (sequence mode): worst boundary latency + late count
  // since the last reset — the SF9 ≤50 ms re-verification numbers.
  const onSwapStats = import.meta.env.DEV && seqMode
    ? () => {
        const s = engine.stats();
        setBenchText(`swaps ${s.swaps} · worst flip ${s.worst.toFixed(0)} ms · motion ${s.worstPlay.toFixed(0)} ms · late ${s.late}`);
      }
    : null;

  const cycleRate = () => {
    const next = { 1: 2, 2: 4, 4: 1 }[engine.rate] || 1;
    engine.setRate(next);
  };

  // Imperative surface for the module keybinds + ruler scrub (SF11) — a plain
  // ref prop, matching the module's playheadFrameRef idiom (no forwardRef).
  // Repopulated every render so the closures never go stale.
  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      toggle: togglePlay,
      step,
      pause: () => {
        if (seqMode) { engine.pause(); return; }
        const el = active();
        if (el && el.src) { el.pause(); setPlaying(false); }
      },
      cycleRate: () => { if (seqMode) cycleRate(); },
      jumpBy: (s) => {
        if (seqMode) {
          engine.seekTo(Math.max(0, Math.min(engine.timeRef() + s, Math.max(0, seqEnd - 0.001))));
          return;
        }
        const el = active();
        if (el && el.src) queueSeek(Math.max(0, Math.min((el.currentTime || 0) + s, Math.max(0, (el.duration || 0) - 0.001))));
      },
      seekTo: (t) => {
        if (seqMode) { engine.seekTo(Math.max(0, Math.min(t, Math.max(0, seqEnd - 0.001)))); return; }
        const el = active();
        if (el && el.src) queueSeek(Math.max(0, Math.min(t, Math.max(0, (el.duration || 0) - 0.001))));
      },
    };
  });

  // SF6/SF10 on-preview transform handles: show for the SELECTED clip when it is
  // composited at the playhead (the box must match the picture). Video uses the
  // engine element's dims; a title uses its cached canvas dims (isTitle → 1:1).
  const activeSeg = seqMode ? (segments || []).find(s => time >= s.t0 && time < s.t1) : null;
  const handleEl = seqMode ? [vidA.current, vidB.current].find(el => el && el.style.opacity === '1' && el.videoWidth > 0) : null;
  const showHandles = !!(activeSeg && activeSeg.clipId && selectedClipId && activeSeg.clipId === selectedClipId && handleEl);
  const activeRegion = seqMode ? (compositeRegionsRef.current || []).find(r => time >= r.t0 && time < r.t1) : null;
  const titleLayer = activeRegion && selectedClipId
    ? activeRegion.layers.find(l => l.clipId === selectedClipId && l.kind === 'title')
    : null;
  const titleCanvas = titleLayer ? titleCacheRef.current.get(titleLayer.clipId)?.canvas : null;

  const pct = shownDuration > 0 ? Math.min(100, (time / shownDuration) * 100) : 0;
  const videoStyle = (vis) => ({
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    opacity: vis ? 1 : 0.0001,
    zIndex: vis ? 2 : 1,
  });

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#0a0a0c' }}>
      <div ref={stageRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <video ref={vidA} crossOrigin="anonymous" playsInline preload="auto" style={videoStyle(true)} />
        <video ref={vidB} crossOrigin="anonymous" playsInline preload="auto" style={videoStyle(false)} />
        {glOk && (
          <canvas
            ref={canvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 3, pointerEvents: 'none' }}
          />
        )}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 4,
            pointerEvents: 'none',
            background: 'radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.38) 100%)',
          }}
        />
        {showHandles && (
          <TransformHandles
            clipId={activeSeg.clipId}
            trackId={activeSeg.trackId}
            transform={activeSeg.transform}
            srcW={handleEl.videoWidth}
            srcH={handleEl.videoHeight}
            seqW={seqW}
            seqH={seqH}
            accent={accent}
            onCommit={onSetTransform}
          />
        )}
        {titleCanvas && (
          <TransformHandles
            clipId={titleLayer.clipId}
            trackId={titleLayer.trackId}
            transform={titleLayer.transform}
            srcW={titleCanvas.width}
            srcH={titleCanvas.height}
            seqW={seqW}
            seqH={seqH}
            accent={accent}
            onCommit={onSetTransform}
            isTitle
          />
        )}
        {!seqMode && !url && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.28)', fontSize: 12.5, zIndex: 5 }}>
            Select a clip in the Bin to preview it.
          </div>
        )}
      </div>

      <div
        style={{ padding: '10px 18px 4px', cursor: shownDuration ? 'pointer' : 'default' }}
        onPointerDown={onRailDown}
        onPointerMove={onRailMove}
        onPointerUp={onRailUp}
        onPointerCancel={onRailUp}
        onMouseEnter={() => setRailHot(true)}
        onMouseLeave={() => { if (!scrubRef.current) setRailHot(false); }}
      >
        <div
          ref={railRef}
          className="candy-groove"
          style={{ height: railHot ? 6 : 2, transition: 'height 0.15s ease', '--accent': accent }}
        >
          <div className="candy-groove__fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 14px' }}>
        <TransportBar
          playing={seqMode ? engine.playing : playing}
          time={time}
          duration={shownDuration}
          fps={seqMode ? seqFps : fps}
          accent={accent}
          onTogglePlay={togglePlay}
          onStep={step}
          benchText={benchText}
          onBench={runBench}
          seqMode={seqMode}
          rate={engine.rate}
          onCycleRate={cycleRate}
          masterVolume={masterVolume}
          onMasterVolume={onMasterVolume}
          onSwapStats={onSwapStats}
        />
      </div>
    </div>
  );
}

// useGlDisplay — owns the preview canvas's render loop (Color Grading SF1).
//
// One always-running rAF loop, independent of the playback engine's loop and
// the source-mode sampler (same-tick batching, zero coupling). Per tick it
// samples whichever <video> the existing visibility writes mark active
// (style.opacity === '1' — the engine/source-mode flips become the
// "picture source" signal for free) and draws it through glDisplay.
//
// Redraw policy: draw when the active element, its currentTime, or its
// decoded dimensions change, or when a `seeked`/`loadeddata` event marks the
// frame dirty — currentTime mutates at SEEK ISSUE time while the decoded
// frame lands at `seeked`, so time comparison alone would show stale frames
// on paused frame-steps. During playback currentTime advances every tick, so
// uploads run at display cadence — exactly the workload the GPU spike
// measured PASS at 1080p (p95 13 ms incl. LUT); per-frame-rate quantized
// skipping is a recorded later knob, not needed at the measured budget.
//
// Failure posture (NVIDIA/EGL precedent — GL must be OPTIONAL): context
// creation is lazy and try/caught; a software renderer (llvmpipe class) or a
// failed context flips glOk false and the caller renders no canvas at all —
// the stacked <video> elements underneath ARE the display again, exactly the
// pre-canvas tree. `webglcontextlost` pauses drawing; `webglcontextrestored`
// rebuilds programs + textures from scratch (per-element textures and the SF3
// LUT cache re-upload lazily on the next draw).
//
// Escape hatch: localStorage 'vedit:no-gl' = '1' forces the fallback path —
// the only way to exercise/demo no-GL behavior on a healthy GPU, and a
// field-rescue knob if a user's GL stack is broken.

import { useEffect, useRef, useState } from 'react';
import { createGlDisplay, looksSoftware } from './glDisplay.js';
import { scopeBus } from './scopeBus.js';

// `getLutRef` (optional): a ref whose .current returns the ACTIVE picture's
// compiled LUT entry ({ rgba8, n, version } from gradePipeline) or null for
// identity. A ref, not a callback prop — the mount-once effect must read
// fresh segment/grade state every tick without re-subscribing.
export default function useGlDisplay({ stageRef, canvasRef, vidA, vidB, getLutRef, getXformRef, getCompositeRef }) {
  const [glOk, setGlOk] = useState(true);
  const dispRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return undefined;

    let disp = null;
    let raf = 0;
    let dead = false;
    let lost = false;
    let dirty = true;
    let lastTap = 0; // scope-tap throttle clock (SF9)
    let tapPending = null; // { el, useLut } — last completed draw awaiting a scope tap
    const last = { el: null, time: -1, w: 0, h: 0, cw: 0, ch: 0, lutDrawn: 0, lutUploaded: 0, xform: null };

    const forcedOff = (() => {
      try { return localStorage.getItem('vedit:no-gl') === '1'; } catch { return false; }
    })();

    const build = () => {
      try { disp = forcedOff ? null : createGlDisplay(canvas); } catch { disp = null; }
      if (!disp || looksSoftware(disp.renderer)) {
        try { disp?.dispose(); } catch { /* half-built context */ }
        disp = null;
        dead = true;
        setGlOk(false);
        console.info('[vedit-gl]', forcedOff ? 'forced off (vedit:no-gl)' : 'unavailable — direct video fallback');
        return false;
      }
      dispRef.current = disp;
      console.info('[vedit-gl]', 'WebGL2 display path on —', disp.renderer);
      return true;
    };

    const syncSize = () => {
      const r = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (w !== last.cw || h !== last.ch) {
        last.cw = w;
        last.ch = h;
        disp?.resize(w, h);
        dirty = true;
      }
    };

    const activeOf = () => {
      for (const ref of [vidA, vidB]) {
        const el = ref.current;
        if (el && el.style.opacity === '1' && el.videoWidth > 0 && el.src) return el;
      }
      return null;
    };

    // Any throw inside the draw path must NOT kill the rAF chain silently —
    // a dead loop leaves the opaque canvas frozen over working videos (the
    // exact first-attempt SF1 failure). One failure = permanent fallback to
    // direct video for this mount.
    const bail = (err) => {
      console.warn('[vedit-gl] draw failed — direct video fallback', err);
      dead = true;
      try { disp?.dispose(); } catch { /* context already gone */ }
      disp = null;
      dispRef.current = null;
      setGlOk(false);
    };

    const loop = () => {
      if (dead) return;
      if (!lost && disp) {
        try {
          // SF5 multi-layer composite: when the current region has underlays,
          // composite the full stack every tick (within the SF1 budget) and skip
          // the single-layer path. Non-overlap projects return null here, so the
          // single-layer path below stays byte-identical.
          const comp = getCompositeRef?.current?.() ?? null;
          if (comp && comp.layers.length) {
            disp.renderComposite(comp.layers, comp.seqW, comp.seqH);
            last.el = null;
            last.time = -1;
            last.xform = null;
            dirty = false;
            tapPending = null;
            raf = requestAnimationFrame(loop);
            return;
          }
          const el = activeOf();
          if (!el) {
            if (last.el !== null || dirty) {
              disp.drawBlack();
              last.el = null;
              last.time = -1;
              dirty = false;
            }
          } else {
            // Active picture's grade LUT (null = identity). Version compares
            // make both the re-upload and the paused-frame redraw one-int
            // checks — a committed grade change redraws a parked frame.
            const lut = getLutRef?.current?.() ?? null;
            const lutV = lut ? lut.version : 0;
            // SF4: the active clip's transform (null = identity). Non-identity
            // routes the single active element through renderComposite so a
            // transformed clip previews scaled/positioned/rotated; identity
            // stays on the untouched render() path (zero grade-path risk).
            const xf = getXformRef?.current?.() ?? null;
            const xform = xf?.transform ?? null;
            if (
              dirty
              || el !== last.el
              || el.currentTime !== last.time
              || el.videoWidth !== last.w
              || el.videoHeight !== last.h
              || lutV !== last.lutDrawn
              || xform !== last.xform
            ) {
              if (xform) {
                disp.renderComposite([{ el, transform: xform, lut }], xf.seqW, xf.seqH);
              } else {
                if (lut && last.lutUploaded !== lutV) {
                  disp.setLut(lut.rgba8, lut.n);
                  last.lutUploaded = lutV;
                }
                disp.render(el, !!lut);
              }
              tapPending = { el, useLut: !!lut };
              last.el = el;
              last.time = el.currentTime;
              last.w = el.videoWidth;
              last.h = el.videoHeight;
              last.lutDrawn = lutV;
              last.xform = xform;
              dirty = false;
            }
          }
          // Scope tap (SF9): set pending by every completed draw, fired here
          // at ≤ ~12 Hz. During playback draws run at display cadence so the
          // throttle rules; parked redraws (grade change, seek) are sparse
          // and the loop ticks every rAF regardless, so the TRAILING draw
          // always lands in the scopes — a quick wheel flick can't strand a
          // stale frame. No listener → zero cost (FBO pass + readPixels
          // skipped entirely).
          if (scopeBus.sink && tapPending) {
            const now = performance.now();
            if (now - lastTap >= 80) {
              lastTap = now;
              const { el: tEl, useLut } = tapPending;
              tapPending = null;
              const f = disp.renderScope(tEl, useLut);
              if (f) scopeBus.sink(f);
            }
          }
        } catch (err) {
          bail(err);
          return;
        }
      }
      raf = requestAnimationFrame(loop);
    };

    const markDirty = () => { dirty = true; };
    const onLost = (e) => {
      e.preventDefault();
      lost = true;
      console.warn('[vedit-gl] context lost — drawing paused');
    };
    const onRestored = () => {
      try { disp?.dispose(); } catch { /* context already gone */ }
      dispRef.current = null;
      disp = null;
      if (build()) {
        lost = false;
        last.cw = 0; // force resize + redraw
        last.lutUploaded = 0; // textures died with the context — re-upload
        last.lutDrawn = 0;
        syncSize();
        markDirty();
        console.info('[vedit-gl] context restored — pipeline rebuilt');
      }
    };

    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    const els = [vidA.current, vidB.current].filter(Boolean);
    for (const el of els) {
      el.addEventListener('seeked', markDirty);
      el.addEventListener('loadeddata', markDirty);
    }

    const ro = new ResizeObserver(syncSize);
    ro.observe(stage);

    if (build()) {
      syncSize();
      raf = requestAnimationFrame(loop);
    }

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      for (const el of els) {
        el.removeEventListener('seeked', markDirty);
        el.removeEventListener('loadeddata', markDirty);
      }
      try { disp?.dispose(); } catch { /* context already gone */ }
      dispRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { glOk, dispRef };
}

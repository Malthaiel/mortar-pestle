import { useEffect, useRef } from 'react';
import { transformAtFrame } from './keyframes/engine.js';

// Underlay pool for the multi-layer preview compositor (Compositing & Titles
// SF5). ADDITIVE BY DESIGN: usePlaybackEngine still plays the TOPMOST layer
// (flattenEditList, topmost-wins) completely unchanged — zero regression to the
// proven single-stream path. This manages a small pool of DETACHED <video>
// elements for the NON-topmost (underlay) layers of the current composite
// region, slaved to the engine's master clock: seeked when paused, played with
// a soft resync nudge when playing. The GL loop composites [underlays bottom→top]
// then the engine's topmost element. Underlays are video-only (muted) — preview
// audio stays the engine's topmost (audio mixing is export/Audio-Post territory).
//
// Cap: MAX_UNDERLAYS underlays (so 3 total layers composite in realtime, per the
// SF1 budget). Deeper stacks drop the lowest underlays with a console note (no
// silent cap) and still composite the top three.
//
// `inputRef.current()` must return { region, time, playing, urlFor, seqFps }
// fresh each tick (a ref, like getLutRef — the mount-once loop reads live state
// without re-subscribing). Returns `layersRef`, whose .current() yields the
// ready underlays as [{ el, transform, grade }] bottom→top.

const MAX_UNDERLAYS = 2;
const SYNC_SLOP = 1.5; // frames of drift tolerated before a resync nudge (playing)
const SEEK_SLOP = 0.5; // frames of drift tolerated while paused

export default function useCompositeLayers(inputRef) {
  const pool = useRef([]);
  const layersRef = useRef(() => []);

  useEffect(() => {
    const els = [];
    for (let i = 0; i < MAX_UNDERLAYS; i++) {
      const el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      els.push({ el, url: null, layer: null });
    }
    pool.current = els;

    let raf = 0;
    const release = () => {
      for (const slot of pool.current) {
        if (!slot.el.paused) { try { slot.el.pause(); } catch { /* detached */ } }
        slot.layer = null;
      }
      layersRef.current = () => [];
    };

    const tick = () => {
      const inp = inputRef.current ? inputRef.current() : null;
      const region = inp && inp.region;
      // Engine/underlay split is VIDEO-only — titles aren't <video>s (the GL loop
      // composites them as canvas layers). The engine plays the topmost MEDIA
      // layer; the remaining media layers are the underlays.
      const media = region ? region.layers.filter(l => l.mediaId) : [];
      if (region && media.length > 1 && inp.urlFor) {
        const under = media.slice(0, media.length - 1); // exclude topmost media (engine plays it)
        if (under.length > MAX_UNDERLAYS) {
          console.info('[vedit-composite]', `region has ${media.length} video layers; previewing the top ${MAX_UNDERLAYS + 1}, dropping ${under.length - MAX_UNDERLAYS} underlay(s)`);
        }
        const seqFps = inp.seqFps || 30;
        // Keep the topmost underlays (closest to the picture); drop the lowest.
        const keep = under.slice(under.length - MAX_UNDERLAYS);
        for (let i = 0; i < pool.current.length; i++) {
          const slot = pool.current[i];
          const layer = i < keep.length ? keep[i] : null;
          if (!layer || !layer.mediaId) {
            slot.layer = null;
            if (!slot.el.paused) { try { slot.el.pause(); } catch { /* detached */ } }
            continue;
          }
          const url = inp.urlFor(layer.mediaId);
          if (!url) { slot.layer = null; continue; }
          if (slot.url !== url) {
            slot.url = url;
            slot.el.src = url;
            try { slot.el.load(); } catch { /* detached */ }
          }
          slot.layer = layer;
          const expected = layer.srcIn + Math.max(0, inp.time - layer.t0);
          if (inp.playing) {
            if (slot.el.paused) slot.el.play().catch(() => {});
            if (Math.abs((slot.el.currentTime || 0) - expected) > SYNC_SLOP / seqFps) {
              try { slot.el.currentTime = expected; } catch { /* not seekable yet */ }
            }
          } else {
            if (!slot.el.paused) { try { slot.el.pause(); } catch { /* detached */ } }
            if (Math.abs((slot.el.currentTime || 0) - expected) > SEEK_SLOP / seqFps) {
              try { slot.el.currentTime = expected; } catch { /* not seekable yet */ }
            }
          }
        }
        // SF8: evaluate each underlay's keyframes at the region's playhead frame
        // (all layers share inp.time → one frame); the topmost is handled by
        // getCompositeRef. transformAtFrame returns the static transform when the
        // layer has no kf, so non-animated layers are unchanged.
        const frame = Math.round(inp.time * seqFps);
        layersRef.current = () => pool.current
          .filter(s => s.layer && s.el.videoWidth > 0)
          .map(s => ({ el: s.el, clipId: s.layer.clipId, transform: transformAtFrame(s.layer.transform, s.layer.kf, frame), grade: s.layer.grade || null }));
      } else {
        release();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      for (const slot of pool.current) {
        try { slot.el.pause(); slot.el.removeAttribute('src'); slot.el.load(); } catch { /* detached */ }
      }
      pool.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return layersRef;
}

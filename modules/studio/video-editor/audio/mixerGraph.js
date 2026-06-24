// useMixerGraph (Audio Post SF1a + SF3 + SF4) — the editor's Web Audio mixer
// grafted onto the two PERMANENT <video> elements of the Projection Booth.
//
// createMediaElementSource can run only ONCE per element ever, so the source
// nodes are cached for the elements' lifetime (mirrors MusicPlayerProvider).
// The context is created LAZILY on the first play gesture (autoplay policy
// hands back a SUSPENDED context → resume), and closed only when PreviewPlayer
// unmounts (project close) — never on an Edit↔Color↔Mix switch, which would
// strand the source-bound elements.
//
// Topology, per element (master loudnorm lands in SF7):
//   vidX → srcX → clipX → eqX[4] → faderX → meterX → panX ┐  (meter INLINE, post-fader/pre-pan)
//                       ┴→ master → mEq[4] → comp → makeup → masterMeter → destination
//                                          makeup → kShelf → kHP → lufsMeter → lufsSink(0) → destination
// clipX = per-segment clip gain; eqX = the track's 4-band parametric EQ (inline
// biquads, unity when disabled); faderX = the active segment's TRACK fader ×
// mute/solo audibility; panX = the track's equal-power pan. Each element owns
// its EQ/fader/pan, retuned at each cut to whatever track the element is now
// playing (the engine calls setElementTrack at the flip). Meters tap post-fader
// pre-pan (track) and post-master (master, + a K-weighted momentary-LUFS tap).
// Every analyser is INLINE or routed to a muted sink — a dead-end AnalyserNode is
// never pulled by the destination and would report silence (flat meters / −∞ LUFS).
// el.muted gates active/standby; the graph is the sole VOLUME authority.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { readLevel, readLufs } from './meter.js';

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(+v) ? +v : 1));

// 4-band parametric EQ (Audio Post SF5), per element + master. Band TYPES are
// fixed (low-shelf / 2× peaking / high-shelf — matching project.js eqBands);
// freq / Q / gain come from the mixer. The biquads live PERMANENTLY inline at
// unity — a shelf/peak at 0 dB is a mathematical pass-through, so "eq disabled"
// = all gains 0 and the topology never changes (identity-safe, swap-safe).
const EQ_TYPES = ['lowshelf', 'peaking', 'peaking', 'highshelf'];

export function mkEq(ctx) {
  return EQ_TYPES.map((type) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.gain.value = 0;
    return b;
  });
}

// input → b0 → b1 → b2 → b3 → output
export function chainEq(input, nodes, output) {
  let node = input;
  for (const b of nodes) { node.connect(b); node = b; }
  node.connect(output);
}

// Per-channel linear-balance pan (Audio Post SF8 parity fix). The old
// StereoPannerNode used the Web Audio stereo-input cross-feed algorithm, which
// diverges ~unbounded from the export's per-channel `pan=stereo|c0=lg|c1=rg`
// scaling on real (stereo) sources. This sub-graph applies the SAME law as the
// export pan_coeffs: split → independent L/R gain → merge. `in`/`out` are the
// stereo splice points; centre (p=0) is unity (no attenuation).
export function mkPan(ctx) {
  const splitter = ctx.createChannelSplitter(2);
  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  splitter.connect(gainL, 0); gainL.connect(merger, 0, 0);
  splitter.connect(gainR, 1); gainR.connect(merger, 0, 1);
  return { in: splitter, out: merger, gainL, gainR };
}

// Linear-balance gains: p>0 cuts left, p<0 cuts right, centre = unity — exactly
// the Rust pan_coeffs. ramp on live drags, step on the flip (element muted).
export function setPan(p, value, ctx, ramp) {
  const v = Math.max(-1, Math.min(1, Number.isFinite(+value) ? +value : 0));
  const lg = v > 0 ? 1 - v : 1;
  const rg = v < 0 ? 1 + v : 1;
  const t = ctx.currentTime;
  if (ramp) {
    p.gainL.gain.setTargetAtTime(lg, t, 0.008);
    p.gainR.gain.setTargetAtTime(rg, t, 0.008);
  } else {
    p.gainL.gain.setValueAtTime(lg, t);
    p.gainR.gain.setValueAtTime(rg, t);
  }
}

// Apply an {enabled,bands} eq to a biquad chain. Disabled/missing → every band
// flat (0 dB) = transparent. Frequency / Q step (inaudible); gain glides on live
// edits (ramp), steps on the flip (the element is muted then).
export function applyEqNodes(nodes, eq, ctx, ramp) {
  if (!nodes) return;
  const on = !!(eq && eq.enabled);
  const bands = eq && Array.isArray(eq.bands) ? eq.bands : null;
  const t = ctx.currentTime;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const b = bands && bands[i];
    if (b && Number.isFinite(+b.f)) n.frequency.setValueAtTime(+b.f, t);
    if (b && Number.isFinite(+b.q)) n.Q.setValueAtTime(+b.q, t);
    const g = on && b && Number.isFinite(+b.g) ? +b.g : 0;
    if (ramp) n.gain.setTargetAtTime(g, t, 0.01);
    else n.gain.setValueAtTime(g, t);
  }
}

const cnum = (v, lo, hi, d) => { const n = +v; return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

// Master compressor (Audio Post SF6) — DynamicsCompressorNode + a trailing
// makeup-gain node (the node has no makeup param; ffmpeg acompressor does, so a
// gain node reproduces it). Kept PERMANENTLY inline; "disabled" = transparent
// (ratio 1, threshold 0, knee 0, makeup unity). The node adds a small constant
// lookahead latency on the master whether on or off — imperceptible and
// preview-only (the ffmpeg export has none).
export function applyCompNode(comp, makeup, c, ctx, ramp) {
  if (!comp) return;
  const on = !!(c && c.enabled);
  const t = ctx.currentTime;
  comp.threshold.setValueAtTime(on ? cnum(c.threshold, -100, 0, -24) : 0, t);
  comp.ratio.setValueAtTime(on ? cnum(c.ratio, 1, 20, 4) : 1, t);
  comp.attack.setValueAtTime(on ? cnum(c.attack, 0, 1, 0.003) : 0.003, t);
  comp.release.setValueAtTime(on ? cnum(c.release, 0, 1, 0.25) : 0.25, t);
  comp.knee.setValueAtTime(on ? cnum(c.knee, 0, 40, 30) : 0, t);
  const mk = on ? Math.pow(10, cnum(c.makeup, 0, 24, 0) / 20) : 1;
  if (ramp) makeup.gain.setTargetAtTime(mk, t, 0.01);
  else makeup.gain.setValueAtTime(mk, t);
}

// Push a channel's fader (track volume × audibility) + equal-power pan + EQ.
// ramp=false (flip/seek — the element is muted, so a step is click-free);
// ramp=true (live fader/pan/EQ drags — a short glide avoids zipper noise).
function applyChan(g, c, params, ramp) {
  const t = g.ctx.currentTime;
  const vol = params && params.audible === false ? 0 : Math.max(0, (params && params.volume) ?? 1);
  const pan = Math.max(-1, Math.min(1, (params && params.pan) ?? 0));
  if (ramp) c.fader.gain.setTargetAtTime(vol, t, 0.008);
  else c.fader.gain.setValueAtTime(vol, t);
  setPan(c.pan, pan, g.ctx, ramp);
  applyEqNodes(c.eq, params && params.eq, g.ctx, ramp);
}

export default function useMixerGraph({ vidA, vidB }) {
  const ref = useRef(null);       // graph node bundle (see ensure)
  const masterValRef = useRef(1); // desired master — applied even before the ctx exists
  const masterEqRef = useRef(null); // desired master EQ — applied at graph build
  const masterCompRef = useRef(null); // desired master compressor — applied at graph build

  const ensure = useCallback(() => {
    let g = ref.current;
    if (!g) {
      const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
      const a = vidA.current;
      const b = vidB.current;
      if (!AC || !a || !b) return null;
      let ctx;
      try { ctx = new AC(); } catch { return null; }
      try {
        const mk = (el) => {
          const src = ctx.createMediaElementSource(el);
          const clip = ctx.createGain();
          const eq = mkEq(ctx);
          const fader = ctx.createGain();
          const pan = mkPan(ctx); // per-channel linear-balance sub-graph (SF8 parity)
          const meter = ctx.createAnalyser();
          meter.fftSize = 2048;
          // src → clip → eq[0..3] → fader → meter → pan.in …→ pan.out. The meter
          // is INLINE (NOT a dead-end tap): a sink-less AnalyserNode is never
          // reachable backward from the destination, so the render graph never
          // pulls it and it reads pure silence. AnalyserNode is gain-/phase-
          // transparent, so inlining at the post-fader/pre-pan tap leaves the
          // audio identical.
          src.connect(clip);
          chainEq(clip, eq, fader);
          fader.connect(meter); meter.connect(pan.in);
          return { src, clip, eq, fader, pan, meter, buf: new Float32Array(meter.fftSize) };
        };
        const A = mk(a);
        const B = mk(b);
        const master = ctx.createGain();
        const mEq = mkEq(ctx);                 // master 4-band EQ (SF5)
        const comp = ctx.createDynamicsCompressor(); // master compressor (SF6)
        const makeup = ctx.createGain();       // comp makeup gain
        const masterMeter = ctx.createAnalyser();
        masterMeter.fftSize = 2048;
        // K-weighting (BS.1770 approx): high-shelf + high-pass → LUFS analyser.
        const kShelf = ctx.createBiquadFilter();
        kShelf.type = 'highshelf'; kShelf.frequency.value = 1500; kShelf.gain.value = 4;
        const kHP = ctx.createBiquadFilter();
        kHP.type = 'highpass'; kHP.frequency.value = 38; kHP.Q.value = 0.5;
        const lufsMeter = ctx.createAnalyser();
        lufsMeter.fftSize = 16384;
        // The K-weight chain is a silent side-branch; route it through a MUTED sink
        // to the destination so the graph pulls it (a dead-end lufsMeter reads −∞).
        const lufsSink = ctx.createGain();
        lufsSink.gain.value = 0;
        A.pan.out.connect(master);
        B.pan.out.connect(master);
        // master → mEq[0..3] → comp → makeup → masterMeter → destination; the
        // meter + K-weight tap sit POST comp+makeup (the true processed output).
        chainEq(master, mEq, comp);
        comp.connect(makeup);
        makeup.connect(masterMeter);
        masterMeter.connect(ctx.destination);
        makeup.connect(kShelf); kShelf.connect(kHP); kHP.connect(lufsMeter);
        lufsMeter.connect(lufsSink); lufsSink.connect(ctx.destination);
        master.gain.setValueAtTime(clamp01(masterValRef.current), ctx.currentTime);
        applyEqNodes(mEq, masterEqRef.current, ctx, false);
        applyCompNode(comp, makeup, masterCompRef.current, ctx, false);
        g = {
          ctx, A, B, master, mEq, comp, makeup, masterMeter, lufsMeter,
          bufM: new Float32Array(masterMeter.fftSize),
          bufL: new Float32Array(lufsMeter.fftSize),
          trackId: { a: null, b: null },
        };
        ref.current = g;
      } catch (e) {
        console.warn('[vedit-audio] graph init failed', e);
        try { ctx.close(); } catch {}
        return null;
      }
    }
    if (g.ctx.state === 'suspended') g.ctx.resume().catch(() => {});
    return g;
  }, [vidA, vidB]);

  const chan = (g, key) => (key === 'a' ? g.A : g.B);

  const setElementGain = useCallback((key, gain, ramp = false) => {
    const g = ref.current;
    if (!g) return;
    const p = chan(g, key).clip.gain;
    const v = Math.max(0, gain || 0);
    if (ramp) p.setTargetAtTime(v, g.ctx.currentTime, 0.005);
    else p.setValueAtTime(v, g.ctx.currentTime);
  }, []);

  const setElementTrack = useCallback((key, trackId, params) => {
    const g = ref.current;
    if (!g) return;
    g.trackId[key] = trackId ?? null;
    applyChan(g, chan(g, key), params, false);
  }, []);

  const setTrackLive = useCallback((trackId, params) => {
    const g = ref.current;
    if (!g) return;
    if (g.trackId.a === trackId) applyChan(g, g.A, params, true);
    if (g.trackId.b === trackId) applyChan(g, g.B, params, true);
  }, []);

  const setMaster = useCallback((v) => {
    const val = clamp01(v ?? 1);
    masterValRef.current = val;
    const g = ref.current;
    if (!g) return;
    g.master.gain.setTargetAtTime(val, g.ctx.currentTime, 0.005);
  }, []);

  const setMasterEq = useCallback((eq) => {
    masterEqRef.current = eq || null;
    const g = ref.current;
    if (!g) return;
    applyEqNodes(g.mEq, eq, g.ctx, true);
  }, []);

  const setMasterComp = useCallback((c) => {
    masterCompRef.current = c || null;
    const g = ref.current;
    if (!g) return;
    applyCompNode(g.comp, g.makeup, c, g.ctx, true);
  }, []);

  // Snapshot the meters: per-track (only the element currently playing each
  // track has signal) + master peak/RMS + master momentary LUFS.
  const meter = useCallback(() => {
    const g = ref.current;
    if (!g) return null;
    const out = { tracks: {}, master: readLevel(g.masterMeter, g.bufM) };
    out.master.lufs = readLufs(g.lufsMeter, g.bufL);
    out.master.gr = g.comp ? g.comp.reduction : 0; // current gain reduction (≤ 0 dB)
    if (g.trackId.a) out.tracks[g.trackId.a] = readLevel(g.A.meter, g.A.buf);
    if (g.trackId.b) out.tracks[g.trackId.b] = readLevel(g.B.meter, g.B.buf);
    return out;
  }, []);

  const analyser = useCallback(() => ref.current?.masterMeter || null, []);

  useEffect(() => () => {
    const g = ref.current;
    if (g) { try { g.ctx.close(); } catch {} ref.current = null; }
  }, []);

  return useMemo(
    () => ({ ensure, setElementGain, setElementTrack, setTrackLive, setMaster, setMasterEq, setMasterComp, meter, analyser }),
    [ensure, setElementGain, setElementTrack, setTrackLive, setMaster, setMasterEq, setMasterComp, meter, analyser],
  );
}

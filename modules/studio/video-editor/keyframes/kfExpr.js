// Keyframe → ffmpeg expression lowering (Compositing & Titles SF9). The JS side
// compiles each animated keyframe track to an ffmpeg-expr STRING; Rust stays
// dumb (substitutes the string into overlay/rotate/geq/volume), exactly as it
// does with .cube LUT text. Exprs are in REGION-LOCAL seconds: the export trims
// each input with -ss + setpts=PTS-STARTPTS, so the filter clock starts at 0 at
// the region's first frame. kf.f is an ABSOLUTE sequence frame, so region-local
// time = (f - regionStartF) / fps (negative for keyframes before a split point —
// the lerp still evaluates correctly over t ≥ 0).
//
// Easing is the EXACT same formula as the preview engine (engine.js easeU):
// linear / u² / 1-(1-u)² / smoothstep, written straight into the expr with
// lerp()/pow() — so a keyframed export matches the frame-sampled preview without
// any baked frame table.

import { evaluate } from './engine.js';

const num = (n) => Number(n).toFixed(6);

// One scalar param track → an ffmpeg expr over the time variable `timeVar`
// ('t' for overlay/rotate/volume; 'T' for geq, whose time constant is uppercase).
// `accessor` maps each keyframe value to the emitted scalar (e.g. v=>0.5+v.x for
// an overlay center fraction, or v=>v*PI/180 for radians). Assumes ≥2 keyframes
// (callers collapse constants to a literal first).
export function kfToExpr(track, regionStartF, fps, accessor = (v) => v, timeVar = 't') {
  if (!track || track.length < 2) return null;
  const tv = timeVar;
  const T = (f) => num((f - regionStartF) / fps);
  const val = (v) => num(accessor(v));
  let expr = val(track[track.length - 1].v); // hold after the last keyframe
  for (let i = track.length - 2; i >= 0; i--) {
    const a = track[i];
    const b = track[i + 1];
    const ta = (a.f - regionStartF) / fps;
    const tb = (b.f - regionStartF) / fps;
    const dt = tb - ta;
    // Wrap the offset in parens so a negative ta (a keyframe before a split's
    // region start) emits `t-(-0.33)`, not the `t--0.33` that breaks both the
    // ffmpeg AND the JS expr parser.
    const X = dt > 1e-9 ? `((${tv}-(${num(ta)}))/${num(dt)})` : '0';
    const v0 = val(a.v);
    const v1 = val(b.v);
    let seg;
    switch (a.ease) {
      case 'in': seg = `lerp(${v0},${v1},pow(${X},2))`; break;
      case 'out': seg = `lerp(${v0},${v1},(1-pow(1-${X},2)))`; break;
      case 'inout': seg = `lerp(${v0},${v1},(pow(${X},2)*(3-2*${X})))`; break;
      default: seg = `lerp(${v0},${v1},${X})`; break;
    }
    expr = `if(lt(${tv},${T(b.f)}),${seg},${expr})`;
  }
  const t0 = (track[0].f - regionStartF) / fps;
  if (t0 > 1e-9) expr = `if(lt(${tv},${num(t0)}),${val(track[0].v)},${expr})`;
  return expr;
}

// A track is "animated" only with ≥2 keyframes that aren't all the same value —
// a single keyframe (or a flat track) collapses to a constant the static export
// path handles (cheaper, and keeps a no-motion export close to SF7).
const animated = (track, eq) => !!(track && track.length >= 2 && !track.every((k) => eq(k.v, track[0].v)));
const numEq = (a, b) => a === b;
const posEq = (a, b) => a.x === b.x && a.y === b.y;

// Compile a layer's keyframes for export: animated tracks become exprs; constant
// tracks bake into the returned transform/gain (the SF7 literal path renders
// them). `regionStartF` rebases time to the region; `baseT` is the layer's static
// transform (may be null/partial), `baseGain` its static clip gain.
//   exprs: { posX, posY, rot, opacity, gain } — each present only when animated.
//     posX/posY are overlay CENTRE fractions (0.5±offset, y flipped); rot is
//     RADIANS; opacity uses uppercase-T (geq); gain is the clip gain.
export function layerExports(kf, regionStartF, fps, baseT, baseGain) {
  const t = { ...(baseT || {}) };
  let gain = baseGain;
  const exprs = {};
  if (kf) {
    if (kf.pos) {
      if (animated(kf.pos, posEq)) {
        exprs.posX = kfToExpr(kf.pos, regionStartF, fps, (v) => 0.5 + v.x, 't');
        exprs.posY = kfToExpr(kf.pos, regionStartF, fps, (v) => 0.5 - v.y, 't');
      } else { const v = kf.pos[0].v; t.x = v.x; t.y = v.y; }
    }
    if (kf.rot) {
      if (animated(kf.rot, numEq)) exprs.rot = kfToExpr(kf.rot, regionStartF, fps, (v) => (v * Math.PI) / 180, 't');
      else t.rot = kf.rot[0].v;
    }
    if (kf.opacity) {
      if (animated(kf.opacity, numEq)) exprs.opacity = kfToExpr(kf.opacity, regionStartF, fps, (v) => v, 'T');
      else t.opacity = kf.opacity[0].v;
    }
    if (kf.gain) {
      if (animated(kf.gain, numEq)) exprs.gain = kfToExpr(kf.gain, regionStartF, fps, (v) => v, 't');
      else gain = kf.gain[0].v;
    }
  }
  return { transform: t, gain, exprs: Object.keys(exprs).length ? exprs : null };
}

// Track-volume automation (mixer track kf.volume) → a region-local volume expr,
// or null when constant/absent (the static fader value is used instead).
export function trackVolumeExpr(trackKf, regionStartF, fps) {
  const vol = trackKf && trackKf.volume;
  if (!animated(vol, numEq)) return null;
  return kfToExpr(vol, regionStartF, fps, (v) => v, 't');
}

// Re-export for ExportDialog convenience (constant-track value at the region start
// when a caller wants to bake without re-deriving).
export { evaluate };

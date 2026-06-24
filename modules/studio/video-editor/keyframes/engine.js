// Keyframe engine (Compositing & Titles SF8) — pure, frame-domain evaluation of
// the per-param tracks project.js stores on a clip (kf.pos/rot/opacity/gain) or
// a mixer track (kf.volume). Shared by the live preview (sampled per frame in
// the rAF path) and SF9's export expr-baker (kfToExpr). No DOM, no React —
// testable as plain data.
//
// A track is a sorted [{ f, v, ease }]; the LEFT keyframe's `ease` shapes the
// segment to its right. ease ∈ { linear (absent), in, out, inout }. Easing uses
// direct formulas (exact, branch-cheap) rather than color/gradeLut.js evalCurve:
// u² / 1-(1-u)² / smoothstep reproduce the locked linear/in/out/inout behavior
// exactly and in fewer ops (the plan named evalCurve as a reuse nudge; the
// formulas are the simpler, exact realization — see the Update Queue note).
// Position values are { x, y }; rot/opacity/gain/volume are scalars.

/// Eased interpolation parameter for a normalized progress u ∈ [0,1].
export function easeU(ease, u) {
  switch (ease) {
    case 'in': return u * u;                 // accelerate
    case 'out': return 1 - (1 - u) * (1 - u); // decelerate
    case 'inout': return u * u * (3 - 2 * u); // smoothstep
    default: return u;                        // linear
  }
}

const lerp = (a, b, t) =>
  (typeof a === 'number'
    ? a + (b - a) * t
    : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/// Value of one param track at a sequence frame. Holds before the first / after
/// the last keyframe; undefined for an empty/missing track.
export function evaluate(track, frame) {
  if (!track || !track.length) return undefined;
  if (frame <= track[0].f) return track[0].v;
  const last = track[track.length - 1];
  if (frame >= last.f) return last.v;
  let i = 0;
  while (i < track.length - 1 && track[i + 1].f <= frame) i++;
  const a = track[i];
  const b = track[i + 1];
  const span = b.f - a.f;
  const u = span > 0 ? (frame - a.f) / span : 0;
  return lerp(a.v, b.v, easeU(a.ease, u));
}

/// True if the clip/track has any animated VISUAL param (pos/rot/opacity) — the
/// preview must route such a clip through the composite path even with no static
/// transform, so its motion renders.
export function hasVisualKf(kf) {
  return !!(kf && (kf.pos || kf.rot || kf.opacity));
}

/// Merge keyframed visual params (pos→x/y, rot, opacity) over a base transform
/// at a frame → a transform object for computeLayerQuad/renderComposite, or the
/// base (possibly null) when nothing visual is animated. scale & crop are not
/// keyframable this sub-plan, so their base values pass through untouched.
export function transformAtFrame(base, kf, frame) {
  if (!hasVisualKf(kf)) return base;
  const t = { ...(base || {}) };
  if (kf.pos) {
    const p = evaluate(kf.pos, frame);
    if (p) { t.x = p.x; t.y = p.y; }
  }
  if (kf.rot) {
    const v = evaluate(kf.rot, frame);
    if (v != null) t.rot = v;
  }
  if (kf.opacity) {
    const v = evaluate(kf.opacity, frame);
    if (v != null) t.opacity = v;
  }
  return t;
}

/// Clip audio gain at a frame (kf.gain overrides the static gain).
export function gainAtFrame(base, kf, frame) {
  const v = kf && kf.gain ? evaluate(kf.gain, frame) : undefined;
  return v == null ? base : v;
}

/// Mixer track fader volume at a frame (kf.volume overrides the static volume).
export function volumeAtFrame(base, kf, frame) {
  const v = kf && kf.volume ? evaluate(kf.volume, frame) : undefined;
  return v == null ? base : v;
}

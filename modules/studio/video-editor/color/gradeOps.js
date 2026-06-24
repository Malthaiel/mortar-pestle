// gradeOps — the clip.grade schema + its undo-stack op (Color Grading SF3).
//
// A grade is ABSENT when identity (no `grade: {defaults}` noise in
// project.json; normalizeProject passes unknown fields through untouched, so
// no schemaVersion bump). Grades are IMMUTABLE-BY-CONVENTION: every change
// replaces the whole object — split halves and copy/paste can share
// references safely, and the compile cache (gradePipeline.js) keys on object
// identity.
//
// Pipeline order is FIXED FOREVER (locked decision 7 — reordering would
// change every saved grade's look): temp/tint → lift/gamma/gain (CDL) →
// saturation → RGB curves → hue-vs-sat → creative LUT × intensity.

import { setClipProps } from '../editList.js';

export const DEFAULT_GRADE = Object.freeze({
  v: 1,
  temp: 0,            // −1..1 — R/B gain tilt
  tint: 0,            // −1..1 — G gain tilt
  lift: [0, 0, 0],    // CDL offset, −0.5..0.5
  gamma: [0, 0, 0],   // −1..1 → power 2^(−v) (positive = brighter mids)
  gain: [1, 1, 1],    // CDL slope, 0..2
  sat: 1,             // 0..2 (Rec.709 luma weights)
  curves: null,       // { m, r, g, b: [[x,y],…] } — absent channels = identity
  hueSat: null,       // [[hue 0..1, mul 0..2], …] — wrapping x
  lut: null,          // { file, name, intensity 0..1 } — project-relative .cube
});

const identityPts = (pts) =>
  !pts
  || pts.length < 2
  || (pts.length === 2
    && pts[0][0] === 0 && pts[0][1] === 0
    && pts[1][0] === 1 && pts[1][1] === 1);

const tripleIs = (t, v) => !t || (t[0] === v && t[1] === v && t[2] === v);

export function isIdentityGrade(g) {
  if (!g) return true;
  if ((g.temp || 0) !== 0 || (g.tint || 0) !== 0) return false;
  if (!tripleIs(g.lift, 0) || !tripleIs(g.gamma, 0) || !tripleIs(g.gain, 1)) return false;
  if ((g.sat ?? 1) !== 1) return false;
  const c = g.curves;
  if (c && !(identityPts(c.m) && identityPts(c.r) && identityPts(c.g) && identityPts(c.b))) return false;
  if (g.hueSat && g.hueSat.length && g.hueSat.some(([, m]) => m !== 1)) return false;
  if (g.lut && (g.lut.intensity ?? 1) > 0) return false;
  return true;
}

// Defensive merge for grades loaded from disk (missing fields → defaults).
export function normalizeGrade(g) {
  if (!g) return null;
  return {
    ...DEFAULT_GRADE,
    ...g,
    lift: Array.isArray(g.lift) && g.lift.length === 3 ? g.lift : [0, 0, 0],
    gamma: Array.isArray(g.gamma) && g.gamma.length === 3 ? g.gamma : [0, 0, 0],
    gain: Array.isArray(g.gain) && g.gain.length === 3 ? g.gain : [1, 1, 1],
  };
}

// The ONE mutation path for grades — an undo-stack op via the existing
// setClipProps shape. `grade === undefined` deletes the key (reset);
// JSON.stringify drops undefined values, so a reset clip serializes with no
// grade key at all.
export function setClipGrade(tracks, laneIdx, clipId, grade, label) {
  return setClipProps(tracks, laneIdx, clipId, { grade }, label || 'Grade');
}

// Paste ONE grade reference onto several clips as ONE undo op (SF10
// copy/paste, multi-select). All targets share the pasted object — the
// schema's immutable-by-convention sharing, exactly like split halves — so
// they also share one compile-cache entry.
export function setClipsGrade(tracks, targets, grade, label) {
  const found = targets
    .map(({ laneIdx, clipId }) => {
      const clip = tracks[laneIdx]?.clips.find((c) => c.id === clipId);
      return clip && clip.grade !== grade
        ? { laneIdx, before: clip, after: { ...clip, grade } }
        : null;
    })
    .filter(Boolean);
  if (!found.length) return null;
  const swap = (ts, key) => {
    let next = ts;
    for (const f of found) {
      next = next.map((t, i) => (
        i === f.laneIdx
          ? { ...t, clips: t.clips.map((c) => (c.id === f[key].id ? f[key] : c)) }
          : t
      ));
    }
    return next;
  };
  return {
    label: label || 'Paste grade',
    apply: (ts) => swap(ts, 'after'),
    invert: (ts) => swap(ts, 'before'),
  };
}

// gradePipeline — compile cache from grade objects to upload-ready LUT data
// (Color Grading SF3). Keyed by grade OBJECT IDENTITY in a WeakMap: grades
// are immutable-by-convention (gradeOps), so a reference is a content key,
// split halves / copy-paste sharing a reference share one compile, and GC
// owns eviction — no clipId bookkeeping, no manual invalidation.
//
// Each entry carries a monotonically increasing `version` so the GL loop can
// skip re-uploads (and the draw cheap-skip can detect grade changes) with one
// integer compare. `f32` is kept for SF4: export serializes the cube from the
// SAME 8-bit-quantized lattice the preview texture uploads, so both paths
// read literally identical numbers.
//
// SF7 additions:
// - Creative-LUT text cache: project-relative file → parsed cube. Texts come
//   from vedit_lut_import (load gesture) or vedit_lut_read (project-open
//   prefetch). A grade whose LUT text hasn't arrived compiles WITHOUT the
//   creative stage and is marked pendingLut — the next getLutFor after the
//   text lands recompiles (the GL loop polls every tick, so the preview
//   self-heals with no React plumbing). A failed read marks 'missing' and the
//   UI shows the offline badge; the grade keeps previewing minus the LUT.
// - Draft slot: wheel/slider gestures write a transient grade here and the
//   player's per-tick lookup prefers it for the matching clip — live preview
//   with zero React renders and zero undo traffic until release.

import { compileGrade, toRGBA8, parseCube, LUT_N } from './gradeLut.js';
import { isIdentityGrade } from './gradeOps.js';

let nextVersion = 1;
const cache = new WeakMap(); // gradeObj → { rgba8, f32q, n, version, pendingLut }

const lutCubes = new Map(); // file → parsed cube | 'missing'

// DEV instrumentation (SF3 deferral): last compile wall time, surfaced by the
// suite's DEV chip so the <10 ms budget is checkable without the console.
export let lastCompileMs = 0;

export function registerLutText(file, text) {
  try {
    lutCubes.set(file, parseCube(text));
  } catch {
    lutCubes.set(file, 'missing');
  }
}

export function markLutMissing(file) {
  if (!lutCubes.has(file)) lutCubes.set(file, 'missing');
}

// 'loaded' | 'missing' | 'pending' (pending = no read attempted/landed yet)
export function lutState(file) {
  const v = lutCubes.get(file);
  if (!v) return 'pending';
  return v === 'missing' ? 'missing' : 'loaded';
}

// Gesture draft — read by PreviewPlayer's per-tick grade lookup.
export const gradeDraft = { clipId: null, grade: null };
export function setGradeDraft(clipId, grade) {
  gradeDraft.clipId = clipId;
  gradeDraft.grade = grade;
}

// grade → { rgba8, f32q, n, version } | null (null = identity, draw FS_PASS).
export function getLutFor(grade) {
  if (!grade || isIdentityGrade(grade)) return null;
  const wantsLut = !!(grade.lut && (grade.lut.intensity ?? 1) > 0);
  const parsed = wantsLut ? lutCubes.get(grade.lut.file) : null;
  const cube = parsed && parsed !== 'missing' ? parsed : null;
  let e = cache.get(grade);
  if (e && e.pendingLut && cube) e = null; // LUT text arrived — recompile
  if (!e) {
    const t0 = performance.now();
    const f32 = compileGrade(grade, cube);
    const rgba8 = toRGBA8(f32);
    // Dequantize the uploaded bytes back to floats — the export-side cube
    // text (SF4) serializes THESE so preview and export share one lattice.
    const f32q = new Float32Array(f32.length);
    for (let i = 0, j = 0; i < f32q.length; i += 3, j += 4) {
      f32q[i] = rgba8[j] / 255;
      f32q[i + 1] = rgba8[j + 1] / 255;
      f32q[i + 2] = rgba8[j + 2] / 255;
    }
    e = { rgba8, f32q, n: LUT_N, version: nextVersion++, pendingLut: wantsLut && !cube };
    cache.set(grade, e);
    lastCompileMs = performance.now() - t0;
    if (import.meta.env.DEV) {
      console.info('[vedit-grade]', `compiled v${e.version} in ${lastCompileMs.toFixed(1)} ms`);
    }
  }
  return e;
}

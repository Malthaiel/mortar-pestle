// editList.js (SF7) — pure, frame-quantized edit operations on the project's
// `tracks` array. Every factory is built against the CURRENT tracks snapshot,
// captures the before/after primitives it needs, and returns an
// { apply, invert, label } pair — apply(tracks) → tracks, invert(tracks) →
// tracks — ready for Sub-feature 8's undo stack. No DOM, no React: testable
// as plain data. Linked audio follows automatically: the audio strip renders
// from clips, and gain/mute ride the clip object through every op.
//
// Time model (project.js): clip.start / clip.dur are SEQUENCE frames;
// clip.in is SOURCE frames. ctx = { seqFps, mediaById } supplies fps
// conversion and source-duration clamps. Split right-halves mint their id
// ONCE at factory time so redo is deterministic.

import { newId, clamp01, clampPan, r3, normalizeTransform, normalizeTitle, normalizeKf, CLIP_KF_KEYS, TRACK_KF_KEYS, KF_EASES } from './project.js';
import { evaluate } from './keyframes/engine.js';

const q = (f) => Math.round(Number(f) || 0);

const srcFps = (ctx, clip) => ctx.mediaById?.get(clip.mediaId)?.fps || ctx.seqFps;
// sequence-frame span → source frames covering the same wall-clock span
const toSrc = (ctx, clip, seqFrames) => Math.round((seqFrames / ctx.seqFps) * srcFps(ctx, clip));

function findClip(tracks, trackIdx, clipId) {
  return tracks[trackIdx]?.clips.find(c => c.id === clipId) || null;
}

function mapTrack(tracks, trackIdx, fn) {
  return tracks.map((t, i) => (i === trackIdx ? { ...t, clips: fn(t.clips) } : t));
}

const insertSorted = (clips, clip) => [...clips, clip].sort((a, b) => a.start - b.start);
const without = (clips, clipId) => clips.filter(c => c.id !== clipId);
const replace = (clips, clip) => insertSorted(without(clips, clip.id), clip);

function mkReplace(label, trackIdx, before, after) {
  return {
    label,
    apply: (ts) => mapTrack(ts, trackIdx, cs => replace(cs, after)),
    invert: (ts) => mapTrack(ts, trackIdx, cs => replace(cs, before)),
  };
}

// Legal single-edge ranges for a clip's start (left edge) and end (right
// edge), from track neighbors and remaining source material. Timeline uses
// this for live handle clamping; trimIn/trimOut re-derive the same clamps at
// op-build time so the committed op never trusts UI numbers.
export function trimBounds(ctx, tracks, trackIdx, clipId) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip) return null;
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const c of tracks[trackIdx].clips) {
    if (c.id === clipId) continue;
    const e = c.start + c.dur;
    if (e <= clip.start) prevEnd = Math.max(prevEnd, e);
    if (c.start >= clip.start + clip.dur) nextStart = Math.min(nextStart, c.start);
  }
  const media = ctx.mediaById?.get(clip.mediaId);
  const sf = srcFps(ctx, clip);
  const end = clip.start + clip.dur;
  // Head can extend left only over source that exists before `in`; tail can
  // extend right only over source remaining past the current out point.
  const headroom = Math.floor((clip.in / sf) * ctx.seqFps);
  const tailroom = media?.duration != null
    ? Math.max(0, Math.floor((media.duration - clip.in / sf - clip.dur / ctx.seqFps) * ctx.seqFps))
    : Infinity;
  return {
    minStart: Math.max(prevEnd, clip.start - headroom),
    maxStart: end - 1,
    minEnd: clip.start + 1,
    maxEnd: Math.min(nextStart, end + tailroom),
  };
}

export function splitAt(ctx, tracks, trackIdx, clipId, frame) {
  const clip = findClip(tracks, trackIdx, clipId);
  const f = q(frame);
  if (!clip || f <= clip.start || f >= clip.start + clip.dur) return null;
  const before = clip;
  const leftDur = f - clip.start;
  const left = { ...clip, dur: leftDur };
  const right = {
    ...clip,
    id: newId(),
    start: f,
    dur: clip.dur - leftDur,
    in: clip.in + toSrc(ctx, clip, leftDur),
  };
  return {
    label: 'Blade',
    apply: (ts) => mapTrack(ts, trackIdx, cs => insertSorted(replace(cs, left), right)),
    invert: (ts) => mapTrack(ts, trackIdx, cs => replace(without(cs, right.id), before)),
  };
}

export function trimIn(ctx, tracks, trackIdx, clipId, desiredStart) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip) return null;
  const b = trimBounds(ctx, tracks, trackIdx, clipId);
  const s = Math.max(b.minStart, Math.min(q(desiredStart), b.maxStart));
  if (s === clip.start) return null;
  const after = {
    ...clip,
    start: s,
    dur: clip.start + clip.dur - s,
    in: Math.max(0, clip.in + toSrc(ctx, clip, s - clip.start)),
  };
  return mkReplace('Trim in', trackIdx, clip, after);
}

export function trimOut(ctx, tracks, trackIdx, clipId, desiredEnd) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip) return null;
  const b = trimBounds(ctx, tracks, trackIdx, clipId);
  const e = Math.max(b.minEnd, Math.min(q(desiredEnd), b.maxEnd));
  if (e === clip.start + clip.dur) return null;
  return mkReplace('Trim out', trackIdx, clip, { ...clip, dur: e - clip.start });
}

// Shift every keyframe in a clip's kf by `delta` SEQUENCE frames — keyframes are
// timeline-anchored, so a move re-times them with the clip (else a moved clip's
// animation would freeze on the held end value). New kf object; values untouched.
function shiftKf(kf, delta) {
  if (!kf || !delta) return kf;
  const out = {};
  for (const k of Object.keys(kf)) out[k] = kf[k].map((e) => ({ ...e, f: e.f + delta }));
  return out;
}

export function move(ctx, tracks, fromIdx, clipId, toIdx, toStart) {
  const clip = findClip(tracks, fromIdx, clipId);
  const s = q(toStart);
  if (!clip || (fromIdx === toIdx && s === clip.start)) return null;
  const moved = { ...clip, start: s };
  if (clip.kf) moved.kf = shiftKf(clip.kf, s - clip.start);
  return {
    label: 'Move',
    apply: (ts) => mapTrack(mapTrack(ts, fromIdx, cs => without(cs, clipId)), toIdx, cs => insertSorted(cs, moved)),
    invert: (ts) => mapTrack(mapTrack(ts, toIdx, cs => without(cs, clipId)), fromIdx, cs => insertSorted(cs, clip)),
  };
}

export function remove(tracks, trackIdx, clipId) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip) return null;
  return {
    label: 'Delete',
    apply: (ts) => mapTrack(ts, trackIdx, cs => without(cs, clipId)),
    invert: (ts) => mapTrack(ts, trackIdx, cs => insertSorted(cs, clip)),
  };
}

// Downstream = clips with start > clip.start; no-overlap guarantees they all
// sit at/after the deleted clip's end, so a uniform -dur shift can't collide.
export function rippleDelete(tracks, trackIdx, clipId) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip) return null;
  const d = clip.dur;
  return {
    label: 'Ripple delete',
    apply: (ts) => mapTrack(ts, trackIdx, cs =>
      without(cs, clipId).map(c => (c.start > clip.start ? { ...c, start: c.start - d } : c))),
    invert: (ts) => mapTrack(ts, trackIdx, cs =>
      insertSorted(cs.map(c => (c.start >= clip.start ? { ...c, start: c.start + d } : c)), clip)),
  };
}

// Patch clip-level properties (gain/mute — SF9) as a stack op.
export function setClipProps(tracks, trackIdx, clipId, patch, label) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip) return null;
  const after = { ...clip, ...patch };
  if (Object.keys(patch).every(k => after[k] === clip[k])) return null;
  return mkReplace(label || 'Edit clip', trackIdx, clip, after);
}

// Per-clip layer transform (Compositing & Titles SF2) — identity-absent like
// grade: a null/identity transform DELETES the key so a reverted clip
// serializes byte-identical to one never transformed. One mkReplace op = one
// undo entry per gesture. `transform` may be partial; normalizeTransform fills
// + rounds it (and returns null for identity).
export function setClipTransform(tracks, trackIdx, clipId, transform) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip) return null;
  const next = normalizeTransform(transform);
  if (next == null && clip.transform == null) return null; // identity → identity
  let after;
  if (next == null) { const { transform: _drop, ...rest } = clip; after = rest; }
  else after = { ...clip, transform: next };
  return mkReplace('Transform', trackIdx, clip, after);
}

// Insert a NEW title clip (kind:'title', mediaId:null) at `frame` on a track as
// one undo op (Compositing & Titles SF10). A title has no audio (gain 0 / mute),
// carries a normalized `title` model, and reuses the transform/keyframe/overlay
// machinery. The caller picks a free slot; insertSorted keeps the lane ordered.
// `frame` / `dur` are SEQUENCE frames.
export function insertTitle(tracks, trackIdx, frame, dur, title) {
  if (!tracks[trackIdx]) return null;
  const clip = {
    id: newId(),
    kind: 'title',
    mediaId: null,
    start: q(frame),
    dur: Math.max(1, q(dur)),
    in: 0,
    gain: 0,
    mute: true,
    title: normalizeTitle(title),
  };
  return {
    label: 'Add title',
    clipId: clip.id, // exposed so the caller can select the new clip
    apply: (ts) => mapTrack(ts, trackIdx, cs => insertSorted(cs, clip)),
    invert: (ts) => mapTrack(ts, trackIdx, cs => without(cs, clip.id)),
  };
}

// Patch a title clip's `title` model (shallow-merge + normalize) as one undo op.
// Unlike transform/kf, a title is never identity-absent — the key always stays.
export function setTitle(tracks, trackIdx, clipId, patch, label) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip || clip.kind !== 'title') return null;
  const after = { ...clip, title: normalizeTitle({ ...(clip.title || {}), ...patch }) };
  return mkReplace(label || 'Edit title', trackIdx, clip, after);
}

// Keyframe ops (Compositing & Titles SF8) — set/replace/remove a keyframe on a
// clip param track (pos/rot/opacity/gain), identity-absent like transform: when
// every track empties, the `kf` key is dropped so the clip round-trips byte-
// identical. `value === null` removes the keyframe AT `frame` (else it inserts or
// replaces); pos values are { x, y }, the rest scalars. `ease` (KF_EASES)
// defaults to preserving the existing entry's ease on a value edit, else linear.
// One mkReplace op = one undo entry per gesture.
export function setKeyframe(tracks, trackIdx, clipId, param, frame, value, ease) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip || !CLIP_KF_KEYS.includes(param)) return null;
  const f = q(frame);
  const kf = clip.kf ? { ...clip.kf } : {};
  const cur = Array.isArray(kf[param]) ? kf[param].slice() : [];
  const idx = cur.findIndex((k) => k.f === f);
  if (value === null) {
    if (idx < 0) return null;
    cur.splice(idx, 1);
  } else {
    const entry = { f, v: value };
    const keepEase = ease ?? (idx >= 0 ? cur[idx].ease : undefined);
    if (keepEase && keepEase !== 'linear') entry.ease = keepEase;
    if (idx >= 0) cur[idx] = entry; else cur.push(entry);
  }
  if (cur.length) kf[param] = cur; else delete kf[param];
  const nextKf = normalizeKf(kf, CLIP_KF_KEYS);
  let after;
  if (nextKf == null) { const { kf: _drop, ...rest } = clip; after = rest; }
  else after = { ...clip, kf: nextKf };
  return mkReplace('Keyframe', trackIdx, clip, after);
}

// Cycle the ease of the keyframe AT `frame` on a clip param track
// (linear→in→out→inout→linear). No-op unless a keyframe sits exactly there.
export function cycleKeyframeEase(tracks, trackIdx, clipId, param, frame) {
  const clip = findClip(tracks, trackIdx, clipId);
  const cur = clip?.kf?.[param];
  if (!cur) return null;
  const f = q(frame);
  const idx = cur.findIndex((k) => k.f === f);
  if (idx < 0) return null;
  const next = KF_EASES[(KF_EASES.indexOf(cur[idx].ease || 'linear') + 1) % KF_EASES.length];
  const entry = { f, v: cur[idx].v };
  if (next !== 'linear') entry.ease = next;
  const arr = cur.slice();
  arr[idx] = entry;
  return mkReplace('Keyframe ease', trackIdx, clip, { ...clip, kf: { ...clip.kf, [param]: arr } });
}

// Disarm a clip param (turn keyframing OFF): bake the value AT `frame` into the
// static transform/gain and drop the param's kf track — one op, no visual jump.
// (gain bakes to clip.gain; pos/rot/opacity bake to clip.transform.)
export function disarmClipKeyframes(tracks, trackIdx, clipId, param, frame) {
  const clip = findClip(tracks, trackIdx, clipId);
  if (!clip?.kf?.[param]) return null;
  const v = evaluate(clip.kf[param], q(frame));
  const kf = { ...clip.kf };
  delete kf[param];
  const nextKf = normalizeKf(kf, CLIP_KF_KEYS);
  let after = nextKf == null
    ? (() => { const { kf: _d, ...rest } = clip; return rest; })()
    : { ...clip, kf: nextKf };
  if (param === 'gain') {
    after = { ...after, gain: r3(v) };
  } else {
    const t = { ...(after.transform || {}) };
    if (param === 'pos') { t.x = v.x; t.y = v.y; } else t[param] = v;
    const nt = normalizeTransform(t);
    if (nt) after = { ...after, transform: nt };
    else { const { transform: _d, ...rest } = after; after = rest; }
  }
  return mkReplace('Keyframe off', trackIdx, clip, after);
}

// Master volume is a document-level field, not a tracks mutation — the op
// carries applyDoc/invertDoc instead of apply/invert; the stack treats both
// shapes uniformly (EditorPage.applyOp branches on which pair exists).
export function setMasterVolume(doc, v) {
  const prev = doc?.masterVolume ?? 1;
  const next = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
  if (next === prev) return null;
  return {
    label: 'Master volume',
    applyDoc: (p) => ({ ...p, masterVolume: next }),
    invertDoc: (p) => ({ ...p, masterVolume: prev }),
  };
}

// Per-track / master mixer ops (Audio Post SF2) — document-level like
// setMasterVolume; the stack runs applyDoc/invertDoc. Patch shallow-merges onto
// mixer.tracks[trackId] (or mixer.master); volume/pan are clamped; a no-op
// returns null. EQ / comp / loudnorm sub-objects are passed WHOLE by the caller
// (a fresh object ref signals the change).
export function setTrackMix(doc, trackId, patch, label) {
  const cur = doc?.mixer?.tracks?.[trackId];
  if (!cur) return null;
  const cp = { ...patch };
  if ('volume' in cp) cp.volume = r3(clamp01(cp.volume));
  if ('pan' in cp) cp.pan = r3(clampPan(cp.pan));
  if ('mute' in cp) cp.mute = !!cp.mute;
  if ('solo' in cp) cp.solo = !!cp.solo;
  const next = { ...cur, ...cp };
  if (Object.keys(cp).every((k) => next[k] === cur[k])) return null;
  return {
    label: label || 'Track mix',
    applyDoc: (p) => ({ ...p, mixer: { ...p.mixer, tracks: { ...p.mixer.tracks, [trackId]: next } } }),
    invertDoc: (p) => ({ ...p, mixer: { ...p.mixer, tracks: { ...p.mixer.tracks, [trackId]: cur } } }),
  };
}

// Track volume automation (Compositing & Titles SF8) — document-level like
// setTrackMix: set/replace/remove a keyframe on mixer.tracks[id].kf.volume.
// `value === null` removes the keyframe at `frame`; an emptied track drops its
// `kf` key (identity-absent round-trip). `ease` (KF_EASES) preserves the existing
// entry's ease on a value edit by default.
export function setTrackVolumeKeyframe(doc, trackId, frame, value, ease) {
  const cur = doc?.mixer?.tracks?.[trackId];
  if (!cur) return null;
  const f = q(frame);
  const kf = cur.kf ? { ...cur.kf } : {};
  const arr = Array.isArray(kf.volume) ? kf.volume.slice() : [];
  const idx = arr.findIndex((k) => k.f === f);
  if (value === null) {
    if (idx < 0) return null;
    arr.splice(idx, 1);
  } else {
    const entry = { f, v: r3(clamp01(value)) };
    const keepEase = ease ?? (idx >= 0 ? arr[idx].ease : undefined);
    if (keepEase && keepEase !== 'linear') entry.ease = keepEase;
    if (idx >= 0) arr[idx] = entry; else arr.push(entry);
  }
  if (arr.length) kf.volume = arr; else delete kf.volume;
  const nextKf = normalizeKf(kf, TRACK_KF_KEYS);
  let nextTrack;
  if (nextKf == null) { const { kf: _drop, ...rest } = cur; nextTrack = rest; }
  else nextTrack = { ...cur, kf: nextKf };
  return {
    label: 'Track volume keyframe',
    applyDoc: (p) => ({ ...p, mixer: { ...p.mixer, tracks: { ...p.mixer.tracks, [trackId]: nextTrack } } }),
    invertDoc: (p) => ({ ...p, mixer: { ...p.mixer, tracks: { ...p.mixer.tracks, [trackId]: cur } } }),
  };
}

// Disarm a track's volume automation: bake the value AT `frame` into the static
// track volume and drop kf.volume — one op, no jump (mirrors disarmClipKeyframes).
export function disarmTrackVolume(doc, trackId, frame) {
  const cur = doc?.mixer?.tracks?.[trackId];
  if (!cur?.kf?.volume) return null;
  const v = r3(clamp01(evaluate(cur.kf.volume, q(frame))));
  const kf = { ...cur.kf };
  delete kf.volume;
  const nextKf = normalizeKf(kf, TRACK_KF_KEYS);
  const base = nextKf == null ? (() => { const { kf: _d, ...rest } = cur; return rest; })() : { ...cur, kf: nextKf };
  const nextTrack = { ...base, volume: v };
  return {
    label: 'Track volume keyframe off',
    applyDoc: (p) => ({ ...p, mixer: { ...p.mixer, tracks: { ...p.mixer.tracks, [trackId]: nextTrack } } }),
    invertDoc: (p) => ({ ...p, mixer: { ...p.mixer, tracks: { ...p.mixer.tracks, [trackId]: cur } } }),
  };
}

// Master bus inserts (EQ / comp / loudnorm) — master VOLUME is the document
// masterVolume field (setMasterVolume), not part of mixer.master.
export function setMasterMix(doc, patch, label) {
  const cur = doc?.mixer?.master;
  if (!cur) return null;
  const cp = { ...patch };
  const next = { ...cur, ...cp };
  if (Object.keys(cp).every((k) => next[k] === cur[k])) return null;
  return {
    label: label || 'Master mix',
    applyDoc: (p) => ({ ...p, mixer: { ...p.mixer, master: next } }),
    invertDoc: (p) => ({ ...p, mixer: { ...p.mixer, master: cur } }),
  };
}

// flattenEditList (SF9) — topmost-wins flatten across the ordered track array
// (higher index wins) into a linear segment list: the cuts-only program
// semantics, and the ONE artifact driving both preview and export (parity
// principle). Gaps emit explicit { mediaId: null } segments (playback renders
// them black). Contiguous same-source segments coalesce in the FRAME domain
// (`next.srcInF === cur.srcOutF` — split halves satisfy this by construction,
// so the easiest cuts never manufacture a swap); equal gain is also required,
// since a gain change is an audible boundary even when the picture is
// continuous, equal grade (by reference — Color Grading SF3) for the same
// reason on the picture side, and equal trackId (Audio Post SF2 — a track
// change routes through a different mixer chain, an audible boundary). Seconds
// fields ride along for playback
// (element.currentTime) and export (-ss/-t, corrected by startTimeOffset at
// argv-build time); `grade` rides for the preview LUT and the export lut3d.
export function flattenEditList(ctx, tracks) {
  const cuts = new Set([0]);
  let endF = 0;
  for (const t of tracks) {
    for (const c of t.clips) {
      cuts.add(c.start);
      cuts.add(c.start + c.dur);
      endF = Math.max(endF, c.start + c.dur);
    }
  }
  const bounds = [...cuts].filter(f => f <= endF).sort((a, b) => a - b);
  const raw = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k];
    const b = bounds[k + 1];
    if (b <= a) continue;
    let top = null;
    let topTrackId = null;
    for (let ti = tracks.length - 1; ti >= 0 && !top; ti--) {
      const found = tracks[ti].clips.find(c => c.start <= a && c.start + c.dur >= b && c.kind !== 'title');
      if (found) { top = found; topTrackId = tracks[ti].id; }
    }
    if (!top) {
      raw.push({ mediaId: null, clipId: null, trackId: null, t0F: a, t1F: b, gain: 0 });
      continue;
    }
    raw.push({
      mediaId: top.mediaId,
      clipId: top.id,
      trackId: topTrackId,
      t0F: a,
      t1F: b,
      srcInF: top.in + toSrc(ctx, top, a - top.start),
      srcOutF: top.in + toSrc(ctx, top, b - top.start),
      gain: top.mute ? 0 : (top.gain ?? 1),
      grade: top.grade ?? null,
      transform: top.transform ?? null,
      kf: top.kf ?? null,
      _sf: srcFps(ctx, top),
    });
  }
  const out = [];
  for (const s of raw) {
    const prev = out[out.length - 1];
    // Grade compares by REFERENCE: grades are immutable-by-convention
    // (gradeOps), split halves share the object, and a grade boundary is a
    // visible boundary exactly like the gain rule.
    if (prev && prev.mediaId === s.mediaId && prev.trackId === s.trackId && prev.gain === s.gain && prev.grade === s.grade && prev.transform === s.transform && prev.kf === s.kf
      && prev.t1F === s.t0F && (s.mediaId == null || prev.srcOutF === s.srcInF)) {
      prev.t1F = s.t1F;
      if (s.mediaId != null) prev.srcOutF = s.srcOutF;
    } else {
      out.push({ ...s });
    }
  }
  return out.map(s => ({
    mediaId: s.mediaId,
    clipId: s.clipId,
    trackId: s.trackId ?? null,
    gain: s.gain,
    grade: s.grade ?? null,
    transform: s.transform ?? null,
    kf: s.kf ?? null,
    t0F: s.t0F,
    t1F: s.t1F,
    srcInF: s.srcInF ?? null,
    srcOutF: s.srcOutF ?? null,
    t0: s.t0F / ctx.seqFps,
    t1: s.t1F / ctx.seqFps,
    srcIn: s.mediaId != null ? s.srcInF / s._sf : null,
    srcOut: s.mediaId != null ? s.srcOutF / s._sf : null,
  }));
}

// flattenComposite (Compositing & Titles SF3) — the layer-stack sibling of
// flattenEditList. Identical region-boundary cuts, but each region carries the
// FULL ordered list of active layers (bottom → top = track index 0 → N), not
// just the topmost winner. Drives the preview compositor (SF4/SF5) and, later,
// the export overlay stacks (SF7). A region with no spanning clip is a gap
// (layers: []). Adjacent regions coalesce only when their ENTIRE ordered layer
// set matches — per layer by the flattenEditList rules (same media/track/gain/
// grade/transform, source-continuous); clipId is intentionally ignored so split
// halves never manufacture a layer swap. grade and transform compare by
// REFERENCE (immutable-by-convention; split halves share the object).
export function flattenComposite(ctx, tracks) {
  const cuts = new Set([0]);
  let endF = 0;
  for (const t of tracks) {
    for (const c of t.clips) {
      cuts.add(c.start);
      cuts.add(c.start + c.dur);
      endF = Math.max(endF, c.start + c.dur);
    }
  }
  const bounds = [...cuts].filter(f => f <= endF).sort((a, b) => a - b);
  const raw = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k];
    const b = bounds[k + 1];
    if (b <= a) continue;
    const layers = [];
    for (let ti = 0; ti < tracks.length; ti++) {              // bottom → top
      const c = tracks[ti].clips.find(cl => cl.start <= a && cl.start + cl.dur >= b);
      if (!c) continue;
      layers.push({
        mediaId: c.mediaId,
        clipId: c.id,
        trackId: tracks[ti].id,
        srcInF: c.in + toSrc(ctx, c, a - c.start),
        srcOutF: c.in + toSrc(ctx, c, b - c.start),
        gain: c.mute ? 0 : (c.gain ?? 1),
        grade: c.grade ?? null,
        transform: c.transform ?? null,
        kf: c.kf ?? null,
        kind: c.kind ?? null,
        title: c.title ?? null,
        _sf: srcFps(ctx, c),
      });
    }
    raw.push({ t0F: a, t1F: b, layers });
  }
  // Coalesce adjacent regions whose whole ordered layer set matches.
  const layerMatch = (p, n) =>
    p.mediaId === n.mediaId && p.trackId === n.trackId && p.gain === n.gain
    && p.grade === n.grade && p.transform === n.transform && p.kf === n.kf
    && p.title === n.title
    && (p.mediaId == null || p.srcOutF === n.srcInF);
  const regionMatch = (p, n) =>
    p.t1F === n.t0F && p.layers.length === n.layers.length
    && p.layers.every((pl, i) => layerMatch(pl, n.layers[i]));
  const out = [];
  for (const r of raw) {
    const prev = out[out.length - 1];
    if (prev && regionMatch(prev, r)) {
      prev.t1F = r.t1F;
      prev.layers.forEach((pl, i) => { if (pl.mediaId != null) pl.srcOutF = r.layers[i].srcOutF; });
    } else {
      out.push({ t0F: r.t0F, t1F: r.t1F, layers: r.layers.map(l => ({ ...l })) });
    }
  }
  return out.map(r => ({
    t0F: r.t0F,
    t1F: r.t1F,
    t0: r.t0F / ctx.seqFps,
    t1: r.t1F / ctx.seqFps,
    layers: r.layers.map(l => ({
      mediaId: l.mediaId,
      clipId: l.clipId,
      trackId: l.trackId,
      gain: l.gain,
      grade: l.grade ?? null,
      transform: l.transform ?? null,
      kf: l.kf ?? null,
      kind: l.kind ?? null,
      title: l.title ?? null,
      srcInF: l.srcInF,
      srcOutF: l.srcOutF,
      srcIn: l.srcInF / l._sf,
      srcOut: l.srcOutF / l._sf,
    })),
  }));
}

// Compose sequential ops into ONE undo-stack entry. The caller must build
// each op against the previous op's applied state (fold apply forward);
// invert replays them in reverse.
export function batch(label, ops) {
  const list = (ops || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  return {
    label,
    apply: (ts) => list.reduce((a, o) => o.apply(a), ts),
    invert: (ts) => [...list].reverse().reduce((a, o) => o.invert(a), ts),
  };
}

// Removes `deltaFrames` (> 0) of material from the chosen edge and closes the
// downstream by the same amount. Head ripple keeps `start` anchored (in/dur
// shift); extension (delta < 0) is not an MVP op.
export function rippleTrim(ctx, tracks, trackIdx, clipId, edge, deltaFrames) {
  const clip = findClip(tracks, trackIdx, clipId);
  const d = q(deltaFrames);
  if (!clip || d <= 0) return null;
  const bounded = Math.min(d, clip.dur - 1);
  if (bounded <= 0) return null;
  const after = edge === 'in'
    ? { ...clip, dur: clip.dur - bounded, in: clip.in + toSrc(ctx, clip, bounded) }
    : { ...clip, dur: clip.dur - bounded };
  return {
    label: 'Ripple trim',
    apply: (ts) => mapTrack(ts, trackIdx, cs =>
      replace(cs, after).map(c => (c.id !== clipId && c.start > clip.start ? { ...c, start: c.start - bounded } : c))),
    invert: (ts) => mapTrack(ts, trackIdx, cs =>
      replace(cs, clip).map(c => (c.id !== clipId && c.start > clip.start ? { ...c, start: c.start + bounded } : c))),
  };
}

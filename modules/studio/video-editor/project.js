// Project model — schemaVersion 1. The JS-owned schema for
// Studio/Projects/<Name>/project.json (Rust stores it opaquely; the save
// command guards writes with the vault-wide f64-ms mtime contract).
//
// Time model (frame-quantized): clip.start / clip.dur are SEQUENCE frames;
// clip.in is SOURCE frames. Tracks are an ORDERED array — index = stacking
// order (bottom → top). The MVP creates exactly two video tracks; N-track
// support is a Compositing & Titles concern the schema already carries.
//
// Clip shape: { id, mediaId, start, dur, in, gain, mute } + optional,
// identity-absent { grade, transform } (Color Grading / Compositing) — a clip
// with neither serializes byte-identical to the bare shape.
// Media shape (filled by SF4):   { id, src, proxyHash, duration, fps, codec,
//                                  hasAudio, startTimeOffset }

export const SCHEMA_VERSION = 1;

export const newId = () =>
  (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ── Mixer model (Audio Post SF2) ────────────────────────────────────────────
// Per-track fader/pan/mute/solo + a 4-band EQ; a master bus with EQ +
// compressor + loudness target. normalizeProject fills it for every track so
// the rest of the app reads mixer.tracks[id] / mixer.master unconditionally.
// Identity (all defaults, loudnorm off) must round-trip to a byte-identical
// Phase-1 export (SF7). Track volume 0..1, pan -1..1; EQ gains in dB.
export const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(+v) ? +v : 1));
export const clampPan = (v) => Math.max(-1, Math.min(1, Number.isFinite(+v) ? +v : 0));
export const r3 = (v) => Math.round(v * 1000) / 1000;

const eqBands = () => ([
  { type: 'lowshelf', f: 120, g: 0, q: 0.7 },
  { type: 'peaking', f: 500, g: 0, q: 1 },
  { type: 'peaking', f: 2000, g: 0, q: 1 },
  { type: 'highshelf', f: 8000, g: 0, q: 0.7 },
]);
const trackMixDefault = () => ({ volume: 1, pan: 0, mute: false, solo: false, eq: { enabled: false, bands: eqBands() } });
// Master volume reuses the document `masterVolume` field (already wired to the
// preview graph, the TransportBar slider, and export) — the master bus here
// carries only the new processing.
const masterMixDefault = () => ({
  eq: { enabled: false, bands: eqBands() },
  comp: { enabled: false, threshold: -24, ratio: 4, attack: 0.003, release: 0.25, knee: 30, makeup: 0 },
  loudnorm: { enabled: false, target: -14 },
});

export function defaultMixer(trackIds = ['v1', 'v2']) {
  const tracks = {};
  for (const id of trackIds) tracks[id] = trackMixDefault();
  return { tracks, master: masterMixDefault() };
}

const mergeEq = (e, d) => {
  if (!e || typeof e !== 'object') return d;
  const bands = Array.isArray(e.bands) && e.bands.length === d.bands.length
    ? e.bands.map((b, i) => ({ ...d.bands[i], ...(b && typeof b === 'object' ? b : {}) }))
    : d.bands;
  return { enabled: !!e.enabled, bands };
};
const mergeTrackMix = (m) => {
  const d = trackMixDefault();
  if (!m || typeof m !== 'object') return d;
  const out = { volume: r3(clamp01(m.volume ?? d.volume)), pan: r3(clampPan(m.pan ?? d.pan)), mute: !!m.mute, solo: !!m.solo, eq: mergeEq(m.eq, d.eq) };
  // SF8 volume automation is identity-absent — only carry a `kf` when present so
  // a no-keyframe mixer round-trips byte-identical (mergeTrackMix otherwise
  // rebuilds a fixed shape and would silently drop it).
  const kf = normalizeKf(m.kf, TRACK_KF_KEYS);
  if (kf) out.kf = kf;
  return out;
};
const mergeMasterMix = (m) => {
  const d = masterMixDefault();
  if (!m || typeof m !== 'object') return d;
  return {
    eq: mergeEq(m.eq, d.eq),
    comp: { ...d.comp, ...(m.comp && typeof m.comp === 'object' ? m.comp : {}), enabled: !!(m.comp && m.comp.enabled) },
    loudnorm: { ...d.loudnorm, ...(m.loudnorm && typeof m.loudnorm === 'object' ? m.loudnorm : {}), enabled: !!(m.loudnorm && m.loudnorm.enabled) },
  };
};

// Fill a mixer for the given tracks: every track id gets an entry (missing →
// default), master always present, all values clamped. Unknown track ids in a
// saved mixer are dropped (they no longer exist).
export function normalizeMixer(mix, tracks) {
  const out = { tracks: {}, master: mergeMasterMix(mix && mix.master) };
  for (const t of (tracks || [])) out.tracks[t.id] = mergeTrackMix(mix && mix.tracks && mix.tracks[t.id]);
  return out;
}

export function newProject(name) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    // Defaults 1920×1080 @ 30 — match-first-media: the first imported clip's
    // probe overwrites these while `touched` is still false (SF4); the
    // sequence inspector sets touched on any manual edit.
    sequence: { width: 1920, height: 1080, fps: 30, touched: false },
    media: [],
    tracks: [
      { id: 'v1', clips: [] },
      { id: 'v2', clips: [] },
    ],
    masterVolume: 1,
    mixer: defaultMixer(['v1', 'v2']),
  };
}

// Defensive normalize for opened documents: unknown fields pass through
// untouched (forward-compat); missing core fields get defaults.
export function normalizeProject(doc, fallbackName) {
  const base = newProject(doc?.name || fallbackName || 'Untitled');
  if (!doc || typeof doc !== 'object') return base;
  const tracks = Array.isArray(doc.tracks) && doc.tracks.length ? doc.tracks : base.tracks;
  return {
    ...base,
    ...doc,
    sequence: { ...base.sequence, ...(doc.sequence || {}) },
    media: Array.isArray(doc.media) ? doc.media : [],
    tracks,
    mixer: normalizeMixer(doc.mixer, tracks),
  };
}

// ── Transform model (Compositing & Titles SF2) ──────────────────────────────
// Optional per-clip layer transform, identity-absent exactly like `grade`: a
// clip with no transform (or an identity one) serializes byte-identical to the
// bare clip shape — normalizeProject's `...doc` passthrough carries it forward
// untouched, and newProject never seeds it. Stored RESOLUTION-INDEPENDENT,
// normalized to sequence dims, shown as % / degrees in the UI (decision #6):
//   x, y     offset of the layer CENTER from the sequence center, as a fraction
//            of sequence width / height (0 = centered; 0.5 = half a frame over).
//   scale    uniform scale (1 = aspect-fit fill; anchor = center).
//   rot      rotation in DEGREES, clockwise, about the center.
//   opacity  0..1 alpha-over (1 = opaque).
//   crop     static inset { l, t, r, b }, each a 0..1 fraction of its source edge.
// Anchor is always the clip center; normal alpha-over blend only (decision #5).
export const IDENTITY_TRANSFORM = Object.freeze({
  x: 0, y: 0, scale: 1, rot: 0, opacity: 1,
  crop: Object.freeze({ l: 0, t: 0, r: 0, b: 0 }),
});

export function isIdentityTransform(t) {
  if (t == null) return true;
  const c = t.crop || {};
  return (t.x ?? 0) === 0 && (t.y ?? 0) === 0 && (t.scale ?? 1) === 1
    && (t.rot ?? 0) === 0 && (t.opacity ?? 1) === 1
    && (c.l ?? 0) === 0 && (c.t ?? 0) === 0 && (c.r ?? 0) === 0 && (c.b ?? 0) === 0;
}

// Coerce a (possibly partial) transform to a clean, rounded full object, or
// null when it is identity — callers store the null as ABSENCE (delete the key)
// so identity round-trips byte-identical. Scale floors at 0.01; opacity and
// crop edges clamp to 0..1; rotation wraps to (-360, 360).
export function normalizeTransform(t) {
  if (isIdentityTransform(t)) return null;
  const c = t.crop || {};
  const cl = (v) => Math.max(0, Math.min(1, Number.isFinite(+v) ? +v : 0));
  return {
    x: r3(+t.x || 0),
    y: r3(+t.y || 0),
    scale: r3(Math.max(0.01, Number.isFinite(+t.scale) ? +t.scale : 1)),
    rot: r3((+t.rot || 0) % 360),
    opacity: r3(clamp01(t.opacity ?? 1)),
    crop: { l: r3(cl(c.l)), t: r3(cl(c.t)), r: r3(cl(c.r)), b: r3(cl(c.b)) },
  };
}

// ── Keyframe model (Compositing & Titles SF8) ───────────────────────────────
// Optional per-param animation tracks, identity-absent exactly like `transform`:
// a clip (or mixer track) with no keyframes stores no `kf` key and round-trips
// byte-identical. A clip's kf animates pos/rot/opacity (visual) + gain (audio);
// a mixer track's kf animates volume. Each track is a sorted array of
// { f, v, ease } where f = SEQUENCE frame (absolute), v = number (or {x,y} for
// pos), ease ∈ KF_EASES with 'linear' stored as ABSENCE. Keyframes are timeline-
// anchored: the move op re-times them with the clip (trim/ripple leave them put).
// Keyframed SCALE & CROP are deferred (ffmpeg can't express per-frame scale
// cleanly) — decision #3.
export const KF_EASES = ['linear', 'in', 'out', 'inout'];
export const CLIP_KF_KEYS = ['pos', 'rot', 'opacity', 'gain'];
export const TRACK_KF_KEYS = ['volume'];

const r3v = (v) =>
  typeof v === 'number'
    ? r3(v)
    : (v && typeof v === 'object' ? { x: r3(+v.x || 0), y: r3(+v.y || 0) } : v);

const cleanKfEntry = (k) => {
  const e = { f: Math.round(+k.f || 0), v: r3v(k.v) };
  if (KF_EASES.includes(k.ease) && k.ease !== 'linear') e.ease = k.ease;
  return e;
};

const sortKfTrack = (arr) => {
  if (!Array.isArray(arr) || !arr.length) return null;
  const t = arr.filter((k) => k && Number.isFinite(+k.f)).map(cleanKfEntry).sort((a, b) => a.f - b.f);
  return t.length ? t : null;
};

// Keep only the allowed param tracks (each sorted + cleaned); null when every
// track is empty so callers store the absence (identity-absent round-trip).
export function normalizeKf(kf, keys) {
  if (!kf || typeof kf !== 'object') return null;
  const out = {};
  for (const k of (keys || [])) {
    const t = sortKfTrack(kf[k]);
    if (t) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

export function isIdentityKf(kf, keys) {
  return normalizeKf(kf, keys) == null;
}

// ── Title model (Compositing & Titles SF10) ─────────────────────────────────
// A title is a CLIP KIND (kind:'title', mediaId:null) on a regular video track,
// reusing the transform/keyframe/compositing/timeline machinery. Unlike grade/
// transform/kf, a title clip's `title` object is the clip's CONTENT — never
// identity-absent. drawTitle(model, scale) renders it to a TIGHT text-box canvas
// in BOTH the preview overlay and the export PNG (one renderer = inherent
// parity). The box is authored in SEQUENCE pixels, so it maps 1:1 (fit=1), not
// aspect-fit-fill like video. A project with no title clips still serializes
// byte-identical: normalizeProject passes clips through verbatim and newProject
// never seeds title/kind.
export const TITLE_FONTS = Object.freeze([
  'Segoe UI', 'Arial', 'Georgia', 'Impact', 'Consolas',
  'Times New Roman', 'Verdana', 'Trebuchet MS', 'Courier New', 'Tahoma',
]);

export function defaultTitle() {
  return {
    text: 'Title', font: 'Segoe UI', size: 96, color: '#ffffff', align: 'center',
    bold: false, italic: false,
    stroke: { color: '#000000', width: 0 },
    shadow: { color: '#000000', blur: 0, dx: 0, dy: 0 },
    background: null,
  };
}

// Coerce a (possibly partial) title model to a clean, rounded object. font
// clamps to TITLE_FONTS; size floors at 1 (sequence px); align ∈ left/center/
// right; background is null unless a lower-third bar is set {color,padX,padY}.
export function normalizeTitle(t) {
  if (!t || typeof t !== 'object') return defaultTitle();
  const s = t.stroke || {};
  const sh = t.shadow || {};
  const out = {
    text: typeof t.text === 'string' ? t.text : 'Title',
    font: TITLE_FONTS.includes(t.font) ? t.font : 'Segoe UI',
    size: Math.max(1, r3(+t.size || 96)),
    color: typeof t.color === 'string' ? t.color : '#ffffff',
    align: ['left', 'center', 'right'].includes(t.align) ? t.align : 'center',
    bold: !!t.bold,
    italic: !!t.italic,
    stroke: { color: typeof s.color === 'string' ? s.color : '#000000', width: Math.max(0, r3(+s.width || 0)) },
    shadow: {
      color: typeof sh.color === 'string' ? sh.color : '#000000',
      blur: Math.max(0, r3(+sh.blur || 0)),
      dx: r3(+sh.dx || 0),
      dy: r3(+sh.dy || 0),
    },
    background: null,
  };
  if (t.background && typeof t.background === 'object') {
    const bg = t.background;
    out.background = {
      color: typeof bg.color === 'string' ? bg.color : '#000000',
      padX: Math.max(0, r3(+bg.padX || 0)),
      padY: Math.max(0, r3(+bg.padY || 0)),
    };
  }
  return out;
}

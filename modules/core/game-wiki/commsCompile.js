// commsCompile.js — Comms Extraction (Deadlock Scrim Coaching, sub-plan 4) helpers.
// Pure ESM (no React, no @host) so it round-trips through a Node harness exactly like
// scrimSchema.js / matchData.js / noteCompile.js. The per-match Extract Comms button
// transcribes a Scrim Recording's audio (via coaching_extract_audio + the mortar-pestle-stt
// sidecar) and persists the full segments to a `.commstranscript.…` sidecar; this module
// renders the one-line `### Comms Transcript` opaque summary (a pointer to that sidecar)
// and parses the sidecar back into a view-model.

const MARKER = '_(Run-Process-owned — regenerated)_';

// Whole seconds → m:ss. Local mirror of matchData.clock so this module stays import-free
// / standalone-harnessable. "0:00" for missing/NaN.
function mmss(s) {
  const v = Number.isFinite(Number(s)) ? Math.max(0, Math.floor(Number(s))) : 0;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

// Normalize one raw segment → { t0Ms, t1Ms, text, speaker, cluster }. `cluster` (SF6
// diarization) is the 0-based speaker-cluster id, or null (mic / pre-diarization).
function normSeg(s) {
  return {
    t0Ms: Number(s?.t0Ms) || 0,
    t1Ms: Number(s?.t1Ms) || 0,
    text: String(s?.text ?? '').trim(),
    speaker: s?.speaker ?? null,
    cluster: s?.cluster ?? null,
  };
}

// Parse the `.commstranscript.…` sidecar JSON into a [{ t0Ms, t1Ms, text, speaker, cluster }]
// view-model. Tolerant: malformed/empty JSON → [] (degrade to a gap, never throw — like
// matchData's extractMatch). Accepts BOTH shapes with no migration: the legacy bare array
// (sub-plan 4, speaker null) AND the SF6 object { segments, clusters, micSpeaker }.
export function parseSegments(jsonStr) {
  let raw;
  try { raw = JSON.parse(jsonStr); } catch { return []; }
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.segments) ? raw.segments : null);
  if (!arr) return [];
  return arr.map(normSeg);
}

// Parse the sidecar into the full SF6 view-model { segments, clusters, micSpeaker }. Tolerant
// like parseSegments; a legacy bare array yields empty clusters + a default micSpeaker (so the
// Speakers panel simply shows nothing to name on an old, un-diarized transcript).
export function parseCommsSidecar(jsonStr) {
  let raw;
  try { raw = JSON.parse(jsonStr); } catch { return { segments: [], clusters: [], micSpeaker: 'You' }; }
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.segments) ? raw.segments : []);
  const clusters = Array.isArray(raw?.clusters)
    ? raw.clusters.map((c) => ({ clusterId: Number(c?.clusterId), embedding: Array.isArray(c?.embedding) ? c.embedding : [] }))
    : [];
  return { segments: arr.map(normSeg), clusters, micSpeaker: raw?.micSpeaker ?? 'You' };
}

// Build the SF6 object-shape sidecar payload (the caller JSON.stringifies it). Segments keep
// speaker + cluster; clusters carry the per-cluster mean embeddings so a later relabel can
// retrain the matched voiceprint; micSpeaker labels the mic (you) track.
export function buildCommsSidecar({ segments = [], clusters = [], micSpeaker = 'You' } = {}) {
  return {
    segments: (Array.isArray(segments) ? segments : []).map((s) => ({
      t0Ms: Number(s?.t0Ms) || 0,
      t1Ms: Number(s?.t1Ms) || 0,
      text: String(s?.text ?? '').trim(),
      speaker: s?.speaker ?? null,
      cluster: s?.cluster ?? null,
    })),
    clusters: (Array.isArray(clusters) ? clusters : []).map((c) => ({
      clusterId: Number(c?.clusterId),
      embedding: Array.isArray(c?.embedding) ? c.embedding : [],
    })),
    micSpeaker,
  };
}

// Render the one-line `### Comms Transcript` opaque body: a summary headline + a pointer
// to the raw sidecar + the regenerated-marker. The full segments live in the sidecar
// (keeps the .md lean — opaque bodies round-trip verbatim on every save). `durationS`
// falls back to the last segment's end time.
export function renderCommsSummary({ n, segments = [], durationS, sidecarFileName } = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  const durS = durationS != null
    ? durationS
    : (segs.length ? Math.max(...segs.map((s) => Number(s?.t1Ms) || 0)) / 1000 : 0);
  const lines = [
    `**Match ${n} comms · ${mmss(durS)} · ${segs.length} segment${segs.length === 1 ? '' : 's'}**`,
  ];
  if (sidecarFileName) lines.push('', `_Raw: \`${sidecarFileName}\`_`);
  lines.push('', MARKER);
  return lines.join('\n');
}

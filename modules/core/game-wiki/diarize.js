// diarize.js — Comms Diarization (Deadlock Scrim Coaching, sub-plan 6 SF2) align + merge
// helpers. Pure ESM (no React, no @host) so it round-trips through a Node harness exactly
// like commsCompile.js / scrimSchema.js. The Extract Comms flow transcribes the mic track
// (all one speaker — you) and the isolated Discord comms track, diarizes the comms track
// (mortar-pestle-stt `stt_diarize_file` → speaker spans + per-cluster embeddings), then uses
// these to (1) attribute each comms text segment to a speaker cluster by time-overlap,
// (2) label clusters (voiceprint names arrive in SF3; until then "Speaker N"), and
// (3) merge the mic + comms transcripts into one time-ordered, speaker-labeled list.
//
// Wire shapes (camelCase, from the host commands):
//   comms/mic text segments: { t0Ms, t1Ms, text }
//   diarization spans:       { t0Ms, t1Ms, clusterId }   (0-based clusterId)

// Attribute each comms text segment to the speaker cluster it overlaps MOST in time.
// Returns fresh segments each carrying `cluster` (0-based id, or null when no diarization
// span overlaps it — a gap the caller renders as Unknown). Ties resolve to the lowest
// cluster id (deterministic). Never mutates the inputs.
export function alignDiarization(commsSegments, diarSpans) {
  const spans = Array.isArray(diarSpans) ? diarSpans : [];
  const segs = Array.isArray(commsSegments) ? commsSegments : [];
  return segs.map((seg) => {
    const t0 = Number(seg?.t0Ms) || 0;
    const t1 = Number(seg?.t1Ms) || 0;
    // Total overlap (ms) contributed to each cluster by all its spans.
    const byCluster = new Map();
    for (const sp of spans) {
      const cid = Number(sp?.clusterId);
      if (!Number.isInteger(cid) || cid < 0) continue;
      const s0 = Number(sp?.t0Ms) || 0;
      const s1 = Number(sp?.t1Ms) || 0;
      const ov = Math.min(t1, s1) - Math.max(t0, s0);
      if (ov > 0) byCluster.set(cid, (byCluster.get(cid) || 0) + ov);
    }
    let best = null;
    let bestOv = 0;
    for (const [cid, ov] of byCluster) {
      if (ov > bestOv || (ov === bestOv && best !== null && cid < best)) {
        best = cid;
        bestOv = ov;
      }
    }
    return { ...seg, cluster: best };
  });
}

// NOTE: unattributed rows (cluster: null) are KEPT and rendered as "Unknown" — never
// deleted. A dropUnattributed filter used to remove them as silence hallucinations
// ("Thank you." spam), but the engine's VAD pre-pass now kills those at source, and
// the diarizer's own coverage holes made the filter eat minutes of real callouts.

// A 0-based cluster id → display label. `nameMap` (SF3 voiceprint matches) wins; otherwise
// a stable "Speaker N" (1-based for humans). A null/negative cluster (no overlap) = Unknown.
export function labelForCluster(clusterId, nameMap = {}) {
  if (clusterId == null || clusterId < 0) return 'Unknown';
  return nameMap[clusterId] ?? `Speaker ${clusterId + 1}`;
}

// Merge the mic transcript (every segment = you) with the aligned comms transcript into one
// list sorted by start time. `commsSegments` must already carry `cluster` (run
// alignDiarization first). Ties keep mic before comms (concat order) — Array.sort is stable.
// `nameMap` maps cluster ids → player names (SF3); absent → "Speaker N".
// Each output segment carries `cluster` too (SF4 persists it so an inline relabel can
// find + reassign a whole speaker cluster after reload). Mic segments are you, not a
// diarized cluster → cluster: null.
export function mergeTranscripts({
  micSegments = [],
  commsSegments = [],
  micSpeaker = 'You',
  nameMap = {},
} = {}) {
  const mic = (Array.isArray(micSegments) ? micSegments : []).map((s) => ({
    t0Ms: Number(s?.t0Ms) || 0,
    t1Ms: Number(s?.t1Ms) || 0,
    text: String(s?.text ?? '').trim(),
    speaker: micSpeaker,
    cluster: null,
  }));
  const comms = (Array.isArray(commsSegments) ? commsSegments : []).map((s) => {
    const cluster = s?.cluster ?? null;
    return {
      t0Ms: Number(s?.t0Ms) || 0,
      t1Ms: Number(s?.t1Ms) || 0,
      text: String(s?.text ?? '').trim(),
      speaker: labelForCluster(cluster, nameMap),
      cluster,
    };
  });
  return [...mic, ...comms].sort((a, b) => a.t0Ms - b.t0Ms);
}

// Stable, tolerant name → oklch color for per-speaker tinting in the transcript. The same
// name always yields the same hue (FNV-1a hash → hue), so a speaker keeps one color across
// segments + scrims. Empty/nullish (Unknown, before naming) → the muted token.
export function speakerColor(name) {
  const s = String(name ?? '').trim();
  if (!s) return 'var(--text-muted)';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const hue = (h >>> 0) % 360;
  return `oklch(0.72 0.13 ${hue})`;
}

// Mixed-track fallback: remove the given cluster ids (e.g. the game-announcer cluster) from
// a diarization result, dropping their spans + embeddings and re-counting speakers. The
// announcer cluster is identified by the user in the SF4 Speakers panel (a pure function
// can't tell VO from a player without audio features) — this is the mechanism that applies
// that choice. Never mutates the input.
export function dropClusters(diar, clusterIds) {
  const drop = new Set((Array.isArray(clusterIds) ? clusterIds : []).map(Number));
  const segments = (diar?.segments || []).filter((s) => !drop.has(Number(s?.clusterId)));
  const clusters = (diar?.clusters || []).filter((c) => !drop.has(Number(c?.clusterId)));
  const remaining = new Set(segments.map((s) => Number(s?.clusterId)));
  return { ...diar, segments, clusters, numSpeakers: remaining.size };
}

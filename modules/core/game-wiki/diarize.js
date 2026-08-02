// diarize.js — transcript merge + speaker-tint helpers for the Deadlock coaching flow.
// Pure ESM (no React, no @host) so it round-trips through a Node harness exactly like
// commsCompile.js. Job 3 (2026-08-02) replaced voice-matching with an AUDIO-TRACK split:
// CoachPopup transcribes OBS track 1 (mic, all coach) and track 3 (Discord, all student)
// separately and calls `mergeTranscripts` to interleave them by time. The old
// diarize-then-attribute path (alignDiarization + dropClusters, and the stt_diarize_file
// spans they consumed) had no caller left after that and was deleted 2026-08-02.
//
// Wire shapes (camelCase, from the host commands):
//   comms/mic text segments: { t0Ms, t1Ms, text }

// A 0-based cluster id → display label. `nameMap` wins; otherwise a stable "Speaker N"
// (1-based for humans). A null/negative cluster (no overlap) = Unknown. Private: only
// mergeTranscripts calls it, and coachTranscribe.selftest.mjs exercises it through there.
function labelForCluster(clusterId, nameMap = {}) {
  if (clusterId == null || clusterId < 0) return 'Unknown';
  return nameMap[clusterId] ?? `Speaker ${clusterId + 1}`;
}

// Merge the mic transcript (every segment = you) with the comms transcript into one list
// sorted by start time. `commsSegments` may carry `cluster` (the track-split path passes a
// constant id). Ties keep mic before comms (concat order) — Array.sort is stable.
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

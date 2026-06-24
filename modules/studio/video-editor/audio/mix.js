// Shared mixer resolution (Audio Post SF3). The global solo predicate and the
// per-track effective preview params, used by the preview graph (and, in SF7,
// the export builder). Kept pure + framework-free so it unit-tests and reuses.

export function anySolo(mixer) {
  const t = (mixer && mixer.tracks) || {};
  return Object.keys(t).some((id) => t[id] && t[id].solo);
}

// A track is audible when it isn't muted AND (nothing is soloed OR it is
// soloed). Mirror Fairlight: solo-on-nothing → everything plays.
export function trackAudible(mixer, trackId) {
  const m = mixer && mixer.tracks && mixer.tracks[trackId];
  if (!m) return true;
  if (m.mute) return false;
  return anySolo(mixer) ? !!m.solo : true;
}

// { volume, pan, audible, eq } for the preview fader/pan/EQ nodes (Audio Post
// SF5 adds eq — the whole {enabled,bands} object, applied to the element's
// inline biquads at the flip and on live edits).
export function resolveTrackParams(mixer, trackId) {
  const m = (mixer && mixer.tracks && mixer.tracks[trackId]) || null;
  return {
    volume: m ? (m.volume ?? 1) : 1,
    pan: m ? (m.pan ?? 0) : 0,
    audible: trackAudible(mixer, trackId),
    eq: m ? (m.eq ?? null) : null,
  };
}

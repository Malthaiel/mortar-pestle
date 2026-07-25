// LevelMeter — one audio level bar: an RMS fill (body) + a peak line (tick).
// Heights are written by the caller's rAF loop through the callback refs, never
// through React state — a meter repainting via setState re-renders its whole
// module 30-60x/sec.
//
// Promoted from the video editor's MixSuite `Meter` (Broadcast SP6 SF1).
// Callers: MixSuite channel strips (mono, one bar) and Broadcast's mixer strip
// (stereo — render one LevelMeter PER CHANNEL side by side rather than teaching
// this component about channel counts).
//
// ponytail: deliberately single-bar. A `channels` prop would only move the
// side-by-side layout from the caller into here for zero gain.
//
// NOT the same component as the overlay's VuMeter (mono gradient bar, no peak
// hold, one caller) — that one stays where it is.

export default function LevelMeter({ peakRef, rmsRef }) {
  return (
    <div style={{ position: 'relative', width: 7, height: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      <div ref={rmsRef} style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: '0%', background: 'color-mix(in oklab, var(--accent) 55%, transparent)' }} />
      <div ref={peakRef} style={{ position: 'absolute', left: 0, bottom: '0%', width: '100%', height: 2, background: 'var(--text)', pointerEvents: 'none' }} />
    </div>
  );
}

// The DESIGN dB contract: floor at −60 dB, 0 dB = full. A LINEAR fill makes
// normal levels invisible (−24 dB ≈ 0.06 → a 6% nub); on a dB scale that same
// level reads ~60%, and a fader/mute change sweeps the bar.
export const METER_FLOOR_DB = -60;

// dB → 0..1 fill fraction. Broadcast's engine reports dB directly.
export const dbToFill = (db) => {
  if (!Number.isFinite(db) || db <= METER_FLOOR_DB) return 0;
  if (db >= 0) return 1;
  return (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
};

// Linear amplitude (0..1) → fill fraction. MixSuite reads raw analyser
// amplitudes, so it converts here.
export const ampToFill = (a) => (a > 0 ? dbToFill(20 * Math.log10(a)) : 0);

// Live mic level meter — a smooth gradient fill on a dB scale. A LINEAR fill of
// raw RMS hides normal speech as a tiny nub (per the meter-dB-scale memo), so we
// map 20·log10(rms) from a −60 dB floor to 0 dB into a 0..1 fill. Verify liveness
// by SPEAKING (the fill should track your voice), not by an idle bounce.

const FLOOR_DB = -60;

export default function VuMeter({ rms = 0, active = false, accent }) {
  const safe = Math.max(rms, 1e-6);
  const db = 20 * Math.log10(safe);
  const fill = Math.max(0, Math.min(1, (db - FLOOR_DB) / (0 - FLOOR_DB)));
  const a = accent || 'var(--accent)';
  return (
    <div className="stt-vu" aria-hidden="true" title="Mic level">
      <div
        className="stt-vu-fill"
        style={{
          width: `${(active ? fill : 0) * 100}%`,
          background: `linear-gradient(90deg,
            color-mix(in oklch, ${a} 55%, var(--surface)) 0%,
            ${a} 70%,
            color-mix(in oklch, ${a}, white 12%) 100%)`,
        }}
      />
    </div>
  );
}

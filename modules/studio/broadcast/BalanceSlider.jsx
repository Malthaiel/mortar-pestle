// BalanceSlider — bipolar left/right pan for one audio source (SP6 SF3).
//
// Approved net-new at the 2026-07-25 New-Visuals gate: the shared `Slider` is
// unipolar with no centre detent, and MixSuite's bipolar control is vertical
// and welded to its EQ. This is the horizontal, centre-snapping one.
//
// Value is libobs's 0..1 with 0.5 = centre, passed through untouched — the
// engine owns the balance semantics, this only presents them.

import React from 'react';

// Anything inside this distance of centre snaps to exactly 0.5. Without it a
// pointer drag practically never lands on true centre, and a source sitting at
// 0.497 is audibly off but visually indistinguishable from centred.
const SNAP = 0.02;

export const CENTRE = 0.5;

const label = (v) => {
  if (Math.abs(v - CENTRE) < 0.005) return 'C';
  const pct = Math.round(Math.abs(v - CENTRE) * 200);
  return `${v < CENTRE ? 'L' : 'R'} ${pct}`;
};

export default function BalanceSlider({ value = CENTRE, accent, onChange, title }) {
  const v = Number.isFinite(value) ? value : CENTRE;

  const handle = (raw) => {
    const next = Math.abs(raw - CENTRE) < SNAP ? CENTRE : raw;
    if (next !== v) onChange(next);
  };

  return (
    <div className="bcast-balance" title={title || 'Balance — double-click to centre'}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={v}
        onChange={(e) => handle(Number(e.target.value))}
        // Double-click is the fastest route back to true centre and costs
        // nothing; the snap zone alone still makes centre hard to hit exactly.
        onDoubleClick={() => onChange(CENTRE)}
        style={{ flex: 1, accentColor: accent }}
      />
      <span className="bcast-balance-read">{label(v)}</span>
    </div>
  );
}

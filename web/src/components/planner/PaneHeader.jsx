// Shared header label for every Planner pane.
//
// The Planner section headers — Events, Routine, Tasks List, Quick Notes —
// render through this one component so a size / weight / color change is a
// single edit here instead of a hunt across the panes. The `date` variant went
// with the date sublabel: that chip is a plain candy chip now (2026-08-27), so
// it inherits the face's own colour and size like every other chip in the row.

// No `color` on purpose (2026-09-01) — the label INHERITS, so a host that wants
// it muted-at-rest / white-on-hover (the .is-panel rail tiles) can say so in CSS
// instead of losing to an inline colour. Outside a tile the ambient IS --text,
// so Nutrition / Fitness look exactly as before.
const BASE = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  fontWeight: 700,
};

export default function PaneHeader({ children }) {
  return (
    <div style={{ ...BASE, letterSpacing: '0.08em' }}>
      {children}
    </div>
  );
}

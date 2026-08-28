// Planner pane widths — the draggable seams between columns. Persisted as
// pixel widths (the modal is a stable desktop surface, so px tracks the same
// way the left sidebar and right toolkit widths do — see AppShell.jsx /
// Sidebar.jsx). ResizeSeam owns the actual localStorage write (via
// `config.key`); this hook seeds the initial value and syncs other windows
// through the `storage` event.
//
// Pivot 2 collapsed the old per-layout CONFIG map (split / three-column died
// with the layout toggle) to a single calendar config under a fresh key; the
// legacy keys are removed once at module load. The Health Column epic
// parameterized the hook so a SECOND instance can drive the always-on health
// column's own seam (HEALTH_CONFIG) — same shape, independent key.
//
// UI preference state — cache-only, exempt from the vault-canonical rule per
// Build Convention #8.

import { useEffect, useState } from 'react';

// Two equal columns by default: the calendar and the day pane each flex to an
// equal half of the modal AT ANY SIZE — the modal scales with the app window
// (PlannerModal width:92vw/height:90vh), so the columns scale with it. This
// hook stores only the OVERRIDE a user sets by dragging the seam; with no
// override readWidth returns null and PlannerModal renders the calendar
// flex:1 (an equal share). `def` is just the pre-measure fallback; `min`/`max`
// are the comfort bounds PlannerModal widens around the live size so a drag
// never jumps.
const CALENDAR_CONFIG = {
  key: 'planner:calWidth:v5',
  def: 640, min: 380, max: 980,
  // The presets ARE the snap set — ResizeSeam derives it from them. Labels are
  // Compact / Default / Wide at every seam in the app ('Balanced' was this
  // seam's own word for the middle option).
  presets: [
    { label: 'Compact', value: 480 },
    { label: 'Default', value: 640 },
    { label: 'Wide',    value: 820 },
  ],
};

// Health column (Planner's always-on third column, Health Column epic). Unlike
// the calendar it has no responsive "equal half" mode — it's always a pinned
// px basis (default 320) the user can resize via its own seam. Independent
// localStorage key so the two seams never collide.
export const HEALTH_CONFIG = {
  key: 'planner:healthWidth:v1',
  def: 320, min: 240, max: 480,
  // 'Narrow' was this seam's own word for the smallest option; every seam in
  // the app now reads Compact / Default / Wide.
  presets: [
    { label: 'Compact', value: 280 },
    { label: 'Default', value: 320 },
    { label: 'Wide',    value: 400 },
  ],
};

// Calendar HEIGHT — the planner dashboard stacked its calendar over the day
// list (user-directed 2026-08-27), so the two now share a horizontal seam
// instead of a vertical one. Same shape, same hook, independent key; `def` is
// the pre-measure fallback and null still means "an equal half". No presets:
// ResizeSeam's preset fold menu unfolds sideways off a vertical divider and is
// skipped entirely on an empty list.
export const CALENDAR_HEIGHT_CONFIG = {
  key: 'planner:calHeight:v1',
  def: 420, min: 220, max: 900,
  presets: [],
};

// One-time cleanup of the retired layout-era keys (Pivot 2). Idempotent.
try {
  ['planner.layout', 'planner:calWidth:split:v4', 'planner:calWidth:3col:v4', 'planner:noteWidth:v3']
    .forEach(k => localStorage.removeItem(k));
} catch { /* storage unavailable — nothing to clean */ }

// Returns the user's stored px override for the seam, or null when they've
// never dragged it. null = "responsive" — PlannerModal renders the column
// flex:1 (an equal share of the modal). Any finite value above a sane floor is
// honored regardless of the comfort max (the modal scales, so large pins are
// valid); garbage / absent keys fall back to responsive.
function readWidth(cfg) {
  try {
    const v = parseInt(localStorage.getItem(cfg.key), 10);
    if (Number.isFinite(v) && v >= 120) return v;
  } catch {}
  return null;
}

// `config` defaults to the calendar so the existing `usePlannerSplit()` call
// site is unchanged; the health column passes HEALTH_CONFIG.
export function usePlannerSplit(config = CALENDAR_CONFIG) {
  const [width, setWidth] = useState(() => readWidth(config));

  // Cross-window sync: another window committed a new width.
  useEffect(() => {
    const onStorage = (e) => { if (e.key === config.key) setWidth(readWidth(config)); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [config]);

  return { width, setWidth, config };
}

// Standalone route bodies for the Planner tree's leaves (Planner
// Consolidation). Each is a thin full-width wrapper around a component the
// Dashboard already renders as a column — no new UI. They become fuller pages
// later; this is the minimum that makes each tree button land somewhere real.

import { useState } from 'react';
import { usePlannerUndo } from '@host/hooks/usePlannerUndo.js';
import { todayLocalStr } from '@host/util/time.js';
import CalendarPane from '@host/components/planner/CalendarPane.jsx';
import HealthColumn from '@host/components/health/HealthColumn.jsx';

const fill = {
  flex: 1, minWidth: 0, minHeight: 0,
  display: 'flex', flexDirection: 'column',
  background: 'var(--surface)',
};

// /planner/calendar — the SAME pane the Dashboard's left column uses (day/3-day
// toggle, Block Library, Copy Frame, Frame Edit), just full width. It replaces
// the deleted CalendarSection, which wrapped the bare CalendarPanel and had
// none of that header. Its pivot and undo stack are its own; the Dashboard's
// are local to that page.
export function CalendarPage({ accent }) {
  const { push: pushUndo } = usePlannerUndo();
  const [pivotDs, setPivotDs] = useState(() => todayLocalStr());
  return (
    <div className="planner-uniform-btns" data-uniform-height="--planner-btn-h" style={fill}>
      <CalendarPane
        accent={accent}
        pushUndo={pushUndo}
        pivotDs={pivotDs}
        onPivotChange={setPivotDs}
      />
    </div>
  );
}

// /planner/nutrition and /planner/fitness — HealthColumn narrowed to one
// section. ponytail: pivot is fixed to the day the page mounted; there's no
// date nav here yet, and HealthColumn's own 60s tick still flips isToday
// correctly if the day rolls over while the page is open.
function HealthLeaf({ accent, only }) {
  const [pivotDs] = useState(() => todayLocalStr());
  return (
    <div style={fill}>
      <HealthColumn accent={accent} pivotDs={pivotDs} only={only}/>
    </div>
  );
}

export function NutritionPage({ accent }) { return <HealthLeaf accent={accent} only="nutrition"/>; }
export function FitnessPage({ accent })   { return <HealthLeaf accent={accent} only="fitness"/>; }

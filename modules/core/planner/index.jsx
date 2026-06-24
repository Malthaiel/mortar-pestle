import { PlannerProvider } from './PlannerProvider.jsx';
import PlannerDock from './PlannerDock.jsx';
import { TaskDragOverlay } from './TaskDragOverlay.jsx';
import SettingsTab from './SettingsTab.jsx';
import CalendarSection from './CalendarSection.jsx';
import { bindPlannerApi } from './api.js';
import { PLANNER_RAIL_VARIANTS, PlannerMiniRail } from './rails/index.jsx';

// Candy-tile shell around the dock. The shell always fills the sidebar slot
// (flex-grow:1); the wrapper's align-items:flex-start lets the candy TILE hug
// its content vertically, so the tile shrinks to (dial + CALENDAR header) when
// the calendar collapses and grows to fill when it expands. The open/close
// motion itself is driven by the calendar body's measured max-height inside
// PlannerDock — see .button-planner-calendar-body. The .planner-dock-fill
// wrapper is the stable full-height reference that measurement reads.
function PlannerDockShell() {
  return (
    <div
      className="planner-dock-shell"
      style={{
        // 6px top/bottom, 10px left/right transparent border (horizontal bumped
        // +4px), matching the music shell. NO extra bottom padding — the tile
        // already reserves its candy slab via margin-bottom (18·tile-px); the old
        // `+ var(--candy-depth)` here was redundant dead gap between this module
        // and the next, which is why trimming only the base padding never visibly
        // shrank the inter-tile space. Removed.
        padding: '6px 10px',
        // Transparent on purpose: the shell fills the whole slot (so the tile
        // can hug + shrink within it), but it must NOT paint over the sidebar's
        // abstract background — the empty area below a collapsed tile shows it.
        background: 'transparent',
        flexGrow: 1, flexShrink: 1, flexBasis: 'auto',
        minHeight: 0, display: 'flex',
      }}
    >
      <div className="planner-dock-fill" style={{
        containerType: 'inline-size', width: '100%', display: 'flex',
        alignItems: 'flex-start',
        flex: '1 1 auto', minHeight: 0,
      }}>
        <div className="candy-btn music-tile is-planner" data-shape="tile">
          <div className="candy-face"><PlannerDock/></div>
        </div>
      </div>
    </div>
  );
}

export default {
  register(api) {
    bindPlannerApi(api);
    api.slots.registerProvider(PlannerProvider);
    api.slots.registerWidget({
      id: 'planner',
      // Wrapped in the music player's two-layer candy tile chrome (.music-tile,
      // data-shape="tile" + .is-planner) so the dock reads as the same button.
      // The face wraps the dock; the tile hugs its content when the
      // calendar is collapsed and fills the slot when expanded — see
      // PlannerDockShell above.
      render: () => <PlannerDockShell/>,
      weight: 10,
      // flexWeight 0 (hug): the slot tracks the tile's height so collapsing the
      // calendar pulls the next module right up under it (no reserved gap). The
      // expanded calendar still fills the sidebar's remaining space via a measured
      // max-height in PlannerDock (the sidebar-remaining formula).
      flexWeight: 0,
      renderRail: ({ accent }) => <PlannerMiniRail accent={accent}/>,
      railVariants: PLANNER_RAIL_VARIANTS,
    });
    // The three pane widgets (planner-events / planner-unorganized /
    // planner-blocks) registered here between the timer dock and the music
    // player retired at Pivot 2 — their content merged into the PlannerModal's
    // unified DayPane + the Block Library popover. Stale persisted ids in
    // widgets:order are dropped harmlessly by applyOrder.
    api.slots.registerSettingsTab({
      id: 'planner',
      label: 'Planner',
      render: SettingsTab,
    });
    api.slots.registerOverlay(TaskDragOverlay);
    api.slots.registerRoute({
      match: r => (r === '/pulse/calendar' ? {} : false),
      render: () => <CalendarSection/>,
    });
  },
};

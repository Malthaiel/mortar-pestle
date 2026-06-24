import { createContext, useContext } from 'react';

// PlannerContext is owned by the host so any code path can call usePlanner()
// safely. The Planner module imports this Context and wraps the app tree
// with PlannerContext.Provider via its registered provider slot. When the
// module is uninstalled, no provider mounts and consumers get NO_OP.
export const PlannerContext = createContext(null);

// Shape returned when no Planner module is loaded. Hosts only what host
// pages actually read (PageView's daily-log sidebar). Planner-internal
// components (PlannerDock, CalendarSection, TaskDragOverlay) run inside the
// real provider and never hit this fallback.
const NO_OP = Object.freeze({
  taskDrag: null,
  accent: 'var(--text-muted)',
  vaultTasks: [],
  routineItems: [],
  activeVaultRaw: null,
  selectVaultTask: () => {},
  toggleVaultTask: () => {},
  startTaskDrag: () => {},
  startPaneDrag: () => {},
  toggleRoutineTask: () => {},
});

export function usePlanner() {
  return useContext(PlannerContext) ?? NO_OP;
}

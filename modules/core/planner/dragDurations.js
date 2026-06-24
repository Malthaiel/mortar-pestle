// Single source of truth for the default duration (in minutes) a pane-drag
// creates when dropped on the calendar. Read by BOTH the drag ghost
// (TaskDragOverlay) and the drop handlers (handleTaskDrop / handleNoteDrop), so
// the duration previewed while dragging and the session actually created on drop
// can never drift apart. `block` drags carry their own default_duration, so they
// have no entry here (the ghost omits the duration line for them).
export const DRAG_DURATIONS = { task: 25, note: 30 };

export const dragDurationFor = (kind) => DRAG_DURATIONS[kind] ?? 25;

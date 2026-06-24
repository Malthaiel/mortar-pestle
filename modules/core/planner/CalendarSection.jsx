import { useMemo, useState } from 'react';
import CalendarPanel, { getVisibleDays } from './CalendarPanel.jsx';
import { usePlanner } from './PlannerProvider.jsx';
import { useFrameEditing } from '@host/hooks/useFrameEditing.js';
import { dateToKey } from '@host/util/time.js';

export default function CalendarSection() {
  const {
    accent, settings,
    sessions, planBlocks,
    pivotDate, viewMode, customDays,
    setPivotDate, setViewMode, setCustomDays,
    activePlanKey, activeSessionId, activeTaskName,
    selectPlanBlock, selectSession,
    taskDrag,
    handleSessionCreate, handleSessionResize, handleSessionMove, handleSessionDelete, handleSessionRename,
    handleTaskDrop,
  } = usePlanner();

  const [frameEditMode, setFrameEditMode] = useState(false);
  const dateKeys = useMemo(
    () => getVisibleDays(viewMode, pivotDate, customDays).map(dateToKey),
    [viewMode, pivotDate, customDays],
  );
  const { mergeIntoSessions, handlers: frameHandlers } = useFrameEditing(dateKeys);
  const sessionsWithFrame = useMemo(() => mergeIntoSessions(sessions), [mergeIntoSessions, sessions]);

  return (
    <div style={{
      flex: 1, minWidth: 0, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      background: 'var(--surface)',
    }}>
      <CalendarPanel
        sessions={sessionsWithFrame}
        pivotDate={pivotDate}
        onPivotChange={setPivotDate}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        customDays={customDays}
        onCustomDaysChange={setCustomDays}
        accent={accent}
        hourHeight={settings.calendarHourHeight}
        timeFormat24h={settings.timeFormat24h}
        planBlocks={planBlocks}
        activePlanKey={activePlanKey}
        activeSessionId={activeSessionId}
        onSelectPlanBlock={selectPlanBlock}
        onSelectSession={selectSession}
        activeTaskName={activeTaskName}
        onSessionCreate={handleSessionCreate}
        onSessionResize={handleSessionResize}
        onSessionMove={handleSessionMove}
        onSessionDelete={handleSessionDelete}
        onSessionRename={handleSessionRename}
        taskDrag={taskDrag}
        onTaskDrop={handleTaskDrop}
        {...frameHandlers}
        frameEditMode={frameEditMode}
        onFrameEditExit={() => setFrameEditMode(false)}
        onToggleFrameEdit={() => setFrameEditMode(v => !v)}
      />
    </div>
  );
}

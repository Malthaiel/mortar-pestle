import { usePlanner } from './PlannerProvider.jsx';
import { dragDurationFor } from './dragDurations.js';

// Fixed-position overlay that follows the cursor while dragging a task / quick
// note / library block onto the dock or calendar. Styled as a preview of the
// session block it will become (accent fill + left bar + default duration) so
// dragging reads as placing a real block, not a generic chip. Extracted from
// web/src/components/AppShell.jsx during the W3-4 module migration.
export function TaskDragOverlay() {
  const { taskDrag, accent } = usePlanner();
  if (!taskDrag) return null;
  // task/note carry a fixed default duration; library blocks vary → omit it.
  const mins = taskDrag.kind === 'block' ? null : dragDurationFor(taskDrag.kind);
  return (
    <div style={{
      position: 'fixed', left: taskDrag.x + 14, top: taskDrag.y + 8,
      zIndex: 2000, pointerEvents: 'none',
      borderRadius: 'var(--radius-md)', overflow: 'hidden',
      background: `color-mix(in oklch, ${accent} 92%, var(--surface-3))`,
      border: `1px solid color-mix(in oklch, ${accent} 70%, black)`,
      boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
      padding: '5px 9px 5px 11px', minWidth: 96, maxWidth: 220,
      display: 'flex', flexDirection: 'column', gap: 1,
    }}>
      <span aria-hidden style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        background: `color-mix(in oklch, ${accent} 100%, black 20%)`,
      }}/>
      <span style={{
        fontSize: 12, fontWeight: 600, color: 'var(--on-accent)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{taskDrag.label ?? taskDrag.taskName}</span>
      {mins != null && (
        <span style={{
          fontSize: 9, fontWeight: 600, fontFamily: 'var(--font-mono)',
          color: 'color-mix(in oklch, var(--on-accent) 78%, transparent)',
          letterSpacing: '0.02em',
        }}>{mins} min</span>
      )}
    </div>
  );
}

// Rail — THE default for a reorderable stack of self-contained panels.
//
// Three surfaces are a rail, and before 2026-08-29 each had grown its own copy
// of the same nine-line reorder body: the right sidebar (AppShell), the in-game
// Overlay Studio panel, and the Planner day pane. The splice math, the
// optimistic local order, and the persist-then-broadcast were identical in all
// of them; only WHERE the order is saved ever differed, because the overlay host
// is a bare webview that cannot reach the server-backed order store.
//
// Split in two on purpose:
//   useRailOrder(items, key, opts) -> { ordered, onReorder }   the STATE
//   <Rail items onReorder .../>                                the STACK
// Rail is always CONTROLLED. Two of the three callers need `ordered` for
// something else as well (AppShell feeds the collapsed RightRailStack from it;
// OverlayStudioPanel reads it back for its own ids), so a self-managing Rail
// would have needed a second escape-hatch prop for them and a mode flag to pick
// between the two. One shape, used the same way everywhere, is smaller.
//
// A rail ITEM is not this component's business. Each surface wraps its own
// entries — see `.rail-tile` in styles.css for the shared tile chrome and its
// three flavours (.is-music / .is-planner / .is-panel).

import { useCallback, useState } from 'react';
import DraggableSidebarList from '../DraggableSidebarList.jsx';
import { useSidebarOrder, applyOrder, emitSidebarOrderChange } from '../../hooks/useSidebarOrder.js';
import { api } from '../../api.js';

// Move `from` to `to` under DraggableSidebarList's drop-index convention: `to`
// is a SLOT between items, so dropping just after yourself (to === from + 1) is
// a no-op, and any downward move loses one index when the source is spliced out.
function reindex(ids, from, to) {
  if (to === from || to === from + 1) return null;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(from < to ? to - 1 : to, 0, moved);
  return { next, moved };
}

function readLocal(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}

// Order state + persistence for one rail.
//
// `local: true` saves to browser storage — for a surface with no route to the
// server-backed store (the overlay host). Otherwise the order goes through
// api.setSidebarOrder and is broadcast, so a second component watching the same
// key (SettingsDrawer, the collapsed rail) re-reads it.
//
// Both paths keep an OPTIMISTIC local order: the write is async, and without it
// the tiles snap back to the old order for the round trip.
export function useRailOrder(items, key, { idOf = (it) => it.id, local = false } = {}) {
  // Unconditional, per the rules of hooks. A null key makes it inert, which is
  // exactly what the local path wants — it reads browser storage instead.
  const { order: savedOrder } = useSidebarOrder(local ? null : key);
  const [localOrder, setLocalOrder] = useState(() => (local ? readLocal(key) : null));

  const ordered = applyOrder(items, localOrder ?? savedOrder, idOf);

  const onReorder = useCallback((from, to) => {
    const moved = reindex(ordered.map(idOf), from, to);
    if (!moved) return;
    setLocalOrder(moved.next);
    if (local) {
      try { localStorage.setItem(key, JSON.stringify(moved.next)); }
      catch { /* quota / private mode — the on-screen order still stands */ }
      return;
    }
    api.setSidebarOrder(key, moved.next)
      .then(() => {
        emitSidebarOrderChange(key);
        window.dispatchEvent(new CustomEvent('agentic:sidebar-row-persisted', {
          detail: { key, id: moved.moved },
        }));
      })
      .catch(() => { /* the optimistic order stays; the next fetch corrects it */ });
  }, [ordered, idOf, key, local]);

  return { ordered, onReorder };
}

// The stack. A thin, deliberate pass-through to DraggableSidebarList: the drag
// itself (hold-to-lift, the clone, the drop glide, the accent bridge) is that
// component's contract and must not be re-specified here.
//
// No gapSize: DraggableSidebarList MEASURES the container's real flex gap off
// getComputedStyle at lift (DraggableSidebarList.jsx:628) and feeds it to the
// glide math. Restating the gap here would be a constant that drifts the first
// time a scope changes it — and the Planner scope does exactly that, handing
// its rail 12px via --planner-btn-gap without this file ever knowing.
export default function Rail({
  items,
  renderItem,
  onReorder,
  keyOf = (it) => it.id,
  getItemStyle,
  // Opt-in: past a container edge the card expands to keep the dragged tile
  // inside, with exponential resistance. Only the floating Overlay Studio panel
  // wants it — a rail pinned to a window edge has nowhere to grow.
  growToContain = false,
  className,
  style,
}) {
  return (
    <DraggableSidebarList
      className={className}
      style={style}
      items={items}
      keyExtractor={keyOf}
      getItemStyle={getItemStyle}
      renderItem={renderItem}
      onReorder={onReorder}
      growToContain={growToContain}
    />
  );
}

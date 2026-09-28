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
//
// `show` is for a filtered view of one order: pass the FULL list and a
// predicate, get back only the shown items, and a drop among them keeps every
// hidden item in its slot. Pre-filtering `items` instead saves only the visible
// ids, so whatever a search or filter hid fell to the end (found 2026-09-28).
export function useRailOrder(items, key, { idOf = (it) => it.id, local = false, show } = {}) {
  // Unconditional, per the rules of hooks. A null key makes it inert, which is
  // exactly what the local path wants — it reads browser storage instead.
  const { order: savedOrder } = useSidebarOrder(local ? null : key);
  const [localOrder, setLocalOrder] = useState(() => (local ? readLocal(key) : null));

  const all = applyOrder(items, localOrder ?? savedOrder, idOf);
  const ordered = show ? all.filter(show) : all;

  const onReorder = useCallback((from, to) => {
    if (to === from || to === from + 1) return;
    // Shown slots onto the full list: land just before the shown item at `to`,
    // or just after the last shown one. Without `show` the two are the same.
    const ids = all.map(idOf);
    const vis = ordered.map(idOf);
    const at = (i) => ids.indexOf(vis[i]);
    const moved = reindex(ids, at(from), to < vis.length ? at(to) : at(vis.length - 1) + 1);
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
  }, [all, ordered, idOf, key, local]);

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
  // 'vertical' (the stack) or 'horizontal' (the strip). Straight through to
  // DraggableSidebarList, which has carried both axes since the dock shipped.
  direction = 'vertical',
  // Let the pickup start on a button/link inside the tile. Off by default so a
  // panel's own controls keep their clicks; ON for a run of chips, where the
  // whole item IS a button and there is nothing else to grab (the dock's case).
  dragFromInteractive = false,
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
      direction={direction}
      dragFromInteractive={dragFromInteractive}
    />
  );
}

// Cluster — THE default for a reorderable RUN of chips: a wrapping run you can
// drag in any direction, up/down between lines and left/right within one. Rail
// gives a stack one axis; Cluster gives a wrapped run both, off the SAME drag
// (hold to lift, the floating copy, the landing glide, the accent hand-off) and
// the SAME state hook (useRailOrder). The order is still one flat list — the
// wrap only decides which line each chip lands on.
//
// A run that fits on one line simply IS one line, so this covers a single-row
// strip too; there is no separate horizontal component to choose between.
//
// The host owns the box: a flex container with a real gap (never restate it as
// a prop — DraggableSidebarList measures it off getComputedStyle at lift) and
// items of a fixed size, so the lines read as columns rather than a ragged edge.
//
// A chip IS a button, so pickup has to come off the button itself — hence
// dragFromInteractive by default. That also sets the gesture: press and HOLD
// (180ms) lifts the chip, a quick tap still fires its onClick, exactly as the
// dock disambiguates nav from reorder.
//
// Consumers: NutritionSection (the Health column's micros, key `health:micros`).
export function Cluster(props) {
  return <Rail dragFromInteractive {...props} direction="grid" />;
}

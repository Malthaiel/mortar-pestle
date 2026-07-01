// Pure slot geometry for DraggableSidebarList — extracted so the math is
// node-runnable without the React module (web/scripts/check-drag-math.mjs
// asserts it against a reference flex layout for every (source, drop, gap)
// combination; run `npm run check-drag`).

// Compute the coordinate (active axis) where the dragged clone should sit,
// given current dropIdx and the layout captured at lift time. `positions[i]` =
// original top of items[i]; `heights[i]` = its height. The gap-stays-at-source
// lift cancels source's collapse exactly via marginTop on the next item, so
// positions[i] for i != sourceIdx continues to match the rendered top during
// steady state — the slot math works off cached coordinates without re-reading.
// `gap` = the container's flex gap on the active axis. Removing the source from
// ABOVE a target position removes its height PLUS one gap, and re-appending
// after the last item adds one gap — height-only math left every gap-spaced
// down-move one gap too low (the clone settled eating the gap to the tile
// below, then snapped up at the swap; invisible to the margin-spaced
// consumers, whose flexGap is 0).
export function computeSlotY(dropIdx, sourceIdx, positions, heights, gap = 0) {
  const N = positions.length;
  if (N === 0) return 0;
  if (dropIdx >= N) {
    // Drop after compact-last.
    if (sourceIdx === N - 1) {
      // No-op drop of the last item past itself: it stays at its own top,
      // which sits one gap below the previous item's bottom.
      if (N < 2) return positions[0] ?? 0;
      return positions[N - 2] + heights[N - 2] + gap;
    }
    return positions[N - 1] + heights[N - 1] - heights[sourceIdx];
  }
  if (dropIdx <= sourceIdx) return positions[dropIdx];
  // Down-move: everything in (sourceIdx, dropIdx) shifts up by the source's
  // occupied space = height + one gap; the moved tile takes the old top of
  // the tile at dropIdx minus exactly that. Also makes the dropIdx ===
  // sourceIdx + 1 no-op exact (returns positions[sourceIdx]).
  return positions[dropIdx] - heights[sourceIdx] - gap;
}

// Exhaustive check of computeSlotY (dragMath.js) against a reference flex
// layout — the invariant that burned us: the clone must glide to EXACTLY the
// top the moved tile will occupy after the reorder commits, including the
// container's flex gap (height-only math landed gap-spaced down-moves one gap
// low). Covers every (N, sourceIdx, dropIdx, gap) combination, both the moved
// and no-op branches. Run: `npm run check-drag` (node, no deps, no DOM).
import assert from 'node:assert/strict';
import { computeSlotY } from '../src/components/dragMath.js';

// Same insert semantics as DraggableSidebarList's calcDropIndex/onReorder:
// dropIdx = original-array index to insert BEFORE, skipping the source
// (dropIdx === N means "after the last item"; dropIdx === sourceIdx or
// sourceIdx + 1 is a no-op).
function reorder(N, from, to) {
  const next = [...Array(N).keys()];
  const adjusted = from < to ? to - 1 : to;
  next.splice(from, 1);
  next.splice(adjusted, 0, from);
  return next;
}

// Reference layout: stack tops from heights + one flex gap between items.
function layoutTops(order, heights, gap) {
  const tops = new Map();
  let y = 0;
  for (const k of order) { tops.set(k, y); y += heights[k] + gap; }
  return tops;
}

let cases = 0;
for (const heights of [[40], [40, 50], [40, 50, 60], [40, 50, 60, 34]]) {
  const N = heights.length;
  for (const gap of [0, 12]) {
    const initial = layoutTops([...Array(N).keys()], heights, gap);
    const positions = [...Array(N).keys()].map((i) => initial.get(i));
    for (let from = 0; from < N; from++) {
      for (let to = 0; to <= N; to++) {
        const expected = layoutTops(reorder(N, from, to), heights, gap).get(from);
        const got = computeSlotY(to, from, positions, heights, gap);
        assert.equal(
          got, expected,
          `N=${N} gap=${gap} from=${from} to=${to}: computeSlotY=${got}, layout=${expected}`
        );
        cases++;
      }
    }
  }
}
assert.equal(computeSlotY(0, 0, [], [], 12), 0, 'empty list returns 0');
console.log(`check-drag-math: ${cases + 1} cases PASS`);

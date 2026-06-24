// Pure helpers for the unified dock order — the "separator" and "spacer" items
// the user inserts via the dock right-click menu, the preset transforms
// (3-zone / group-by-type), and the edge-snap strength map. Special items live
// inline in `dock.order` as string ids `sep:<n>` / `spacer:<n>` (the order is a
// string[] everywhere, so strings round-trip with no consumer rewrites). Kept
// next to dock-buttons.js — dock-local, no React deps.

// A separator is a fixed medium hairline; a spacer is a flex:1 stretchy zone
// divider that pushes its neighbours toward the dock edges (the magnet clusters).
export const isSepId    = (id) => typeof id === 'string' && id.startsWith('sep:');
export const isSpacerId = (id) => typeof id === 'string' && id.startsWith('spacer:');
export const isSpecial  = (id) => isSepId(id) || isSpacerId(id);

// Edge-snap trigger distance (px from a dock edge / centre) per strength bucket.
export const SNAP_STRENGTH_PX = { subtle: 28, medium: 48, strong: 80 };
export const snapStrengthPx = (bucket) => SNAP_STRENGTH_PX[bucket] ?? SNAP_STRENGTH_PX.medium;

// Group display order for the "Group by type" preset.
export const GROUP_ORDER = ['modules', 'tools', 'pages', 'dev'];

// Highest <n> already used by a special id in `order`, so a freshly minted id
// never collides with one restored from a saved order.
function maxSpecialSeq(order) {
  let max = 0;
  for (const id of order || []) {
    if (!isSpecial(id)) continue;
    const n = parseInt(id.slice(id.indexOf(':') + 1), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

// Mint a unique `sep:<n>` / `spacer:<n>` id. Seeded above any id already in
// `order` AND above the last one handed out this session (module counter — the
// house idiom, cf. ContextMenuRoot _menuSeq), so
// back-to-back calls (e.g. the two spacers of a 3-zone preset) never duplicate
// and we avoid Date.now()/Math.random().
let _seq = 0;
export function makeSpecialId(type, order) {
  _seq = Math.max(_seq, maxSpecialSeq(order)) + 1;
  return `${type}:${_seq}`;
}

// 3-zone preset: split the given ids into three near-equal clusters with a
// spacer between each pair. Existing spacers are dropped (re-derived); any
// separators stay inline within their cluster.
export function applyThreeZoneOrder(ids) {
  const flow = (ids || []).filter(id => !isSpacerId(id));
  const n = flow.length;
  const a = Math.ceil(n / 3);
  const b = Math.ceil((2 * n) / 3);
  const left = flow.slice(0, a);
  const mid = flow.slice(a, b);
  const right = flow.slice(b);
  const out = [...left];
  if (mid.length || right.length) out.push(makeSpecialId('spacer', out));
  out.push(...mid);
  if (right.length) out.push(makeSpecialId('spacer', out));
  out.push(...right);
  return out;
}

// Group-by-type preset: order entries by GROUP_ORDER with a separator between
// groups. `entries` = [{ id, group }] of the current visible buttons.
export function groupByTypeOrder(entries) {
  const out = [];
  for (const g of GROUP_ORDER) {
    const ids = (entries || []).filter(e => e.group === g).map(e => e.id);
    if (!ids.length) continue;
    if (out.length) out.push(makeSpecialId('sep', out));
    out.push(...ids);
  }
  return out;
}

// SP3 scene-graph order math — pure functions over snapshot scenes. Wire
// order everywhere here is the engine's: BOTTOM→TOP of the render stack,
// group children nested. "Move up" in the DISPLAYED (top-first) tree =
// toward the END of a wire array. reorder_items consumes the FULL flat
// order: [{item, group|null}] — a group entry immediately followed by its
// children carrying group=<id> (obs_scene_reorder_items2 convention; the
// same call is how membership changes commit).

/// Nested wire model → flat reorder_items order array.
export function flattenOrder(sources) {
  const out = [];
  for (const s of sources) {
    out.push({ item: s.item_id, group: null });
    if (s.is_group) {
      for (const c of s.children || []) out.push({ item: c.item_id, group: s.item_id });
    }
  }
  return out;
}

/// Current full order array for a snapshot scene.
export function wireOrder(scene) {
  return flattenOrder(scene.sources || []);
}

/// Clone the nested wire model shallowly (containers only).
function model(scene) {
  return (scene.sources || []).map((s) => ({
    item_id: s.item_id,
    is_group: s.is_group,
    children: s.is_group ? (s.children || []).map((c) => ({ item_id: c.item_id, is_group: false })) : [],
  }));
}

function findContainer(m, itemId) {
  const top = m.findIndex((s) => s.item_id === itemId);
  if (top !== -1) return { list: m, index: top, group: null };
  for (const s of m) {
    if (!s.is_group) continue;
    const i = s.children.findIndex((c) => c.item_id === itemId);
    if (i !== -1) return { list: s.children, index: i, group: s.item_id };
  }
  return null;
}

/// dir ∈ 'up' | 'down' | 'top' | 'bottom' in DISPLAY terms (top-first).
/// Returns the new full order array, or null if it's a no-op.
export function orderAfterMove(scene, itemId, dir) {
  const m = model(scene);
  const loc = findContainer(m, itemId);
  if (!loc) return null;
  const { list, index } = loc;
  // Display up = wire toward the end.
  let to;
  if (dir === 'up') to = index + 1;
  else if (dir === 'down') to = index - 1;
  else if (dir === 'top') to = list.length - 1;
  else to = 0;
  if (to < 0 || to >= list.length || to === index) return null;
  const [it] = list.splice(index, 1);
  list.splice(to, 0, it);
  return flattenOrder(m);
}

/// Move an item into a group (targetGroupId) or out to top level (null).
/// Lands at the TOP of the destination (end of its wire list). Groups
/// themselves can't enter groups (OBS disallows nesting).
export function orderAfterMembership(scene, itemId, targetGroupId) {
  const m = model(scene);
  const loc = findContainer(m, itemId);
  if (!loc) return null;
  const moving = loc.list[loc.index];
  if (moving.is_group && targetGroupId != null) return null; // no group-in-group
  if (loc.group === targetGroupId) return null;
  loc.list.splice(loc.index, 1);
  if (targetGroupId == null) {
    m.push(moving);
  } else {
    const g = m.find((s) => s.item_id === targetGroupId && s.is_group);
    if (!g) return null;
    g.children.push(moving);
  }
  return flattenOrder(m);
}

/// Every item of a scene, flattened (top-level + group children).
export function allItems(scene) {
  const out = [];
  for (const s of scene.sources || []) {
    out.push(s);
    if (s.is_group) for (const c of s.children || []) out.push(c);
  }
  return out;
}

/// Recreate-call for one item (delete-undo / scene-delete-undo): a
/// create_source carrying settings + transform + crop + flags, remap-tagged.
/// Group membership is restored by the caller's follow-up full-order reorder.
export function recreateCall(sceneName, node, settings) {
  return {
    op: 'create_source',
    args: {
      scene: sceneName,
      id: node.id,
      name: node.name,
      settings,
      transform: { ...node.transform },
      crop: { ...node.crop },
      visible: node.visible,
      locked: node.locked,
    },
    remap: node.item_id,
  };
}

/// How many scene items across the whole snapshot reference this source name
/// (shared add_existing refs) — decides delete-undo: recreate vs re-reference.
export function refCount(snapshot, sourceName) {
  let n = 0;
  for (const sc of snapshot?.scenes || []) {
    for (const it of allItems(sc)) if (it.name === sourceName) n++;
  }
  return n;
}

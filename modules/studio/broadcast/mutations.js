// SP3 shared mutations — delete-with-undo lives here because BOTH the tree
// (context → Remove) and the preview (Del key) drive it. Undo restores
// settings + transform + membership: shared/scene refs re-reference
// (add_existing), sole sources recreate (settings captured at delete time);
// a captured full-order reorder restores position + group membership (item
// id remap in broadcastUndo rewrites the captured ids on recreate).

import { getBroadcastUi, updateBroadcastUi, verb } from './broadcastStore.js';
import { pushUndo } from './broadcastUndo.js';
import { recreateCall, refCount, wireOrder } from './sceneOps.js';

export function toast(title, message) {
  window.dispatchEvent(new CustomEvent('agentic:notify', {
    detail: { type: 'note-info', title, message, dismissOnClick: true },
  }));
}

export async function removeItemWithUndo(api, snapshot, scene, node) {
  const sceneName = scene.name;
  const order = wireOrder(scene);
  const shared = refCount(snapshot, node.name) > 1;
  const isGroup = node.is_group;
  const kids = isGroup ? (node.children || []) : [];
  const undoCalls = [];
  if (isGroup) {
    undoCalls.push({ op: 'create_group', args: { scene: sceneName, name: node.name }, remap: node.item_id });
    for (const c of kids) {
      if (refCount(snapshot, c.name) > 1) {
        undoCalls.push({ op: 'add_existing', args: { scene: sceneName, source_name: c.name }, remap: c.item_id });
        undoCalls.push({ op: 'transform_commit', args: { scene: sceneName, item: c.item_id, transform: { ...c.transform }, crop: { ...c.crop } } });
      } else {
        const got = await verb(api, 'get_source_settings', { scene: sceneName, item: c.item_id }).catch(() => null);
        undoCalls.push(recreateCall(sceneName, c, got?.settings || {}));
      }
    }
  } else if (shared || node.is_scene) {
    undoCalls.push({ op: 'add_existing', args: { scene: sceneName, source_name: node.name }, remap: node.item_id });
    undoCalls.push({ op: 'transform_commit', args: { scene: sceneName, item: node.item_id, transform: { ...node.transform }, crop: { ...node.crop } } });
    undoCalls.push({ op: 'set_item_visible', args: { scene: sceneName, item: node.item_id, visible: node.visible } });
    undoCalls.push({ op: 'set_item_locked', args: { scene: sceneName, item: node.item_id, locked: node.locked } });
  } else {
    const got = await verb(api, 'get_source_settings', { scene: sceneName, item: node.item_id }).catch(() => null);
    undoCalls.push(recreateCall(sceneName, node, got?.settings || {}));
  }
  undoCalls.push({ op: 'reorder_items', args: { scene: sceneName, order } });
  return verb(api, 'remove_item', { scene: sceneName, item: node.item_id }).then(() => {
    if (getBroadcastUi().selection?.itemId === node.item_id) updateBroadcastUi({ selection: null });
    pushUndo({
      label: `Remove ${node.name}`,
      undo: undoCalls,
      redo: [{ op: 'remove_item', args: { scene: sceneName, item: node.item_id } }],
    });
    if (isGroup && kids.length > 0) toast('Group removed', `${node.name} + ${kids.length} source(s) · Ctrl+Z to undo`);
  }).catch((e) => console.warn('[broadcast] remove_item', e));
}

// SP3 add-source flow (locked: instant create + rename armed) — a
// useContextMenu type list fed by the engine's live registry
// (list_input_types), with Existing ▸ (shared refs) and Scene ▸ (nested
// scenes) sections. Picking a type creates immediately with the display-name
// auto-name (engine free_name suffixes), selects it, arms inline rename,
// opens the inspector, pushes undo.
//
// browser_source: CEF is late-loaded (load_browser_module) on first use. The
// engine's type list omits it until loaded, so a synthetic "Browser" entry is
// appended — a load failure toasts and aborts (the boot-load fallback is a
// V1_MODULES one-liner, applied only if the late-load spike fails).

import { glyphFor } from './sourceGlyphs.jsx';
import { updateBroadcastUi, verb } from './broadcastStore.js';
import { pushUndo } from './broadcastUndo.js';
import { allItems } from './sceneOps.js';

function toastError(title, message) {
  window.dispatchEvent(new CustomEvent('agentic:notify', {
    detail: { type: 'note-info', title, message, dismissOnClick: true },
  }));
}

async function createSource(api, sceneName, typeId, displayName, revealScene) {
  if (typeId === 'browser_source') {
    const r = await verb(api, 'load_browser_module').catch((e) => ({ loaded: false, error: String(e) }));
    if (!r?.loaded) {
      toastError('Browser source unavailable', r?.error || 'obs-browser failed to load');
      return;
    }
  }
  try {
    const r = await verb(api, 'create_source', { scene: sceneName, id: typeId, name: displayName });
    pushUndo({
      label: `Add ${r.name}`,
      undo: [{ op: 'remove_item', args: { scene: sceneName, item: r.item } }],
      redo: [{
        op: 'create_source',
        args: { scene: sceneName, id: typeId, name: r.name },
        remap: r.item,
      }],
    });
    revealScene?.();
    updateBroadcastUi({
      selection: { scene: sceneName, itemId: r.item },
      renameTarget: { scene: sceneName, itemId: r.item },
      inspectorOpen: true,
    });
    verb(api, 'select_item', { scene: sceneName, item: r.item }).catch(() => {});
  } catch (e) {
    console.warn('[broadcast] create_source', e);
    toastError('Add source failed', e?.message || String(e));
  }
}

function addExisting(api, sceneName, sourceName) {
  verb(api, 'add_existing', { scene: sceneName, source_name: sourceName })
    .then((r) => {
      pushUndo({
        label: `Add ${sourceName}`,
        undo: [{ op: 'remove_item', args: { scene: sceneName, item: r.item } }],
        redo: [{ op: 'add_existing', args: { scene: sceneName, source_name: sourceName }, remap: r.item }],
      });
      updateBroadcastUi({ selection: { scene: sceneName, itemId: r.item } });
      verb(api, 'select_item', { scene: sceneName, item: r.item }).catch(() => {});
    })
    .catch((e) => {
      console.warn('[broadcast] add_existing', e);
      toastError('Add failed', e?.message || String(e));
    });
}

/// Build + open the add-source menu. `anchor` = mouse event or {x,y};
/// `sceneName` = target scene; `revealScene` expands its folder.
export async function openAddSourceMenu(anchor, { api, snapshot, sceneName, accent, openContextMenu, revealScene }) {
  let types = [];
  try {
    const r = await verb(api, 'list_input_types');
    types = r?.types || [];
  } catch (e) {
    console.warn('[broadcast] list_input_types', e);
  }
  if (!types.some((t) => t.id === 'browser_source')) {
    types.push({ id: 'browser_source', display_name: 'Browser' });
  }

  const items = types.map((t) => ({
    label: t.display_name,
    icon: glyphFor(t.id, 14),
    onClick: () => createSource(api, sceneName, t.id, t.display_name, revealScene),
  }));

  // Existing ▸ — every uniquely-named source anywhere, minus this scene's own.
  const inScene = new Set(allItems((snapshot?.scenes || []).find((s) => s.name === sceneName) || { sources: [] }).map((i) => i.name));
  const existing = [];
  const seen = new Set();
  for (const sc of snapshot?.scenes || []) {
    for (const it of allItems(sc)) {
      if (it.is_group || it.is_scene || seen.has(it.name) || inScene.has(it.name)) continue;
      seen.add(it.name);
      existing.push({ label: it.name, icon: glyphFor(it.id, 14), onClick: () => addExisting(api, sceneName, it.name) });
    }
  }
  const otherScenes = (snapshot?.scenes || []).filter((s) => s.name !== sceneName)
    .map((s) => ({ label: s.name, icon: glyphFor('scene', 14), onClick: () => addExisting(api, sceneName, s.name) }));

  const tail = [];
  if (existing.length) tail.push({ label: 'Existing', children: existing });
  if (otherScenes.length) tail.push({ label: 'Scene', children: otherScenes });
  if (tail.length) items.push({ sep: true }, ...tail);

  openContextMenu(anchor, items, { accent, header: `Add to ${sceneName}` });
}

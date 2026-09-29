// SP3 secondary sidebar — the SHARED TreeSidebar shell (LibraryNav recipe:
// nodes + controller + buttons), fed the combined scene/source tree. Scenes =
// folder nodes with split-click (row = program switch + auto-expand, caret =
// silent browse — the CandyHeader onActivate extension); sources = leaf rows;
// groups = sub-folders; nested scenes = film-glyph leaves. THE one place wire
// order flips: snapshot arrays are engine enum order (bottom→top), display is
// top-first.
//
// SF2: context menus own every mutation (ordering via Order ▸ / Move to ▸ —
// the locked menu-ordering model; pointer drag is a deferred follow-up).
// Every mutation runs LIVE, then pushes an undo entry whose redo replays it.
// Deletes are instant + undoable (NO ConfirmModal — DESIGN anti-pattern);
// only group-with-children and scene-with-sources raise an undo toast.

import React, { useMemo } from 'react';
import TreeSidebar from '@host/components/vault-tree/TreeSidebar.jsx';
import { useTreeExpansion } from '@host/components/vault-tree/useTreeExpansion.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import useBroadcastState from './useBroadcastState.js';
import { RenamePill, RowToggles, ProgramDot } from './SourceTreeRow.jsx';
import { glyphFor } from './sourceGlyphs.jsx';
import { updateBroadcastUi, useBroadcastUi, verb } from './broadcastStore.js';
import { pushUndo, renameSceneEverywhere } from './broadcastUndo.js';
import { allItems, orderAfterMove, orderAfterMembership, recreateCall, refCount, wireOrder } from './sceneOps.js';
import { openAddSourceMenu } from './addSource.js';
import { removeItemWithUndo, toast } from './mutations.js';

const topFirst = (sources) => [...(sources || [])].reverse();

/// First free "<base>" / "<base> N" against the snapshot's scene names.
function freeSceneName(snapshot, base = 'Scene') {
  const taken = new Set((snapshot?.scenes || []).map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`;
    if (!taken.has(n)) return n;
  }
}

export default function BroadcastSidebar({ api, accent }) {
  const { snapshot, alive } = useBroadcastState(api);
  const ui = useBroadcastUi();
  const { openContextMenu } = useContextMenu();
  const scenes = snapshot?.scenes || [];
  const exp = useTreeExpansion('bcast:tree', scenes.slice(0, 1).map((s) => `s:${s.name}`));

  const call = (op, args) =>
    verb(api, op, args).catch((e) => console.warn(`[broadcast] ${op}`, e));

  const select = (scene, itemId) => {
    updateBroadcastUi({ selection: { scene, itemId } });
    call('select_item', { scene, item: itemId });
  };

  // ── mutations (live + undo entry) ──────────────────────────────────────

  const doRename = (sceneName, node, newName) => {
    updateBroadcastUi({ renameTarget: null });
    if (node == null) {
      call('rename_scene', { name: sceneName, new_name: newName }).then(() => {
        // Rewrite stacked name references BEFORE pushing the new entry (so
        // the walk can't corrupt the entry's own direction literals).
        renameSceneEverywhere(sceneName, newName);
        pushUndo({
          label: `Rename ${sceneName}`,
          undo: [{ op: 'rename_scene', args: { name: newName, new_name: sceneName } }],
          redo: [{ op: 'rename_scene', args: { name: sceneName, new_name: newName } }],
        });
      });
    } else {
      call('rename_item', { scene: sceneName, item: node.item_id, new_name: newName }).then(() =>
        pushUndo({
          label: `Rename ${node.name}`,
          undo: [{ op: 'rename_item', args: { scene: sceneName, item: node.item_id, new_name: node.name } }],
          redo: [{ op: 'rename_item', args: { scene: sceneName, item: node.item_id, new_name: newName } }],
        }));
    }
  };

  const doReorder = (scene, order, label) => {
    if (!order) return;
    const old = wireOrder(scene);
    call('reorder_items', { scene: scene.name, order }).then(() =>
      pushUndo({
        label,
        undo: [{ op: 'reorder_items', args: { scene: scene.name, order: old } }],
        redo: [{ op: 'reorder_items', args: { scene: scene.name, order } }],
      }));
  };

  const doRemoveItem = (scene, node) => removeItemWithUndo(api, snapshot, scene, node);

  const doToggleFlag = (scene, node, key, op, value) => {
    call(op, { scene: scene.name, item: node.item_id, [key]: value }).then(() =>
      pushUndo({
        label: `${node.name}: ${key}`,
        undo: [{ op, args: { scene: scene.name, item: node.item_id, [key]: !value } }],
        redo: [{ op, args: { scene: scene.name, item: node.item_id, [key]: value } }],
      }));
  };

  /// Alt-click eye = solo (locked delight c): hide every OTHER item in the
  /// scene, stash the visibility set; alt-click again restores. Stash dies on
  /// scene switch / F5 (documented); plain-undo restores visibilities but not
  /// the stash arm.
  const soloToggle = (scene, node) => {
    const stash = ui.soloStash.get(scene.name);
    const next = new Map(ui.soloStash);
    if (stash) {
      const calls = stash.entries
        .filter(([id]) => id !== node.item_id)
        .map(([id, vis]) => ({ op: 'set_item_visible', args: { scene: scene.name, item: id, visible: vis } }));
      Promise.all(calls.map((c) => verb(api, c.op, c.args).catch(() => {}))).then(() => {
        pushUndo({ label: `Unsolo ${node.name}`, undo: stash.soloCalls, redo: calls });
      });
      next.delete(scene.name);
      updateBroadcastUi({ soloStash: next });
      return;
    }
    const others = allItems(scene).filter((i) => i.item_id !== node.item_id && !i.is_group);
    const entries = others.map((i) => [i.item_id, i.visible]);
    const soloCalls = others.filter((i) => i.visible)
      .map((i) => ({ op: 'set_item_visible', args: { scene: scene.name, item: i.item_id, visible: false } }));
    const restoreCalls = others.filter((i) => i.visible)
      .map((i) => ({ op: 'set_item_visible', args: { scene: scene.name, item: i.item_id, visible: true } }));
    Promise.all(soloCalls.map((c) => verb(api, c.op, c.args).catch(() => {}))).then(() => {
      pushUndo({ label: `Solo ${node.name}`, undo: restoreCalls, redo: soloCalls });
    });
    next.set(scene.name, { targetId: node.item_id, entries, soloCalls });
    updateBroadcastUi({ soloStash: next });
  };

  const doRemoveScene = async (scene) => {
    const sceneName = scene.name;
    const items = allItems(scene);
    const order = wireOrder(scene);
    const wasProgram = snapshot.current_scene === sceneName;
    const undoCalls = [{ op: 'create_scene', args: { name: sceneName } }];
    for (const s of scene.sources || []) {
      if (s.is_group) undoCalls.push({ op: 'create_group', args: { scene: sceneName, name: s.name }, remap: s.item_id });
    }
    for (const it of items) {
      if (it.is_group) continue;
      if (refCount(snapshot, it.name) > 1 || it.is_scene) {
        undoCalls.push({ op: 'add_existing', args: { scene: sceneName, source_name: it.name }, remap: it.item_id });
        undoCalls.push({ op: 'transform_commit', args: { scene: sceneName, item: it.item_id, transform: { ...it.transform }, crop: { ...it.crop } } });
      } else {
        const got = await verb(api, 'get_source_settings', { scene: sceneName, item: it.item_id }).catch(() => null);
        undoCalls.push(recreateCall(sceneName, it, got?.settings || {}));
      }
    }
    undoCalls.push({ op: 'reorder_items', args: { scene: sceneName, order } });
    if (wasProgram) undoCalls.push({ op: 'set_current_scene', args: { name: sceneName } });
    call('remove_scene', { name: sceneName }).then(() => {
      pushUndo({
        label: `Remove scene ${sceneName}`,
        undo: undoCalls,
        redo: [{ op: 'remove_scene', args: { name: sceneName } }],
      });
      if (items.length > 0) toast('Scene removed', `${sceneName} + ${items.length} item(s) · Ctrl+Z to undo`);
    });
  };

  const doDuplicateScene = (sceneName) => {
    verb(api, 'duplicate_scene', { name: sceneName })
      .then((r) => {
        const newName = r?.name;
        if (!newName) return;
        pushUndo({
          label: `Duplicate ${sceneName}`,
          undo: [{ op: 'remove_scene', args: { name: newName } }],
          // After undo frees the name, free_name re-mints the same one.
          redo: [{ op: 'duplicate_scene', args: { name: sceneName } }],
        });
      })
      .catch((e) => console.warn('[broadcast] duplicate_scene', e));
  };

  const doMoveScene = (sceneName, dir) => {
    const names = scenes.map((s) => s.name);
    const i = names.indexOf(sceneName);
    const to = dir === 'up' ? i - 1 : i + 1;
    if (i === -1 || to < 0 || to >= names.length) return;
    const next = [...names];
    [next[i], next[to]] = [next[to], next[i]];
    call('reorder_scenes', { order: next }).then(() =>
      pushUndo({
        label: `Move scene ${sceneName}`,
        undo: [{ op: 'reorder_scenes', args: { order: names } }],
        redo: [{ op: 'reorder_scenes', args: { order: next } }],
      }));
  };

  const doAddGroup = (scene) => {
    verb(api, 'create_group', { scene: scene.name, name: 'Group' })
      .then((r) => {
        pushUndo({
          label: 'Add Group',
          undo: [{ op: 'remove_item', args: { scene: scene.name, item: r.item } }],
          redo: [{ op: 'create_group', args: { scene: scene.name, name: r.name }, remap: r.item }],
        });
        exp.reveal([`s:${scene.name}`]);
        updateBroadcastUi({ renameTarget: { scene: scene.name, itemId: r.item } });
      })
      .catch((e) => console.warn('[broadcast] create_group', e));
  };

  const doUngroup = (scene, node) => {
    const order = wireOrder(scene);
    call('ungroup', { scene: scene.name, item: node.item_id }).then(() =>
      pushUndo({
        label: `Ungroup ${node.name}`,
        undo: [
          { op: 'create_group', args: { scene: scene.name, name: node.name }, remap: node.item_id },
          { op: 'reorder_items', args: { scene: scene.name, order } },
        ],
        redo: [{ op: 'ungroup', args: { scene: scene.name, item: node.item_id } }],
      }));
  };

  // ── context menus ──────────────────────────────────────────────────────

  const addSourceAt = (anchor, sceneName) =>
    openAddSourceMenu(anchor, {
      api, snapshot, sceneName, accent, openContextMenu,
      revealScene: () => exp.reveal([`s:${sceneName}`]),
    });

  const sceneMenu = (e, scene) => {
    e.preventDefault();
    const i = scenes.findIndex((s) => s.name === scene.name);
    const at = { x: e.clientX, y: e.clientY };
    openContextMenu(e, [
      { label: 'Set Program', onClick: () => call('set_current_scene', { name: scene.name }) },
      { label: 'Rename', onClick: () => updateBroadcastUi({ renameTarget: { scene: scene.name, itemId: null } }) },
      { label: 'Duplicate', onClick: () => doDuplicateScene(scene.name) },
      { sep: true },
      { label: 'Add Source', onClick: () => addSourceAt(at, scene.name) },
      { label: 'Add Group', onClick: () => doAddGroup(scene) },
      { sep: true },
      { label: 'Move Up', disabled: i <= 0, onClick: () => doMoveScene(scene.name, 'up') },
      { label: 'Move Down', disabled: i >= scenes.length - 1, onClick: () => doMoveScene(scene.name, 'down') },
      { sep: true },
      { label: 'Remove', danger: true, onClick: () => doRemoveScene(scene) },
    ], { accent, header: scene.name });
  };

  const itemMenu = (e, scene, node, parentGroupId) => {
    e.preventDefault();
    e.stopPropagation();
    const groups = (scene.sources || []).filter((s) => s.is_group && s.item_id !== node.item_id);
    const otherScenes = scenes.filter((s) => s.name !== scene.name);
    const moveTo = [];
    if (!node.is_group) {
      for (const g of groups) {
        if (parentGroupId === g.item_id) continue;
        moveTo.push({ label: g.name, onClick: () => doReorder(scene, orderAfterMembership(scene, node.item_id, g.item_id), `Move ${node.name} into ${g.name}`) });
      }
    }
    if (parentGroupId != null) {
      moveTo.push({ label: '(Top Level)', onClick: () => doReorder(scene, orderAfterMembership(scene, node.item_id, null), `Move ${node.name} out`) });
    }
    openContextMenu(e, [
      { label: 'Rename', onClick: () => updateBroadcastUi({ renameTarget: { scene: scene.name, itemId: node.item_id } }) },
      { label: 'Properties', onClick: () => { select(scene.name, node.item_id); updateBroadcastUi({ inspectorOpen: true }); } },
      { sep: true },
      {
        label: 'Order',
        children: [
          { label: 'Move Up', onClick: () => doReorder(scene, orderAfterMove(scene, node.item_id, 'up'), `Move ${node.name} up`) },
          { label: 'Move Down', onClick: () => doReorder(scene, orderAfterMove(scene, node.item_id, 'down'), `Move ${node.name} down`) },
          { label: 'Move to Top', onClick: () => doReorder(scene, orderAfterMove(scene, node.item_id, 'top'), `Move ${node.name} to top`) },
          { label: 'Move to Bottom', onClick: () => doReorder(scene, orderAfterMove(scene, node.item_id, 'bottom'), `Move ${node.name} to bottom`) },
        ],
      },
      ...(moveTo.length ? [{ label: 'Move to', children: moveTo }] : []),
      ...(node.is_group ? [{ label: 'Ungroup', onClick: () => doUngroup(scene, node) }] : []),
      ...(otherScenes.length && !node.is_group ? [{
        label: 'Add to scene',
        children: otherScenes.map((t) => ({
          label: t.name,
          onClick: () => verb(api, 'add_existing', { scene: t.name, source_name: node.name })
            .then((r) => pushUndo({
              label: `Add ${node.name} to ${t.name}`,
              undo: [{ op: 'remove_item', args: { scene: t.name, item: r.item } }],
              redo: [{ op: 'add_existing', args: { scene: t.name, source_name: node.name }, remap: r.item }],
            }))
            .catch((err) => console.warn('[broadcast] add_existing', err)),
        })),
      }] : []),
      { sep: true },
      { label: 'Remove', danger: true, onClick: () => doRemoveItem(scene, node) },
    ], { accent, header: node.name });
  };

  // ── nodes ──────────────────────────────────────────────────────────────

  const nodes = useMemo(() => {
    const renamingIs = (scene, itemId) =>
      !!ui.renameTarget && ui.renameTarget.scene === scene && ui.renameTarget.itemId === itemId;

    const itemNode = (scene, s, parentGroupId) => {
      const sceneName = scene.name;
      const renaming = renamingIs(sceneName, s.item_id);
      const base = {
        id: `i:${sceneName}:${s.item_id}`,
        label: s.name,
        leadIcon: glyphFor(s.id),
        renaming,
        renderRename: () => (
          <RenamePill
            initial={s.name}
            onCommit={(v) => doRename(sceneName, s, v)}
            onCancel={() => updateBroadcastUi({ renameTarget: null })}
          />
        ),
        trailing: (
          <RowToggles
            node={s}
            onToggleVisible={(e) => {
              if (e.altKey && !s.is_group) soloToggle(scene, s);
              else doToggleFlag(scene, s, 'visible', 'set_item_visible', !s.visible);
            }}
            onToggleLock={() => doToggleFlag(scene, s, 'locked', 'set_item_locked', !s.locked)}
          />
        ),
        onContextMenu: (e) => itemMenu(e, scene, s, parentGroupId),
        onDoubleClick: () => updateBroadcastUi({ renameTarget: { scene: sceneName, itemId: s.item_id } }),
        // Delight (a): hovering a row flashes the item's outline in the
        // preview — engine-drawn, dimmer than selection.
        onMouseEnter: () => call('hover_item', { scene: sceneName, item: s.item_id }),
        onMouseLeave: () => call('hover_item', { item: null }),
      };
      if (s.is_group) {
        return {
          ...base,
          id: `g:${sceneName}:${s.item_id}`,
          isFolder: true,
          activeFill: !!(ui.selection && ui.selection.scene === sceneName && ui.selection.itemId === s.item_id),
          onActivate: () => select(sceneName, s.item_id),
          children: topFirst(s.children).map((c) => itemNode(scene, c, s.item_id)),
        };
      }
      return {
        ...base,
        isFolder: false,
        active: !!(ui.selection && ui.selection.scene === sceneName && ui.selection.itemId === s.item_id),
        onActivate: () => select(sceneName, s.item_id),
      };
    };

    return scenes.map((scene) => ({
      id: `s:${scene.name}`,
      label: scene.name,
      leadIcon: glyphFor('scene'),
      isFolder: true,
      activeFill: snapshot.current_scene === scene.name,
      trailing: snapshot.current_scene === scene.name ? <ProgramDot /> : null,
      renaming: renamingIs(scene.name, null),
      renderRename: () => (
        <RenamePill
          initial={scene.name}
          onCommit={(v) => doRename(scene.name, null, v)}
          onCancel={() => updateBroadcastUi({ renameTarget: null })}
        />
      ),
      onActivate: () => {
        call('set_current_scene', { name: scene.name });
        exp.reveal([`s:${scene.name}`]);
      },
      onContextMenu: (e) => sceneMenu(e, scene),
      onDoubleClick: () => updateBroadcastUi({ renameTarget: { scene: scene.name, itemId: null } }),
      children: topFirst(scene.sources).map((s) => itemNode(scene, s, null)),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes, snapshot?.current_scene, ui.renameTarget, ui.selection, accent]);

  const allFolderIds = useMemo(() => {
    const ids = [];
    for (const scene of scenes) {
      ids.push(`s:${scene.name}`);
      for (const s of scene.sources || []) {
        if (s.is_group) ids.push(`g:${scene.name}:${s.item_id}`);
      }
    }
    return ids;
  }, [scenes]);

  const controller = {
    isOpen: exp.isOpen,
    toggle: exp.toggle,
    anyExpanded: exp.anyExpanded,
    expandAll: () => exp.expandAll(allFolderIds),
    collapseAll: exp.collapseAll,
    canReveal: false,
  };

  const buttons = {
    new: {
      show: alive,
      title: 'New scene',
      onClick: () => {
        const name = freeSceneName(snapshot);
        verb(api, 'create_scene', { name })
          .then(() => {
            pushUndo({
              label: `Add scene ${name}`,
              undo: [{ op: 'remove_scene', args: { name } }],
              redo: [{ op: 'create_scene', args: { name } }],
            });
            updateBroadcastUi({ renameTarget: { scene: name, itemId: null } });
          })
          .catch((e) => console.warn('[broadcast] create_scene', e));
      },
    },
    // "New folder" slot repurposed: add a source to the PROGRAM scene (OBS
    // adds to the active scene; per-scene adds ride the scene context menu).
    newFolder: {
      show: alive && !!snapshot?.current_scene,
      title: 'Add source (program scene)',
      icon: glyphFor('', 14), // IconLayers fallback — "sources", not a folder
      onClick: (e) => addSourceAt(e, snapshot.current_scene),
    },
    sort: { show: false },
    collapse: { show: true },
    revealCurrent: { show: false },
    revealInFiles: { show: false },
  };

  if (!alive) {
    return (
      <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
        engine offline
      </div>
    );
  }
  return <TreeSidebar nodes={nodes} controller={controller} buttons={buttons} accent={accent} />;
}

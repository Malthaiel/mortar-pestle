// SP3 undo ring — module-level (NOT a per-component hook: the sidebar tree
// and the page keydown both drive it across slot roots). VE useUndoStack
// semantics: cap 200, a new entry clears the redo branch. Entries are verb
// bundles: { label, undo: [{op,args,remap?}], redo: [{op,args,remap?}] } —
// executing a side runs its calls sequentially over broadcast_request.
//
// Id remap (the one subtle bit, centralized here): recreating an item
// (create_source / create_group / add_existing / duplicate_scene) mints a NEW
// item id, so every reference to the old id anywhere in BOTH stacks must be
// rewritten or later undo/redo chains address ghosts. A call carrying
// `remap: oldId` triggers the walk when its reply carries {item: newId}.

import { verb } from './broadcastStore.js';

const CAP = 200;
const undoStack = [];
const redoStack = [];
let busy = false;

export function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > CAP) undoStack.shift();
  redoStack.length = 0;
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

function remapArgs(args, scene, oldId, newId) {
  if (!args || args.scene !== scene) return;
  if (args.item === oldId) args.item = newId;
  if (Array.isArray(args.order)) {
    for (const o of args.order) {
      if (o.item === oldId) o.item = newId;
      if (o.group === oldId) o.group = newId;
    }
  }
}

function remapEverywhere(scene, oldId, newId, running) {
  // `running` = the entry currently being executed — it's POPPED off its
  // stack, so the stack walk alone would miss its remaining calls.
  const entries = [...undoStack, ...redoStack, running];
  for (const entry of entries) {
    for (const side of [entry.undo, entry.redo]) {
      for (const call of side) remapArgs(call.args, scene, oldId, newId);
    }
  }
}

// Scene-name walk — scenes are NAME-addressed (locked), so a rename must
// rewrite every stacked reference or later undo/redo chains hit "no scene".
// The executing call itself is excluded (its literals are already correct for
// the direction it encodes; rewriting them would corrupt the next cycle).
const SCENE_NAME_OPS = new Set(['remove_scene', 'duplicate_scene', 'set_current_scene', 'create_scene', 'rename_scene']);

export function renameSceneEverywhere(oldName, newName, excludeCall = null, running = null) {
  const entries = [...undoStack, ...redoStack];
  if (running) entries.push(running);
  for (const entry of entries) {
    for (const side of [entry.undo, entry.redo]) {
      for (const call of side) {
        if (call === excludeCall || !call.args) continue;
        if (call.args.scene === oldName) call.args.scene = newName;
        if (SCENE_NAME_OPS.has(call.op) && call.args.name === oldName) call.args.name = newName;
        if (call.op === 'reorder_scenes' && Array.isArray(call.args.order)) {
          call.args.order = call.args.order.map((n) => (n === oldName ? newName : n));
        }
      }
    }
  }
}

async function runCalls(api, calls, entry) {
  for (const call of calls) {
    const data = await verb(api, call.op, call.args);
    if (call.remap != null && data && data.item != null) {
      remapEverywhere(call.args.scene, call.remap, data.item, entry);
    }
    if (call.op === 'rename_scene') {
      renameSceneEverywhere(call.args.name, call.args.new_name, call, entry);
    }
  }
}

export async function runUndo(api) {
  if (busy) return false;
  const entry = undoStack.pop();
  if (!entry) return false;
  busy = true;
  try {
    await runCalls(api, entry.undo, entry);
    redoStack.push(entry);
  } catch (e) {
    console.warn('[broadcast] undo failed:', entry.label, e);
  } finally {
    busy = false;
  }
  return true;
}

export async function runRedo(api) {
  if (busy) return false;
  const entry = redoStack.pop();
  if (!entry) return false;
  busy = true;
  try {
    await runCalls(api, entry.redo, entry);
    undoStack.push(entry);
  } catch (e) {
    console.warn('[broadcast] redo failed:', entry.label, e);
  } finally {
    busy = false;
  }
  return true;
}

// Lightweight registry for command palette actions. Mirrors the module slots
// pattern: anyone (host or module) can register/unregister actions, and the
// palette subscribes to change events.
//
// Action shape:
//   {
//     id:       'planner.toggle',        // stable id
//     label:    'Toggle Planner',         // shown in the palette
//     hint:     'Start or pause the focus session', // secondary line (optional)
//     keywords: ['timer', 'focus'],        // boost matching beyond label
//     shortcut: 'Cmd+Space',               // displayed as a key chip (optional)
//     run:      () => { … }                // invoked on Enter / click
//   }

const _actions = new Map();
const _listeners = new Set();

export function registerCommandAction(action) {
  if (!action || !action.id) return () => {};
  _actions.set(action.id, action);
  emit();
  return () => {
    _actions.delete(action.id);
    emit();
  };
}

export function getCommandActions() {
  return Array.from(_actions.values());
}

export function subscribeCommandActions(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function emit() {
  for (const fn of _listeners) {
    try { fn(); } catch {}
  }
}

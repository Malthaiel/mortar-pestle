// Global editor-dirty registry + the vault-switch discard signal.
//
// PageView is the only writer today: it marks its file path dirty while the
// buffer has unsaved edits and clears it on save / reload / unmount. The vault
// switcher reads `anyEditorDirty()` to decide whether to confirm before the
// hard reload (a switch remounts MainApp and discards everything).
//
// On a confirmed switch the switcher dispatches a `BEFORE_VAULT_SWITCH` window
// event; PageView listens and discards its pending buffer (clears dirty +
// cancels the autosave timer) BEFORE the remount, so its unmount-flush can't
// write the OLD note into the freshly-activated vault (vault_root has already
// flipped by then).

const _dirty = new Set();

export function markEditorDirty(key) {
  if (key) _dirty.add(key);
}

export function clearEditorDirty(key) {
  if (key) _dirty.delete(key);
}

export function anyEditorDirty() {
  return _dirty.size > 0;
}

export const BEFORE_VAULT_SWITCH = 'agentic:before-vault-switch';

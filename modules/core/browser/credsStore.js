// Password Vault store — a module-level external store (subscribe / getSnapshot,
// consumed via useCredsStore) shared by the toolbar key button, the per-site
// popover, and the full vault route. Mirrors tabStore.js's shape.
//
// SECRETS NEVER LIVE HERE. The decrypted store lives only in Rust (behind the
// master-password-derived key); this store holds the lock STATUS, non-secret
// entry SUMMARIES (no password/notes), folders, and settings. Passwords are
// fetched on demand via getEntry() and never retained.

import { invoke } from '@host/api.js';

let _status = null; // CredStatus | null (null = not yet queried)
let _entries = []; // CredSummary[]  (no secrets)
let _folders = []; // Folder[]
let _snapshot = { status: null, entries: [], folders: [] };
let _booted = false;
let _focusBound = false;
const subs = new Set();

function recompute() {
  _snapshot = { status: _status, entries: _entries, folders: _folders };
}
function emit() {
  recompute();
  subs.forEach(fn => { try { fn(); } catch (e) { console.error('[creds]', e); } });
}

async function refreshStatus() {
  try {
    _status = await invoke('creds_status');
  } catch (e) {
    console.error('[creds] status', e);
  }
  emit();
  return _status;
}

async function loadList() {
  try {
    const data = await invoke('creds_list');
    _entries = Array.isArray(data?.entries) ? data.entries : [];
    _folders = Array.isArray(data?.folders) ? data.folders : [];
  } catch {
    _entries = [];
    _folders = [];
  }
  emit();
}

function clearLocal() {
  _entries = [];
  _folders = [];
}

async function boot() {
  if (_booted) return;
  _booted = true;
  // Lock-on-blur is enforced app-wide by the Rust window-focus handler, so the
  // auto-reunlock must be app-wide too. useVaultLock only mounts on the in-app
  // browser page, so on other surfaces (e.g. the Password Vault settings page)
  // the vault would lock on blur with nothing to re-unlock it — forcing a master
  // re-entry. Bind a global focus listener here so the keyring "stay unlocked"
  // re-unlock fires no matter which module is open.
  if (typeof window !== 'undefined' && !_focusBound) {
    _focusBound = true;
    window.addEventListener('focus', () => { resyncOnFocus(); });
  }
  await refreshStatus();
  if (_status?.initialized && !_status?.unlocked) {
    // Opt-in "stay unlocked" — a no-op (returns false) when not enabled.
    try {
      const ok = await invoke('creds_unlock_via_keyring');
      if (ok) {
        await refreshStatus();
        await loadList();
      }
    } catch { /* keyring unavailable — fall back to manual unlock */ }
  } else if (_status?.unlocked) {
    await loadList();
  }
}

// ── store API for useSyncExternalStore ───────────────────────────────────
export function subscribe(fn) {
  if (!_booted) boot();
  subs.add(fn);
  return () => subs.delete(fn);
}
export function getSnapshot() {
  return _snapshot;
}

// ── actions (call Rust, then refresh local state) ────────────────────────
export async function initMaster(master, stayUnlocked) {
  await invoke('creds_init_master', { master });
  if (stayUnlocked) {
    try { await invoke('creds_set_keyring_unlock', { enabled: true }); } catch { /* best effort */ }
  }
  await refreshStatus();
  await loadList();
}

export async function unlock(master, stayUnlocked) {
  await invoke('creds_unlock', { master }); // rejects with {code:'BAD_PASSWORD',...} on miss
  if (stayUnlocked) {
    try { await invoke('creds_set_keyring_unlock', { enabled: true }); } catch { /* best effort */ }
  } else {
    // If the box was unchecked, make sure any prior cached key is dropped.
    try { await invoke('creds_set_keyring_unlock', { enabled: false }); } catch { /* ignore */ }
  }
  await refreshStatus();
  await loadList();
}

export async function lock() {
  try { await invoke('creds_lock'); } catch { /* ignore */ }
  clearLocal();
  await refreshStatus();
}

export function touch() {
  invoke('creds_touch').catch(() => {});
}

export async function matchHost(host) {
  if (!host) return [];
  try {
    return (await invoke('creds_match_host', { host })) || [];
  } catch {
    return [];
  }
}

export function getEntry(id) {
  return invoke('creds_get', { id });
}

export async function upsert(input) {
  const full = await invoke('creds_upsert', { input });
  await loadList();
  return full;
}

export async function remove(id) {
  await invoke('creds_delete', { id });
  await loadList();
}

export async function setFolders(folders) {
  const out = await invoke('creds_folders_set', { folders });
  _folders = Array.isArray(out) ? out : _folders;
  await loadList();
  return _folders;
}

export function generate(opts) {
  return invoke('creds_generate_password', { opts });
}

export function exportVault(password) {
  return invoke('creds_export', { password: password ?? null });
}

export async function importVault(data, format, password, mode) {
  const summary = await invoke('creds_import', {
    data,
    format,
    password: password ?? null,
    mode: mode || 'merge',
  });
  await loadList();
  await refreshStatus();
  return summary;
}

// Import from a file picked via the OS dialog — the plaintext never enters JS;
// Rust reads + parses + seals, returning only the non-secret summary.
export async function importVaultFile(path, format, password, mode) {
  const summary = await invoke('creds_import_file', {
    path,
    format,
    password: password ?? null,
    mode: mode || 'merge',
  });
  await loadList();
  await refreshStatus();
  return summary;
}

// Opt-in cleanup: delete the plaintext export file from disk after import.
export function deleteImportFile(path) {
  return invoke('creds_delete_import_file', { path });
}

// Arm the one-shot blur-lock suppressor right before opening an app-owned file
// dialog, so the dialog's toplevel-blur doesn't trip lock-on-blur and lock the
// vault mid-import. Non-fatal if unavailable.
export function suppressBlurLock() {
  return invoke('creds_suppress_blur_lock').catch(() => {});
}

export async function changeMaster(current, next) {
  await invoke('creds_change_master', { current, next });
  await refreshStatus();
}

export async function setKeyringUnlock(enabled) {
  await invoke('creds_set_keyring_unlock', { enabled });
  await refreshStatus();
}

export async function settingsSet(settings) {
  const out = await invoke('creds_settings_set', { settings });
  await refreshStatus();
  return out;
}

export async function refresh() {
  await refreshStatus();
  if (_status?.unlocked) await loadList();
}

// On app-focus regain: re-sync the lock state (Rust may have auto-locked us on
// blur). If we were locked but the user opted into keyring unlock, transparently
// re-unlock so "stay unlocked" + lock-on-blur compose instead of fighting.
export async function resyncOnFocus() {
  await refreshStatus();
  if (_status?.initialized && !_status?.unlocked && _status?.keyringEnabled) {
    try {
      const ok = await invoke('creds_unlock_via_keyring');
      if (ok) { await refreshStatus(); await loadList(); return; }
    } catch { /* keyring unavailable — stay locked, user unlocks manually */ }
  }
  if (_status?.unlocked) await loadList();
}

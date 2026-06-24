// Multi-vault host context. Owns the vault-registry mirror + active-vault
// identity, and drives the two side effects a switch needs:
//   1. push the active vault's path/name into the module-level singletons that
//      api.js (media root) and util/obsidian.js (deep-link vault name) read, and
//   2. bump `vaultEpoch`, which keys <MainApp> in App.jsx → a full remount
//      (clean slate: tabs/panes/buffers discarded, everything re-fetched) AFTER
//      the Rust side (set_active_vault) has already repointed vault_root, the
//      manifest, and the file watcher.
// This provider sits OUTSIDE the keyed MainApp, so the registry survives a
// switch; only MainApp tears down. Toasts for vault actions are fired by the UI
// components (SF3) inside NotificationProvider — this provider is headless state.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setMediaVaultRoot, setMediaLibraryRoot } from '../api.js';
import { setActiveVaultName } from '../util/obsidian.js';
import { anyEditorDirty, BEFORE_VAULT_SWITCH } from './editorDirty.js';

const VaultContext = createContext(null);

// Safe defaults so useVaults() never throws when called outside the provider
// (e.g. isolated component tests) — it degrades to a single implicit Citadel.
const DEFAULTS = {
  vaults: [],
  activeId: null,
  activeVault: null,
  vaultEpoch: 0,
  refresh: async () => {},
  switchVault: async () => {},
  addVault: async () => {},
  createVault: async () => {},
  setVaultMapping: async () => {},
  removeVault: async () => {},
  validate: async () => true,
  regenerateManifest: async () => 0,
};

export function VaultProvider({ children }) {
  const [vaults, setVaults] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [vaultEpoch, setVaultEpoch] = useState(0);

  const activeVault = vaults.find((v) => v.id === activeId) || null;

  const applyList = useCallback((out) => {
    setVaults(out?.vaults || []);
    setActiveId(out?.activeId ?? null);
  }, []);

  const refresh = useCallback(async () => {
    const out = await api.vaults.list();
    applyList(out);
    return out;
  }, [applyList]);

  // Initial load. Failure is non-fatal — the module singletons keep their
  // Citadel defaults and the app runs against the seeded default vault.
  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  // Keep the media root + Obsidian deep-link name in sync with the active vault
  // on first load and any registry refresh. switchVault also sets them eagerly
  // (below) before the remount, so the rebuilt tree never reads a stale root.
  useEffect(() => {
    if (!activeVault) return;
    setMediaVaultRoot(activeVault.path);
    setActiveVaultName(activeVault.name);
  }, [activeVault?.path, activeVault?.name]);

  // The Library vault (writable media catalogs) is a fixed mount, independent of
  // the active vault: catalog audio + playlist covers resolve against its root,
  // not the active vault's. (Library Migration Phase 2)
  useEffect(() => {
    const lib = vaults.find((v) => v.role === 'library');
    if (lib?.path) setMediaLibraryRoot(lib.path);
  }, [vaults]);

  const switchVault = useCallback(async (id) => {
    // Discard unsaved editor buffers BEFORE flipping vault_root, so PageView's
    // unmount-flush can't write the outgoing note into the new vault.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(BEFORE_VAULT_SWITCH));
    // Rust flips vault_root, repoints+rebuilds the manifest, and respawns the
    // watcher before returning the new entry.
    const entry = await api.vaults.setActive(id);
    // Update the JS singletons BEFORE the remount so the rebuilt tree resolves
    // media + deep-links against the new vault on its first render.
    setMediaVaultRoot(entry.path);
    setActiveVaultName(entry.name);
    setActiveId(entry.id);
    setVaults((prev) => prev.map((v) => (v.id === entry.id ? { ...v, ...entry } : v)));
    setVaultEpoch((e) => e + 1); // → MainApp key change → hard reload
    return entry;
  }, []);

  const addVault = useCallback(async (name, path, manifestEnabled = true) => {
    const out = await api.vaults.add(name, path, manifestEnabled);
    applyList(out);
    return out;
  }, [applyList]);

  // Scaffold a brand-new vault (empty folder → .obsidian/ + Welcome.md), then
  // register it. Returns the updated list; the caller switches to the new id.
  const createVault = useCallback(async (name, path, manifestEnabled = true) => {
    const out = await api.vaults.scaffold(name, path, manifestEnabled);
    applyList(out);
    return out;
  }, [applyList]);

  // Persist a vault's adapter mapping (SF4). Updates the in-memory entry; if it
  // targets the active vault, bump vaultEpoch to remount so the re-rooted tree
  // re-reads (Rust's ACTIVE_MAPPING cell is already updated by the command).
  const setVaultMapping = useCallback(async (id, mapping) => {
    const entry = await api.vaults.setMapping(id, mapping);
    setVaults((prev) => prev.map((v) => (v.id === entry.id ? { ...v, ...entry } : v)));
    if (id === activeId) setVaultEpoch((e) => e + 1);
    return entry;
  }, [activeId]);

  const removeVault = useCallback(async (id) => {
    const out = await api.vaults.remove(id);
    applyList(out);
    return out;
  }, [applyList]);

  const validate = useCallback((path) => api.vaults.validate(path), []);
  const regenerateManifest = useCallback((id) => api.vaults.generateManifest(id), []);

  const value = {
    vaults, activeId, activeVault, vaultEpoch,
    refresh, switchVault, addVault, createVault, setVaultMapping, removeVault, validate, regenerateManifest,
  };
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVaults() {
  return useContext(VaultContext) || DEFAULTS;
}

// Switch helper with the unsaved-changes guard. Components call request(id); if
// any editor buffer is dirty it raises a confirm (pending=true) instead of
// switching immediately. Pair with <ConfirmModal open={pending} .../>.
export function useConfirmableSwitch() {
  const { switchVault } = useVaults();
  const [pendingId, setPendingId] = useState(null);
  const request = useCallback((id) => {
    if (anyEditorDirty()) setPendingId(id);
    else switchVault(id);
  }, [switchVault]);
  const confirm = useCallback(() => {
    if (pendingId) switchVault(pendingId);
    setPendingId(null);
  }, [pendingId, switchVault]);
  const cancel = useCallback(() => setPendingId(null), []);
  return { request, pending: pendingId != null, confirm, cancel };
}

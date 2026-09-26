// Tree-toolbar vault switcher — the vault quick-switch relocated OUT of the dock
// (it left dock-buttons.js entirely; one home per button) into the file-tree
// toolbar, where it reads as the 7th canonical candy icon button. Mounted by
// VaultTree through TreeToolbar's `children` slot so it can own its own popover
// while still rendering the shared <ToolBtn/>.
//
// The list is the context menu opened as a dropdown (useMenuTrigger, Unified
// Dropdown 2026-09-17): one checked row per vault + Manage Vaults. Switch logic
// is unchanged from the dock version — useVaults / useConfirmableSwitch and the
// unsaved-changes ConfirmModal. Switching is the hard-reload
// path (vaultEpoch bump -> MainApp remount), guarded by useConfirmableSwitch.

import { sharedEvents } from '../../module-sdk/index.js';
import { useVaults, useConfirmableSwitch } from '../../hooks/useVaults.jsx';
import ConfirmModal from '../ui/ConfirmModal.jsx';
import { ToolBtn } from './TreeToolbar.jsx';
import { IconDatabase, IconPlus } from '../icons.jsx';
import { useMenuTrigger } from '../../context-menu/useContextMenu.js';

export default function TreeVaultSwitcher({ accent }) {
  const { vaults, activeId, activeVault } = useVaults();
  const { request, pending, confirm, cancel } = useConfirmableSwitch();
  const menu = useMenuTrigger(() => [
    ...vaults.map((v) => ({
      label: v.name,
      icon: IconDatabase,
      checked: v.id === activeId,
      onClick: () => { if (v.id !== activeId) request(v.id); },
    })),
    { sep: true },
    { label: 'Manage Vaults', icon: IconPlus, onClick: () => sharedEvents.emit('host:open-settings', { tab: 'vaults' }) },
  ]);
  // A vault's `name` is frequently its full path (that is what the picker stores),
  // and a whole path in a hover tooltip is unreadable. Take the last segment — a
  // name that is already friendly has no separator and survives untouched.
  const name = (activeVault?.name || 'Citadel').split(/[\\/]/).filter(Boolean).pop();

  // No wrapper: the button must be a DIRECT child of the toolbar's .candy-split
  // run, so the toggle's mousedown + keyboard open go on ToolBtn itself.
  // ConfirmModal portals (and renders nothing while closed), so it adds no part.
  return (
    <>
      <ToolBtn title={`Vault: ${name}`} accent={accent} onClick={menu.onClick}
        onMouseDown={menu.onMouseDown} onKeyDown={menu.onKeyDown} active={menu['aria-expanded']}>
        <IconDatabase/>
      </ToolBtn>

      <ConfirmModal
        open={pending}
        title="Unsaved changes"
        message="You have unsaved edits that will be discarded when switching vaults. Switch anyway?"
        confirmLabel="Switch"
        cancelLabel="Keep editing"
        onConfirm={confirm}
        onCancel={cancel}
      />
    </>
  );
}

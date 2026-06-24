// Dock vault switcher — the in-sidebar VaultSwitcher relocated to the dock.
// Mounted by Dock.jsx's renderBtn special-case (mirrors the NotificationBell
// special-case): a dock icon button whose popover opens UPWARD from the bar
// (position:fixed, anchored to the button rect, since the dock sits flush at the
// screen bottom). List + switch logic lifted verbatim from VaultSwitcher.jsx —
// useVaults / useConfirmableSwitch, the vault listbox, and the unsaved-changes
// ConfirmModal. Switching is the hard-reload path (vaultEpoch bump → MainApp
// remount), guarded by useConfirmableSwitch.

import { useEffect, useRef, useState } from 'react';
import { sharedEvents } from '../../module-sdk/index.js';
import { useVaults, useConfirmableSwitch } from '../../hooks/useVaults.jsx';
import { Popover } from '../ui';
import ConfirmModal from '../ui/ConfirmModal.jsx';
import DockButton from './DockButton.jsx';
import { IconDatabase, IconCheck, IconPlus } from '../icons.jsx';

export default function DockVaultSwitcher({ label, isActive, accent, onContextMenu }) {
  const { vaults, activeId, activeVault } = useVaults();
  const { request, pending, confirm, cancel } = useConfirmableSwitch();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    if (!open && wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  };
  const pick = (id) => { setOpen(false); if (id !== activeId) request(id); };
  const openManage = () => { setOpen(false); sharedEvents.emit('host:open-settings', { tab: 'vaults' }); };
  const name = activeVault?.name || 'Citadel';

  return (
    <span ref={wrapRef} style={{ display: 'inline-flex', position: 'relative' }}>
      <DockButton
        Icon={IconDatabase}
        label={open ? `Vault: ${name}` : label}
        onClick={toggle}
        isActive={open || isActive}
        accent={accent}
        onContextMenu={onContextMenu}
      />

      {open && rect && (
        <Popover
          open
          onClose={() => setOpen(false)}
          portal={false}
          closeOnOutside={false}
          escToClose={false}
          role="listbox"
          style={{
            position: 'fixed', zIndex: 200,
            bottom: window.innerHeight - rect.top + 8,
            left: Math.max(8, Math.min(rect.left + rect.width / 2 - 115, window.innerWidth - 238)),
            width: 230, maxHeight: 'min(60vh, 360px)',
          }}
          bodyStyle={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          {vaults.map((v) => {
            const isOn = v.id === activeId;
            return (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={isOn}
                onClick={() => pick(v.id)}
                style={{
                  appearance: 'none', border: 0, textAlign: 'left',
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '7px 9px', borderRadius: 8,
                  background: isOn ? `color-mix(in oklch, ${accent || 'var(--accent)'} 14%, transparent)` : 'transparent',
                  color: 'var(--text)', cursor: 'pointer', width: '100%',
                }}
                onMouseEnter={(e) => { if (!isOn) e.currentTarget.style.background = 'var(--surface-2)'; }}
                onMouseLeave={(e) => { if (!isOn) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', flexShrink: 0, opacity: isOn ? 1 : 0.5 }}>
                  {isOn ? <IconCheck size={13} /> : <IconDatabase size={13} />}
                </span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.path}</span>
                </span>
              </button>
            );
          })}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 2px' }} />
          <button
            type="button"
            onClick={openManage}
            style={{
              appearance: 'none', border: 0, textAlign: 'left',
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 9px', borderRadius: 8,
              background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', width: '100%', fontSize: 12,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}><IconPlus size={13} /></span>
            Manage vaults…
          </button>
        </Popover>
      )}

      <ConfirmModal
        open={pending}
        title="Unsaved changes"
        message="You have unsaved edits that will be discarded when switching vaults. Switch anyway?"
        confirmLabel="Switch"
        cancelLabel="Keep editing"
        onConfirm={confirm}
        onCancel={cancel}
      />
    </span>
  );
}

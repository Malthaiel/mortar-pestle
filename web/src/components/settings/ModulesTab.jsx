// Modules settings tab: the Tools and Community pages. The per-tier module cards
// (Core / Studio / Widget) are gone (user-directed 2026-09-28): every module is a
// row in the Settings tree instead, and right-clicking it gives Keybinds,
// Releases and Install/Uninstall (SettingsNav). ConfirmUninstall stays here, the
// box the tree shows before uninstalling a module with unsaved work.

import ToolsPanel from './ToolsPanel.jsx';

export default function ModulesTab({ accent, section }) {
  return (
    <div>
      {section === 'community' ? <CommunityPanel/> : <ToolsPanel accent={accent}/>}
    </div>
  );
}

function CommunityPanel() {
  return (
    <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '6px 0' }}>TBD</div>
  );
}

export function ConfirmUninstall({ manifest, accent, onCancel, onConfirm }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div onClick={onCancel} style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.52)',
      }}/>
      <div style={{
        position: 'relative',
        width: 380,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px 22px',
        boxShadow: 'var(--shadow-card)',
      }}>
        <div style={{
          fontSize: 14, fontWeight: 600,
          color: 'var(--text)',
          marginBottom: 8,
        }}>Uninstall {manifest?.name || 'module'}?</div>
        <div style={{
          fontSize: 12, lineHeight: 1.5,
          color: 'var(--text-muted)',
          marginBottom: 18,
        }}>
          This module is currently active — uninstalling now will discard its
          in-progress state. Settings and data stay on disk; Install brings it back.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              appearance: 'none',
              padding: '6px 14px',
              fontSize: 12,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            onClick={onConfirm}
            style={{
              appearance: 'none',
              padding: '6px 14px',
              fontSize: 12,
              borderRadius: 'var(--radius-md)',
              border: 0,
              background: accent,
              color: '#ffffff',
              cursor: 'pointer',
            }}
          >Uninstall</button>
        </div>
      </div>
    </div>
  );
}

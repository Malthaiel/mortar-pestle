// Overlay Settings panel — the in-app Overlay settings page (Settings → Modules ›
// Overlay) mounted 1-1 in the overlay host. The shared OverlaySettingsTab master
// is imported, never forked; settings/setSetting come from useSettings
// (localStorage-backed — providerless-safe in the bare host webview; writes land
// in the same focus_settings blob the main window reads, so the two surfaces stay
// in sync). Panel shell mirrors OverlayStudioPanel (useOverlayPanelDrag +
// candy-card + grip header); the body is fixed-height with its own scroll — the
// settings page is taller than an overlay panel wants to be (user call 2026-07-15,
// a deliberate exception to the no-inner-scroll overlay taste).
import { useEffect, useState } from 'react';
import OverlaySettingsTab from '@modules/studio/overlay/OverlaySettingsTab.jsx';
import { useSettings } from '@host/hooks/useSettings.js';
import useOverlayPanelDrag from './useOverlayPanelDrag.js';

// Panel presence — the StudioOverlayLauncher localStorage + window-event pattern,
// but default CLOSED (settings is an on-demand surface). Hiding keeps the panel
// mounted (display:none) so section/scroll state survives a minimize.
export const OPEN_EVT = 'overlay-settings-open-changed';
const OPEN_KEY = 'overlay-settings-open';
export const isPanelOpen = () => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } };
export const setPanelOpen = (v) => {
  try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(OPEN_EVT, { detail: !!v }));
};

export default function OverlaySettingsPanel() {
  const { style: dragStyle, dragProps } = useOverlayPanelDrag('overlay-panel-settings', { x: 260, y: 80 });
  const [open, setOpen] = useState(isPanelOpen);
  useEffect(() => {
    const onChange = (e) => setOpen(!!e.detail);
    window.addEventListener(OPEN_EVT, onChange);
    return () => window.removeEventListener(OPEN_EVT, onChange);
  }, []);
  const { settings, setSetting } = useSettings();

  return (
    <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, display: open ? undefined : 'none', ...dragStyle }}>
      <div className="candy-card ov-studio-panel ov-settings-panel">
        <div className="candy-center-row ov-studio-head" {...dragProps} style={{ touchAction: 'none' }}>
          <span className="ov-studio-title section-title">Overlay Settings</span>
          <span className="stt-grip" aria-hidden="true">⠿</span>
        </div>
        <div className="ov-settings-body" data-no-drag>
          <OverlaySettingsTab settings={settings} setSetting={setSetting} accent="var(--accent)" />
        </div>
      </div>
    </div>
  );
}

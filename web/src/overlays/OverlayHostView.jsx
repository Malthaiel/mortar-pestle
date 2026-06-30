// Overlay Host — the single fullscreen, transparent, always-on-top webview that
// renders the in-game overlays as draggable DOM panels (Overlay epic sub-plan 2),
// replacing the one-window-per-overlay model. Shown while Shift+C is held (the
// capture daemon's `overlay` hotkey → lib.rs bridge → window.show/hide). Renders
// BEFORE the provider tree (App.jsx hash short-circuit on #/overlay/host), so it
// has no Vault/Notification/Stt context — it owns its own transparent root and a
// plain absolute-positioned panel layer. Capture is panel #1; the STT, Scrim, and
// Browser panels (each with their own provider/toast as needed) land in later
// Overlay sub-plans.
import { useEffect } from 'react';
import CaptureHudPanel from './CaptureHudPanel.jsx';

// Make the host webview see-through except its panels (the window is
// transparent:true; without a transparent html/body the webview paints opaque).
function useTransparentRoot() {
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prev = [html.style.background, body.style.background];
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    return () => { html.style.background = prev[0]; body.style.background = prev[1]; };
  }, []);
}

export default function OverlayHostView() {
  useTransparentRoot();
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <CaptureHudPanel />
    </div>
  );
}

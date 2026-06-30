// Overlay Host — the single fullscreen, transparent, always-on-top webview that
// renders the in-game overlays as draggable DOM panels (Overlay epic sub-plan 2),
// replacing the one-window-per-overlay model. Shown while Shift+C is held (the
// capture daemon's `overlay` hotkey → lib.rs bridge → window.show/hide). Renders
// BEFORE the provider tree (App.jsx hash short-circuit on #/overlay/host), so it
// has no Vault/Notification/Stt context — it owns its own transparent root and a
// host-local screen-anchored toast. Capture is panel #1; the STT, Scrim, and
// Browser panels land in later Overlay sub-plans.
import { useEffect, useRef, useState } from 'react';
import { paintAccent } from '@host/themes/applyTheme.js';
import { THEME_BY_ID } from '@host/themes/registry.js';
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
  // The overlay renders before the provider tree, so the theme system never
  // paints --accent here → candy hover (var(--accent)) would read transparent.
  // Paint the user's persisted accent ourselves (same resolution as useSettings).
  useEffect(() => {
    let accent = '#7c2d2d'; // monastic default (DESIGN.md canonical red)
    try {
      const fs = JSON.parse(localStorage.getItem('focus_settings') || '{}');
      accent = fs.accentColor || THEME_BY_ID[fs.themePreset]?.defaultAccent || accent;
    } catch { /* keep the default */ }
    paintAccent(document.documentElement, accent);
  }, []);
  // Host-local toast — a fixed bottom-right candy chip. Lives here (not inside a
  // panel) because a panel is CSS-transformed, which would re-anchor position:fixed
  // to the panel instead of the viewport.
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <CaptureHudPanel showToast={showToast} />
      {toast && (
        <div className="video-cinema overlay-toast candy-btn">
          <span className="candy-face">{toast}</span>
        </div>
      )}
    </div>
  );
}

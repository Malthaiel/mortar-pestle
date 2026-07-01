// Overlay Host — the single fullscreen, transparent, always-on-top webview that
// renders the in-game overlays as draggable DOM panels (Overlay epic sub-plan 2),
// replacing the one-window-per-overlay model. Shown while Shift+C is held (the
// capture daemon's `overlay` hotkey → lib.rs bridge → window.show/hide). Renders
// BEFORE the provider tree (App.jsx hash short-circuit on #/overlay/host), so it
// has no Vault/Notification/Stt context — it owns its own transparent root and a
// host-local screen-anchored toast. The merged Overlay Studio panel (Voice +
// Video + Screenshots, reorderable tiles) is the sole panel; Scrim and Browser
// panels land in later Overlay sub-plans.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { paintAccent } from '@host/themes/applyTheme.js';
import { THEME_BY_ID } from '@host/themes/registry.js';
import SttProvider from '@modules/studio/overlay/SttProvider.jsx';
import OverlayStudioPanel from './OverlayStudioPanel.jsx';

// Minimal module-api shim for the host-mounted SttProvider. It only needs
// invoke (all stt_* calls are cross-window-safe Tauri invokes) and events.on
// (the clip→transcribe module-bus handoff, which the host doesn't have).
// ponytail: events.on stubbed — no clip→transcribe handoff in the overlay host.
const hostApi = { invoke, events: { on: () => () => {} } };

// Drag-anim defaults mirrored onto <body> for the overlay host (which never mounts
// useSettings, the writer of these attrs). Keep in sync with ANIMATION_KEY_CONFIG
// in useSettings.js. Without them DraggableSidebarList falls back to 'slot-snap'.
const DRAG_ANIM_DEFAULTS = {
  'drag-tile-follow': 'slot-snap',
  'drag-tile-smoothness': 'medium',
  'drag-drop-glide': '75',
};

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
    let animations = null;
    try {
      const fs = JSON.parse(localStorage.getItem('focus_settings') || '{}');
      accent = fs.accentColor || THEME_BY_ID[fs.themePreset]?.defaultAccent || accent;
      animations = fs.animations || null;
    } catch { /* keep the defaults */ }
    paintAccent(document.documentElement, accent);
    // The DraggableSidebarList drag clone is portaled to <body>, OUTSIDE the panel's
    // .video-cinema token scope — and the overlay renders before the theme tree, so
    // :root carries only the light base tokens. Put .video-cinema on <body> so the
    // floating clone inherits the same dark tokens the panel uses (it sets vars only,
    // no layout/descendant rules).
    document.body.classList.add('video-cinema');
    // Mirror the user's drag-anim settings onto <body> so tile pickup behaves as it
    // does in-app (useSettings writes these from the provider tree the host never
    // mounts → they'd otherwise fall back to 'slot-snap' regardless of the setting).
    for (const k of ['drag-tile-follow', 'drag-tile-smoothness', 'drag-drop-glide']) {
      document.body.setAttribute(`data-anim-${k}`, String(animations?.[k] ?? DRAG_ANIM_DEFAULTS[k]));
    }
  }, []);
  // Host-local toast — a fixed bottom-right candy chip. Lives here (not inside a
  // panel) because a panel is CSS-transformed, which would re-anchor position:fixed
  // to the panel instead of the viewport.
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (msg, ms = 2200) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <SttProvider api={hostApi}>
        <OverlayStudioPanel showToast={showToast} />
      </SttProvider>
      {toast && (
        <div className="video-cinema overlay-toast candy-btn">
          <span className="candy-face">{toast}</span>
        </div>
      )}
    </div>
  );
}

// Overlay Host — the single fullscreen, transparent, always-on-top webview that
// renders the in-game overlays as draggable DOM panels (Overlay epic sub-plan 2),
// replacing the one-window-per-overlay model. Shown while Shift+C is held (the
// capture daemon's `overlay` hotkey → lib.rs bridge → window.show/hide). Renders
// BEFORE the provider tree (App.jsx hash short-circuit on #/overlay/host), so it
// has no Vault/Notification/Stt context — it owns its own transparent root and a
// host-local screen-anchored toast. Panels: the merged Overlay Studio panel (Voice
// + Video + Screenshots, reorderable tiles), the Scrim panel, the Concierge
// chat (summoned by AgentsOverlayLauncher), and the Browser panel (the in-app
// browser 1-1, live tab webview reparented in; summoned by BrowserOverlayLauncher).
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import SttProvider from '@modules/studio/overlay/SttProvider.jsx';
import OverlayStudioPanel from './OverlayStudioPanel.jsx';
import ScrimOverlayPanel from './ScrimOverlayPanel.jsx';
import VodTimerBridge from './VodTimerBridge.jsx';
import ConciergeProvider from '@host/agents/concierge/ConciergeProvider.jsx';
import AgentsOverlayLauncher from './AgentsOverlayLauncher.jsx';
import OverlayBrowserPanel from './OverlayBrowserPanel.jsx';
import BrowserOverlayLauncher from './BrowserOverlayLauncher.jsx';
import MonitorOverlayChip from './MonitorOverlayChip.jsx';
import ScrimOverlayLauncher from './ScrimOverlayLauncher.jsx';
import StudioOverlayLauncher from './StudioOverlayLauncher.jsx';
import OverlaySettingsPanel from './OverlaySettingsPanel.jsx';
import SettingsOverlayLauncher from './SettingsOverlayLauncher.jsx';
import useSmartClickThrough from './useSmartClickThrough.js';
import { ContextMenuProvider } from '../context-menu/ContextMenuProvider.jsx';
import { useSettings } from '../hooks/useSettings.js';

// Minimal module-api shim for the host-mounted SttProvider. It only needs
// invoke (all stt_* calls are cross-window-safe Tauri invokes) and events.on
// (the clip→transcribe module-bus handoff, which the host doesn't have).
// ponytail: events.on stubbed — no clip→transcribe handoff in the overlay host.
const hostApi = { invoke, events: { on: () => () => {} } };

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
  // ONE context-menu engine for the whole host (was: none, so every tree right-click
  // AND the GameWikiRail Sort dropdown hit useContextMenu's EMPTY fallback and silently
  // no-op'd; the browser panel carried a private provider of its own). It wraps OUTSIDE
  // the transformed sheet below — the menu is position:fixed, which a CSS transform
  // would re-anchor. Chrome callbacks are inert here: the host has no command palette
  // and no settings route.
  const { settings } = useSettings();
  // The floating drag clone is portaled to <body>, OUTSIDE the panel's
  // .video-cinema token scope. Put .video-cinema on <body> so the clone inherits
  // the same dark tokens the panel uses (it sets CSS vars only — no layout rules).
  // Accent, fonts, and every data-anim-* attr are painted by useSettings, which
  // runs inside the SttProvider mounted below (child effects fire before this
  // parent effect). A prior version re-derived them here by hand and CLOBBERED the
  // themed accent with a stale default read from a stripped localStorage key —
  // deleted; the provider is now the single source of truth for the overlay too.
  useEffect(() => {
    document.body.classList.add('video-cinema');
    return () => document.body.classList.remove('video-cinema');
  }, []);

  // Fade the overlay in on show / out on hide. The lib.rs bridge emits the real
  // resulting visibility (a bool) as `overlay-host-visible`; on mount we also read
  // the window's actual visibility, which covers the dev reload-on-show path (the
  // DOM remounts already-visible, after the emit has fired). Opacity 0→1 mirrors
  // Windows' own DWM window-hide fade, which had no matching entry animation.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    getCurrentWindow().isVisible().then((v) => setVisible(!!v)).catch(() => {});
    const un = listen('overlay-host-visible', (e) => {
      if (typeof e?.payload === 'boolean') setVisible(e.payload);
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, []);

  // Close path: lib.rs no longer hides the window itself (it only emits
  // visible=false) so the CSS fade-out below can play first. Once the ~180ms
  // scale+fade has run, tell Rust to actually hide the window — this makes the
  // close use the SAME easing as the open (before, close rode Windows' DWM
  // window-hide fade, which never matched the CSS entry animation). A re-open
  // during the fade flips visible back true and cancels the pending hide.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible) { wasVisible.current = true; return undefined; }
    if (!wasVisible.current) return undefined; // never shown yet — nothing to hide
    const t = setTimeout(() => { invoke('hide_overlay_host').catch(() => {}); }, 200);
    return () => clearTimeout(t);
  }, [visible]);
  // Host-local toast — a fixed bottom-right candy chip. Lives here (not inside a
  // panel) because a panel is CSS-transformed, which would re-anchor position:fixed
  // to the panel instead of the viewport.
  // Smart click-through: empty overlay space passes clicks to the game; panels,
  // chips, and a focused text field keep the window interactive. rootRef marks the
  // fullscreen sheet so the hit-test can tell "empty" from "panel".
  const rootRef = useRef(null);
  useSmartClickThrough(visible, rootRef);

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  // Stable identity — showToast sits in child-effect dep arrays (Studio panel), so a
  // per-render closure would tear down + re-register those listeners every render.
  const showToast = useCallback((msg, ms = 2200) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Bridge ScrimViewer's agentic:notify toasts (Run Process / Extract Comms / errors)
  // to the host-local toast — the bare overlay host has no NotificationProvider, so
  // those dispatched CustomEvents would otherwise no-op.
  useEffect(() => {
    const onNotify = (e) => { const d = e.detail || {}; showToast(d.message || d.title || '', d.duration || 2200); };
    window.addEventListener('agentic:notify', onNotify);
    return () => window.removeEventListener('agentic:notify', onNotify);
  }, []);

  // Overlay-local monitor-cycle shortcut (Alt+M): cycle the overlay to the next
  // monitor via the Rust pref. Ignored while typing in an input/textarea/
  // contenteditable so it never fights the Concierge chat or the STT field.
  // CAVEAT: the overlay-host window is non-activating (focus:false + WS_EX_NOACTIVATE)
  // so the game keeps keyboard focus while the overlay is shown — this keydown may
  // not fire while the game is focused. If it doesn't, a true global hotkey needs the
  // winhook (separate follow-up). Registered only while visible.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e) => {
      if (!(e.altKey && (e.key === 'm' || e.key === 'M'))) return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      invoke('overlay_list_monitors')
        .then((list) => {
          if (!list || list.length < 2) return;
          const idx = list.findIndex((m) => m.isSelected);
          const next = list[(idx + 1) % list.length];
          if (next) invoke('overlay_set_monitor', { name: next.name }).catch(() => {});
        })
        .catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  return (
    <ContextMenuProvider openCommandPalette={() => {}} openSettings={() => {}} accent={settings.accentColor}>
    <div ref={rootRef} style={{
      position: 'fixed', inset: 0, overflow: 'hidden',
      opacity: visible ? 1 : 0,
      transform: visible ? 'scale(1)' : 'scale(0.96)',
      transition: 'opacity 180ms cubic-bezier(0.32, 0.72, 0, 1), transform 180ms cubic-bezier(0.32, 0.72, 0, 1)',
    }}>
      <SttProvider api={hostApi}>
        <OverlayStudioPanel showToast={showToast} />
      </SttProvider>
      {/* Renders nothing — pushes the Personal-VOD timer binds to the OS. It
          lives here because this window is created at boot and never destroyed,
          so the keys are armed before the overlay is ever shown. */}
      <VodTimerBridge />
      <ScrimOverlayPanel />
      <OverlayBrowserPanel visible={visible} />
      <BrowserOverlayLauncher />
      <MonitorOverlayChip />
      <ScrimOverlayLauncher />
      <StudioOverlayLauncher />
      <OverlaySettingsPanel />
      <SettingsOverlayLauncher />
      {/* Concierge over the game. Providerless — every dep (useSettings, useAgentChat,
          the api singleton) is a plain hook/singleton; agent-chunk is emitted app-
          globally so the host webview receives its own stream with no bridge. The
          launcher summons it; on dual-open with the (occluded) main window both would
          render the same reply — accepted, documented in the plan. */}
      <ConciergeProvider />
      <AgentsOverlayLauncher visible={visible} />
      {toast && (
        <div className="video-cinema overlay-toast candy-btn">
          <span className="candy-face">{toast}</span>
        </div>
      )}
    </div>
    </ContextMenuProvider>
  );
}

// Browser Overlay Panel — the in-app browser as a draggable, resizable candy
// panel in the Overlay Host (Overlay epic sub-plan 5, panel half). A 1-1 clone
// of the in-app module: the SAME BrowserPage component (inOverlay mode) beside
// the SAME TabSidebar, driving the SAME live tab webview — on show the active
// tab's WebView2 reparents main → overlay-host (Rust browser_overlay_attach);
// on panel close / host hide BrowserPage unmounts and its cleanup reparents it
// home. Tab state syncs across realms at the tabStore level (browser-tabs-sync
// events), so mutations made here mirror in-app instantly.
//
// ContextMenuProvider wraps OUTSIDE the transformed panel div — its menu portals
// to <body> with position:fixed, which a CSS transform would re-anchor. The
// native webview always paints OVER this DOM: chrome surrounds the holder rect,
// popovers reuse BrowserPage's viewport-shrink. Persistence is localStorage-only
// (providerless host realm).
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import useOverlayPanelDrag from './useOverlayPanelDrag.js';
import useOverlayPanelResize from './useOverlayPanelResize.js';
import { ContextMenuProvider } from '../context-menu/ContextMenuProvider.jsx';
import { useSettings } from '../hooks/useSettings.js';
import { IconGlobe, IconX } from '../components/icons.jsx';
import BrowserPage from '@modules/core/browser/BrowserPage.jsx';
import TabSidebar from '@modules/core/browser/TabSidebar.jsx';

// Minimal module-api shim for the browser components in the providerless host.
// router.navigate MUST exist (HistoryPopover calls it unguarded — its "see all"
// deep-link is inert here by design); events.on covers module-bus listeners.
const shimApi = { invoke, router: { navigate: () => {} }, events: { on: () => () => {} } };

// Panel presence — shared with BrowserOverlayLauncher via localStorage + a
// window event (the AgentsOverlayLauncher remember pattern). Default OPEN:
// only an explicit '0' (the close button) keeps it closed.
export const OPEN_EVT = 'overlay-browser-open-changed';
const OPEN_KEY = 'overlay-browser-open';
export const isPanelOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } };
export const setPanelOpen = (v) => {
  try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(OPEN_EVT, { detail: !!v }));
};

export default function OverlayBrowserPanel({ visible }) {
  const { settings } = useSettings();
  const accent = settings.accentColor;
  const [open, setOpen] = useState(isPanelOpen);
  useEffect(() => {
    const onChange = (e) => setOpen(!!e.detail);
    window.addEventListener(OPEN_EVT, onChange);
    return () => window.removeEventListener(OPEN_EVT, onChange);
  }, []);

  const { style: dragStyle, dragProps } = useOverlayPanelDrag('overlay-panel-browser', { x: 80, y: 60 });
  const { size, resizeProps } = useOverlayPanelResize('overlay-panel-browser-size');

  // Drag/resize pump: a translate() move changes the holder's viewport rect
  // without firing its ResizeObserver, so nudge BrowserPage's syncBounds
  // (rAF-throttled) while the pointer moves.
  const syncRef = useRef(null);
  const rafRef = useRef(0);
  const pump = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; syncRef.current?.(); });
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  const pumpDragProps = { ...dragProps, onPointerMove: (e) => { dragProps.onPointerMove(e); pump(); } };
  const pumpResizeProps = { ...resizeProps, onPointerMove: (e) => { resizeProps.onPointerMove(e); pump(); } };

  if (!open) return null;

  // The inner BrowserPage mounts only while the panel is open AND the host is
  // shown — its effects own attach/detach, so the webview pops out at the host
  // fade's START (a native HWND can't ride a DOM opacity fade) while the panel
  // chrome fades with the host.
  return (
    <ContextMenuProvider openCommandPalette={() => {}} openSettings={() => {}} accent={accent}>
      <div className="video-cinema" style={{ position: 'absolute', top: 0, left: 0, background: 'transparent', padding: 0, ...dragStyle }}>
        <div className="candy-card ov-browser-panel" style={{ width: size.w, height: size.h }}>
          {/* Header (drag handle) — title · close */}
          <div className="candy-center-row ov-browser-head" {...pumpDragProps} style={{ touchAction: 'none' }}>
            <span className="ov-browser-title section-title"><IconGlobe size={13} /> Browser</span>
            <button type="button" data-no-drag className="candy-btn" data-shape="icon" data-size="small" title="Close browser panel" aria-label="Close browser panel" onClick={() => setPanelOpen(false)}>
              <span className="candy-face"><IconX size={13} /></span>
            </button>
          </div>
          {/* Body — tab tree beside the full browser chrome */}
          <div className="ov-browser-body">
            <div className="ov-browser-side"><TabSidebar api={shimApi} accent={accent} /></div>
            <div className="ov-browser-main">
              {visible && <BrowserPage api={shimApi} accent={accent} rest="" inOverlay syncRef={syncRef} />}
            </div>
          </div>
          <div className="ov-resize-handle" data-no-drag {...pumpResizeProps} title="Resize" />
        </div>
      </div>
    </ContextMenuProvider>
  );
}

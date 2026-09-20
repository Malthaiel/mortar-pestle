import React, { Suspense } from 'react';
import { LazyErrorBoundary, lazyChunkError } from '@host/components/LazyErrorBoundary.jsx';
import SttProvider from './SttProvider.jsx';
import CaptureHotkeyBridge from './CaptureHotkeyBridge.jsx';
import OverlaySettingsTab from './OverlaySettingsTab.jsx';
import OverlayNav from './OverlayNav.jsx';
import { registerModuleKeybinds } from '@host/keybinds/registry.js';

// Studio-tier Overlay hub (Overlay epic, sub-plan 1 — Module Merge). The single
// in-app front for the in-game overlays: a 4-page secondary nav — Browser ·
// Capture · STT · Scrim. Merged from the former `game-capture` (/tools/capture)
// + `stt` (/tools/stt) modules; Capture + STT are populated by the merge, Browser
// + Scrim are placeholders until their panels land (sub-plans 4–5).
//
// Tier gating is BUILD-TIME (web/.env VITE_BUILD_TIER=studio); validateManifest
// runs BEFORE tier filtering, so a malformed manifest bricks ALL modules — keep
// it valid. Pages mount via React.lazy + .catch + a shared error boundary (the
// lazy-chunk black-app rule): a failed chunk OR a render throw degrades to a
// visible note on the route, never unmounts the whole app tree.
const CapturePage = React.lazy(() => import('./CapturePage.jsx').catch(lazyChunkError('Capture', '[capture]')));
const SttPage = React.lazy(() => import('./SttPage.jsx').catch(lazyChunkError('Speech-to-Text', '[stt]')));

// Placeholder for the Browser + Scrim overlays until their panels land
// (Overlay sub-plans 4–5).
function OverlayComingSoon({ title }) {
  return (
    <div style={{ padding: '48px 40px', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '0.04em' }}>
      {title} overlay — coming soon.
    </div>
  );
}

// GLOBAL hold-to-show chord, not an in-app one: edited here but enforced by the capture
// daemon's system-wide keyboard hook, so it fires while a game has focus.
// CaptureHotkeyBridge watches this row and pushes the Win32 virtual-key + modifier mask
// to the daemon (the STT scrim-note row works the same way). A modifier is required —
// a bare letter would be swallowed for as long as it is held.
const KEYBIND_ENTRIES = [
  {
    id: 'capture.overlay',
    group: 'Capture',
    label: 'Hold to show the in-game capture overlay',
    default: { kind: 'chord', key: 'c', modifiers: ['shift'] },
  },
];

export default {
  register(api) {
    registerModuleKeybinds(KEYBIND_ENTRIES);
    // App-level provider (always mounted in studio builds) — preloads the model
    // and keeps dictation alive across navigation. Serves the MAIN window; the
    // overlay host mounts its own SttProvider instance later (Overlay sub-plan 3).
    api.slots.registerProvider(({ children }) => (
      <SttProvider api={api}>
        <CaptureHotkeyBridge api={api} />
        {children}
      </SttProvider>
    ));
    api.slots.registerLeftSidebar({
      id: 'overlay',
      isActive: (route) => route.page === 'tools' && route.sub === 'overlay',
      renderSecondary: ({ route, accent }) => <OverlayNav route={route} accent={accent} />,
      order: 46,
    });
    api.slots.registerRoute({
      match: r => (r === '/tools/overlay' || r.startsWith('/tools/overlay/'))
        ? { rest: r.slice('/tools/overlay'.length).replace(/^\//, '') }
        : false,
      render: ({ params, accent }) => {
        const seg = (params.rest || '').split('/')[0];
        if (seg === 'transcription') {
          return (
            <LazyErrorBoundary label="Speech-to-Text" tag="[stt]">
              <Suspense fallback={null}>
                <SttPage accent={accent} />
              </Suspense>
            </LazyErrorBoundary>
          );
        }
        if (seg === 'browser') return <OverlayComingSoon title="Browser" />;
        if (seg === 'scrim') return <OverlayComingSoon title="Scrim" />;
        return (
          <LazyErrorBoundary label="Capture" tag="[capture]">
            <Suspense fallback={null}>
              <CapturePage api={api} accent={accent} rest={params.rest || ''} />
            </Suspense>
          </LazyErrorBoundary>
        );
      },
    });
    // ONE settings tab — the drawer surfaces only the FIRST registerSettingsTab
    // per module (SettingsDrawer pagesByModuleId), so Capture + Voice are combined
    // into a sectioned page (OverlaySettingsTab) rather than two dropped siblings.
    api.slots.registerSettingsTab({ id: 'overlay-settings', label: 'Overlay', render: OverlaySettingsTab });
  },
};

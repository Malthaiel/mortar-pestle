import React, { Suspense } from 'react';
import SidebarPill from '@host/components/SidebarPill.jsx';
import RailStat from '@host/components/sidebar/RailStat.jsx';
import { LazyErrorBoundary, lazyChunkError } from '@host/components/LazyErrorBoundary.jsx';
import useCaptureState from './useCaptureState.js';
import CaptureSettingsTab from './CaptureSettingsTab.jsx';

// Studio-tier module (Game Capture epic, Step 4 frontend). Tier gating is
// BUILD-TIME: web/.env sets VITE_BUILD_TIER=studio for local artifacts;
// module-loader.js drops studio manifests whenever buildTier !== 'studio'.
//
// Standing cautions (same as video-editor — Host Extensions § Studio-tier
// build flag):
// - validateManifest runs BEFORE tier filtering — a malformed studio manifest
//   bricks ALL modules, even in core builds where this one never registers.
// - Never list "game-capture" in a core module's `requires` — the post-filter
//   toposort throws in core builds once the studio manifest is dropped.
//
// CapturePage mounts via React.lazy + .catch + a shared error boundary (the
// lazy-chunk black-app rule): a failed chunk fetch OR a render throw must
// degrade to a visible note on the route, never unmount the whole app tree.
const CapturePage = React.lazy(() => import('./CapturePage.jsx').catch(lazyChunkError('Capture', '[capture]')));

// Collapsed 56 px rail: surface REC / IDLE / DOWN at a glance.
function CaptureRail({ accent, api }) {
  const { snapshot, engine } = useCaptureState(api);
  const value = engine?.state === 'down' || engine?.state === 'failed'
    ? 'DOWN'
    : snapshot?.recording ? 'REC' : 'IDLE';
  return <RailStat label="CAPTURE" value={value} accent={accent} />;
}

export default {
  register(api) {
    // No registerModuleKeybinds — the capture hotkeys are bound by the
    // backend portal (record / save_replay / screenshot), not the JS keybind
    // registry. The page installs no global keydown listener.
    const { IconGamepad } = api.ui.icons;
    api.slots.registerLeftSidebar({
      id: 'game-capture',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconGamepad}
          label="Capture"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/tools/capture')}
        />
      ),
      isActive: (route) => route.page === 'tools' && route.sub === 'capture',
      renderRail: ({ accent }) => <CaptureRail accent={accent} api={api} />,
      order: 46,
    });
    api.slots.registerRoute({
      match: r => r === '/tools/capture' || r.startsWith('/tools/capture/')
        ? { rest: r.slice('/tools/capture'.length).replace(/^\//, '') }
        : false,
      render: ({ params, accent }) => (
        <LazyErrorBoundary label="Capture" tag="[capture]">
          <Suspense fallback={null}>
            <CapturePage api={api} accent={accent} rest={params.rest || ''} />
          </Suspense>
        </LazyErrorBoundary>
      ),
    });
    // Settings → Modules › Capture (5-SF4): read-only encoder readout, live
    // hotkey rows + rebind path, and the Phase-2 replay-length slider stub.
    api.slots.registerSettingsTab({
      id: 'capture-settings',
      label: 'Capture',
      render: CaptureSettingsTab,
    });
  },
};

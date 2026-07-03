import React, { Suspense } from 'react';
import SidebarPill from '@host/components/SidebarPill.jsx';
import { LazyErrorBoundary, lazyChunkError } from '@host/components/LazyErrorBoundary.jsx';
import { registerModuleKeybinds } from '@host/keybinds/registry.js';
import BroadcastSettingsTab from './BroadcastSettingsTab.jsx';
import BroadcastSidebar from './BroadcastSidebar.jsx';

// Studio-tier Broadcast module (Broadcast epic, sub-plan 2 — Module Shell &
// Preview). The OBS-parity studio surface: SP2 ships the live child-HWND
// preview + composer-bar skeleton; scene/source trees land in SP3.
//
// Tier gating is BUILD-TIME (web/.env VITE_BUILD_TIER=studio); validateManifest
// runs BEFORE tier filtering, so a malformed manifest bricks ALL modules — keep
// it valid. Pages mount via React.lazy + .catch + a shared error boundary (the
// lazy-chunk black-app rule).
const BroadcastPage = React.lazy(() => import('./BroadcastPage.jsx').catch(lazyChunkError('Broadcast', '[broadcast]')));

export const KEYBIND_ENTRIES = [
  // Meta+Shift+B, not an R-chord: Ctrl+R / Ctrl+Shift+R are WebView2 browser
  // accelerators handled below JS — preventDefault can't stop a webview reload.
  { id: 'broadcast.record-toggle', group: 'Broadcast', label: 'Toggle recording', default: { kind: 'chord', key: 'b', modifiers: ['meta', 'shift'] } },
];

export default {
  register(api) {
    const { IconBroadcast } = api.ui.icons;
    registerModuleKeybinds(KEYBIND_ENTRIES);
    // One-shot stale-region heal: an F5 reload kills JS without running any
    // unmount cleanup, stranding a live native preview region over the page.
    // A fresh JS boot means no display should exist — clear the ghost.
    // Best-effort: the engine may be down or the command not yet registered.
    api.invoke('broadcast_display_destroy', { id: 'preview' }).catch(() => {});
    api.slots.registerLeftSidebar({
      id: 'broadcast',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconBroadcast}
          label="Broadcast"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/tools/broadcast')}
        />
      ),
      isActive: (route) => route.page === 'tools' && route.sub === 'broadcast',
      // SP3: the combined scene/source tree (scenes = folders, sources =
      // children, groups = sub-folders) — the module's secondary sidebar.
      renderSecondary: ({ accent }) => <BroadcastSidebar api={api} accent={accent} />,
      order: 47,
    });
    api.slots.registerRoute({
      match: r => (r === '/tools/broadcast' || r.startsWith('/tools/broadcast/')) ? {} : false,
      render: ({ accent }) => (
        <LazyErrorBoundary label="Broadcast" tag="[broadcast]">
          <Suspense fallback={null}>
            <BroadcastPage api={api} accent={accent} />
          </Suspense>
        </LazyErrorBoundary>
      ),
    });
    // ONE settings tab — the drawer surfaces only the FIRST registerSettingsTab
    // per module (SettingsDrawer pagesByModuleId).
    api.slots.registerSettingsTab({ id: 'broadcast-settings', label: 'Broadcast', render: BroadcastSettingsTab });
  },
};

import React, { Suspense } from 'react';
import SidebarPill from '@host/components/SidebarPill.jsx';
import RailStat from '@host/components/sidebar/RailStat.jsx';
import { LazyErrorBoundary, lazyChunkError } from '@host/components/LazyErrorBoundary.jsx';
import SttProvider, { useStt } from './SttProvider.jsx';
import SttSettingsTab from './SttSettingsTab.jsx';

// Studio-tier Voice Transcription module (Voice Transcription epic, Phase 3).
// Tier gating is BUILD-TIME: web/.env sets VITE_BUILD_TIER=studio; module-loader
// drops studio manifests when buildTier !== 'studio' — verify by ARTIFACT-DIFF,
// not dev (dev always loads studio). The /tools/:sub route shape is generic, so
// NO router.js edit is needed. SttPage mounts via React.lazy + .catch + a shared
// error boundary (the lazy-chunk black-app rule): a failed chunk OR a render
// throw degrades to a visible note, never unmounts the whole app tree.
const SttPage = React.lazy(() => import('./SttPage.jsx').catch(lazyChunkError('Speech-to-Text', '[stt]')));

// Collapsed 56px rail — REC while dictating, WORK while transcribing a file,
// DOWN when the engine is unavailable, else IDLE. Reads the app-level context.
function SttRail({ accent }) {
  const stt = useStt();
  const value = stt?.engineDown ? 'DOWN' : stt?.recording ? 'REC' : stt?.fileBusy ? 'WORK' : 'IDLE';
  return <RailStat label="VOICE" value={value} accent={accent} />;
}

export default {
  register(api) {
    const { IconMic } = api.ui.icons;
    // App-level provider (always mounted in studio builds) — preloads the model
    // and keeps dictation alive across navigation.
    api.slots.registerProvider(({ children }) => <SttProvider api={api}>{children}</SttProvider>);
    api.slots.registerLeftSidebar({
      id: 'stt',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconMic}
          label="Voice"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/tools/stt')}
        />
      ),
      isActive: (route) => route.page === 'tools' && route.sub === 'stt',
      renderRail: ({ accent }) => <SttRail accent={accent} />,
      order: 47,
    });
    api.slots.registerRoute({
      match: r => (r === '/tools/stt' || r.startsWith('/tools/stt/'))
        ? { rest: r.slice('/tools/stt'.length).replace(/^\//, '') }
        : false,
      render: ({ accent }) => (
        <LazyErrorBoundary label="Speech-to-Text" tag="[stt]">
          <Suspense fallback={null}>
            <SttPage accent={accent} />
          </Suspense>
        </LazyErrorBoundary>
      ),
    });
    // Settings → Modules › Voice (Phase 5). Model picker + backend + VAD tuning.
    api.slots.registerSettingsTab({
      id: 'stt-settings',
      label: 'Voice',
      render: SttSettingsTab,
    });
  },
};

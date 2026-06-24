import React, { Suspense } from 'react';
import SidebarPill from '@host/components/SidebarPill.jsx';
import RailStat from '@host/components/sidebar/RailStat.jsx';
import { useHashRoute } from '@host/router.js';
import { registerModuleKeybinds } from '@host/keybinds/registry.js';
import { VEDIT_KEYBIND_ENTRIES } from './keybinds.js';
import VeditNav from './color/VeditNav.jsx';

// First studio-tier module (Video Editor Phase 1 — cuts-only NLE). Tier gating
// is BUILD-TIME: web/.env sets VITE_BUILD_TIER=studio for local artifacts;
// module-loader.js drops studio manifests whenever buildTier !== 'studio'
// (real env overrides .env, so a core artifact is one
// `VITE_BUILD_TIER=core npm run tauri build` away).
//
// Standing cautions (Host Extensions § Studio-tier build flag):
// - validateManifest runs BEFORE tier filtering — a malformed studio manifest
//   bricks ALL modules, even in core builds where this one never registers.
// - Never list "video-editor" in a core module's `requires` — the post-filter
//   toposort throws in core builds once the studio manifest is dropped.
//
// EditorPage mounts via React.lazy so the editor tree stays off the boot path:
// loadAll() awaits every module entry before first paint, and ARCHITECTURE.md
// budgets cold start < 1.5 s.
// .catch on the lazy import + a local error boundary (the lazy-chunk
// black-app rule): a failed chunk fetch OR a render throw inside the editor
// must degrade to a visible note on the editor route — never unmount the
// whole app tree into a blank window.
const EditorPage = React.lazy(() => import('./EditorPage.jsx').catch((err) => {
  console.error('[vedit] editor chunk failed to load', err);
  return {
    default: () => (
      <div style={{ padding: 24, fontFamily: '"DM Mono", monospace', fontSize: 12.5, color: 'var(--text-muted)' }}>
        Video Editor failed to load — see the console (right-click → Inspect Element).
      </div>
    ),
  };
}));

class EditorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err) {
    console.error('[vedit] editor crashed', err);
  }

  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, fontFamily: '"DM Mono", monospace', fontSize: 12.5, color: 'var(--text-muted)' }}>
          Video Editor crashed: {String(this.state.err?.message || this.state.err)} — see the console.
        </div>
      );
    }
    return this.props.children;
  }
}

// Collapsed 56 px rail: show the active mode (Edit / Color) as a stat.
function VeditRail({ accent }) {
  const route = useHashRoute();
  const seg = (route?.rest || '').split('/')[0];
  return <RailStat label="MODE" value={seg === 'color' ? 'COLOR' : 'EDIT'} accent={accent} />;
}

export default {
  register(api) {
    // Tier-aware keybind visibility: rows exist in Settings ▸ Keybinds and
    // the ? cheatsheet only in builds that ship this module (loadAll runs
    // every entry before first render, ahead of the settings seed/merge).
    registerModuleKeybinds(VEDIT_KEYBIND_ENTRIES);

    const { IconClapperboard } = api.ui.icons;
    api.slots.registerLeftSidebar({
      id: 'video-editor',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconClapperboard}
          label="Video Editor"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/tools/video-editor')}
        />
      ),
      isActive: (route) => route.page === 'tools' && route.sub === 'video-editor',
      renderSecondary: ({ route, accent }) => <VeditNav route={route} accent={accent} />,
      renderRail: ({ accent }) => <VeditRail accent={accent} />,
      order: 45,
    });
    api.slots.registerRoute({
      match: r => r === '/tools/video-editor' || r.startsWith('/tools/video-editor/')
        ? { rest: r.slice('/tools/video-editor'.length).replace(/^\//, '') }
        : false,
      render: ({ params, accent }) => (
        <EditorBoundary>
          <Suspense fallback={null}>
            <EditorPage api={api} accent={accent} rest={params.rest || ''} />
          </Suspense>
        </EditorBoundary>
      ),
    });
  },
};

// Dev tab — home for developer tooling panels. Normally constant-folded out of
// prod builds (the import.meta.env.DEV gate in SettingsDrawer); a prod build
// made with VITE_DEV_TOOLS=1 keeps it, which is how the installed RPM gets the
// Dev Server control panel. Future dev panels join below.
import { Component } from 'react';
import DevServerPanel from './DevServerPanel.jsx';
import GpuSpikePanel from './GpuSpikePanel.jsx';
// SttDevPanel retired in Voice Transcription Phase 3 — the real surface is the
// /tools/stt Voice module. The throwaway panel file is kept (no git) but no
// longer mounted; delete it once Phase 3 has shipped a release.

// A dev-panel throw must never unmount the host tree (no boundary above the
// settings pane) — contain it here.
class PanelBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[dev-tab]', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: '#e66' }}>
          Dev panel crashed: {String(this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function DevTab({ accent }) {
  return (
    <div className="dev-tab">
      <div style={{
        fontSize: 11, color: 'var(--text-faint)', marginBottom: 16,
        fontFamily: 'var(--font-mono)',
      }}>
        Developer tooling.
      </div>
      {import.meta.env.VITE_TARGET_OS === 'linux' ? (
        <PanelBoundary>
          <DevServerPanel accent={accent} />
        </PanelBoundary>
      ) : (
        <div style={{
          fontSize: 11, color: 'var(--text-faint)', marginBottom: 16,
          fontFamily: 'var(--font-mono)',
        }}>
          Dev-server restart is Linux-only — Windows dev runs via{' '}
          <code>npm run tauri dev</code> in a terminal.
        </div>
      )}
      <PanelBoundary>
        <GpuSpikePanel accent={accent} />
      </PanelBoundary>
    </div>
  );
}

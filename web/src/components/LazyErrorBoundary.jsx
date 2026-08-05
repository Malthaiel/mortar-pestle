import React from 'react';

// Shared crash surface for studio lazy-loaded pages (the "lazy-chunk black-app
// rule"): a failed chunk fetch OR a render throw inside a tools page must
// degrade to a visible note on its route, never unmount the whole app tree.
// `label` names the page in the note; `tag` prefixes the console line.

const NOTE_STYLE = {
  padding: 24,
  fontFamily: 'var(--font-mono), monospace',
  fontSize: 12.5,
  color: 'var(--text-muted)',
};

function CrashNote({ children }) {
  return <div style={NOTE_STYLE}>{children}</div>;
}

// React.lazy(() => import('./Page.jsx').catch(lazyChunkError('Capture', '[capture]')))
export function lazyChunkError(label, tag) {
  return (err) => {
    console.error(`${tag} page chunk failed to load`, err);
    return {
      default: () => (
        <CrashNote>{label} failed to load — see the console (right-click → Inspect Element).</CrashNote>
      ),
    };
  };
}

export class LazyErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err) {
    console.error(`${this.props.tag} page crashed`, err);
  }

  render() {
    if (this.state.err) {
      const e = this.state.err;
      // `full` = mounted at the root, where the alternative is a blank window.
      if (this.props.full) return <FatalCard err={e} />;
      return <CrashNote>{this.props.label} crashed: {String(e?.message || e)} — see the console.</CrashNote>;
    }
    return this.props.children;
  }
}

// Root crash surface. Before this existed, one render throw anywhere unmounted
// the whole tree and left a silent blank window whose only exit was restarting
// the dev server — the error lived in the console nobody had open.
const FATAL_WRAP = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 20,
  height: '100vh',
  padding: 32,
  textAlign: 'center',
  fontFamily: 'var(--font-mono), monospace',
  fontSize: 12.5,
  color: 'var(--text-muted)',
};

const FATAL_MSG = {
  maxWidth: 720,
  whiteSpace: 'pre-wrap',
  textAlign: 'left',
  color: 'var(--error)',
  overflowY: 'auto',
  maxHeight: '40vh',
};

export function FatalCard({ err }) {
  const stack = String(err?.stack || err?.message || err);
  return (
    <div style={FATAL_WRAP}>
      <div>Mortar &amp; Pestle hit an error and stopped drawing.</div>
      <div style={FATAL_MSG}>{stack}</div>
      <button type="button" className="candy-btn" onClick={() => location.reload()}>
        <span className="candy-face">Reload</span>
      </button>
      <div>Right-click → Inspect Element for the full trace.</div>
    </div>
  );
}

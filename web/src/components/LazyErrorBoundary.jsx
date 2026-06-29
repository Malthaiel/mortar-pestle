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
      return <CrashNote>{this.props.label} crashed: {String(e?.message || e)} — see the console.</CrashNote>;
    }
    return this.props.children;
  }
}

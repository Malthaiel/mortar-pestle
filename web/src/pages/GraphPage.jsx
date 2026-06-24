// Graph page — builds the node/edge graph from the vault manifest and hosts the
// WebGL canvas plus its overlay chrome (search, Local toggle, Reset, and the
// selected-node card). Selection drives both the canvas highlight and the card;
// Local mode narrows the canvas to the selected node's neighborhood.

import { Component, lazy, Suspense, useMemo, useRef, useState } from 'react';
import { useManifestData } from '../lib/manifestReader.js';
import { buildLinkGraph } from '../lib/linkGraph.js';
import { navigate } from '../router.js';
import { encodePagePath } from '../components/SidebarBrowser.jsx';
import { FilterChip, LoadingState, EmptyState } from '../components/ui/index.js';

const PANEL = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  boxShadow: '0 6px 20px color-mix(in oklch, var(--shadow, #000) 18%, transparent)',
};

// GraphCanvas pulls in pixi.js (a large WebGL dep); lazy-split so it only loads
// on first /graph visit, keeping it off the app's initial bundle. The error
// boundary keeps a failed chunk from unmounting the whole app tree.
const GraphCanvas = lazy(() => import('../components/GraphCanvas.jsx'));

class CanvasBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err) { console.error('[graph] canvas failed', err); }
  render() {
    if (this.state.failed) {
      return <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        The graph renderer failed to load.
      </div>;
    }
    return this.props.children;
  }
}

function GraphCanvasLazy(props) {
  return (
    <CanvasBoundary>
      <Suspense fallback={<div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><LoadingState label="Rendering…"/></div>}>
        <GraphCanvas {...props} />
      </Suspense>
    </CanvasBoundary>
  );
}

export default function GraphPage({ accent }) {
  const manifest = useManifestData();
  const { nodes, links } = useMemo(() => buildLinkGraph(manifest?.entries), [manifest]);

  const [selected, setSelected] = useState(null);
  const [localMode, setLocalMode] = useState(false);
  const [query, setQuery] = useState('');
  const actionsRef = useRef(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes
      .filter(n => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, 8);
  }, [query, nodes]);

  function pick(node) {
    setSelected(node);
    setQuery('');
    if (localMode) requestAnimationFrame(() => actionsRef.current?.fitSelection?.());
  }
  function openSelected() {
    if (selected) navigate('/page/' + encodePagePath(selected.path));
  }
  function clearSelection() {
    setSelected(null);
    if (localMode) { setLocalMode(false); requestAnimationFrame(() => actionsRef.current?.reset?.()); }
  }
  function toggleLocal() {
    const next = !localMode;
    setLocalMode(next);
    requestAnimationFrame(() => (next ? actionsRef.current?.fitSelection?.() : actionsRef.current?.reset?.()));
  }
  function resetView() {
    setLocalMode(false);
    setSelected(null);
    requestAnimationFrame(() => actionsRef.current?.reset?.());
  }

  if (!manifest) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><LoadingState label="Loading graph…"/></div>;
  }
  if (!nodes.length) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <EmptyState message="No linked pages in this vault yet. Add wikilinks between notes and they’ll appear here."/>
    </div>;
  }

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      <GraphCanvasLazy
        nodes={nodes} links={links} accent={accent}
        selectedId={selected?.id || null} localMode={localMode}
        onSelect={setSelected} onOpen={openSelected} actionsRef={actionsRef}
      />

      {/* Toolbar */}
      <div style={{ position: 'absolute', top: 12, left: 12, width: 260, ...PANEL, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Graph</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
            {nodes.length} nodes · {links.length} links
          </span>
        </div>

        <div style={{ position: 'relative' }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search pages…"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '7px 10px',
              fontSize: 13, color: 'var(--text)', background: 'var(--surface-2)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', outline: 'none',
            }}
          />
          {results.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, ...PANEL, maxHeight: 240, overflow: 'auto', zIndex: 2 }}>
              {results.map(n => (
                <button
                  key={n.id} type="button" onClick={() => pick(n)}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 10px' }}
                >
                  <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.path}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <FilterChip onClick={toggleLocal} active={localMode} accent={accent} disabled={!selected}
            title={selected ? 'Show only the selected node’s neighborhood' : 'Select a node first'}>
            Local
          </FilterChip>
          <FilterChip onClick={resetView} accent={accent}>Reset view</FilterChip>
        </div>
      </div>

      {/* Selected-node card */}
      {selected && (
        <div style={{ position: 'absolute', top: 12, right: 12, width: 260, ...PANEL, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', lineHeight: 1.25 }}>{selected.title}</span>
            <button type="button" onClick={clearSelection} title="Clear selection"
              style={{ background: 'transparent', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', wordBreak: 'break-all' }}>{selected.path}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{selected.degree} link{selected.degree === 1 ? '' : 's'}</div>
          <div><FilterChip onClick={openSelected} accent={accent}>Open page →</FilterChip></div>
        </div>
      )}
    </div>
  );
}

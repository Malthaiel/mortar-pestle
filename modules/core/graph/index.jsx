// Graph module — a force-directed WebGL graph of vault pages + wikilinks.
// Registers a dock pill (→ /graph) and the route. The page is full-bleed in the
// main pane; the secondary sidebar lists the most-connected pages + a controls
// legend so the expanded rail isn't empty.

import { useMemo } from 'react';
import GraphPage from '@host/pages/GraphPage.jsx';
import SidebarPill from '@host/components/SidebarPill.jsx';
import { useManifestData } from '@host/lib/manifestReader.js';
import { buildLinkGraph, orderedGroups, groupColor } from '@host/lib/linkGraph.js';
import { navigate } from '@host/router.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';

function GraphSidebar() {
  const manifest = useManifestData();
  const { hubs, groups } = useMemo(() => {
    const { nodes } = buildLinkGraph(manifest?.entries);
    const hubs = nodes.slice().sort((a, b) => b.degree - a.degree).slice(0, 15);
    return { hubs, groups: orderedGroups(nodes) };
  }, [manifest]);

  return (
    <div style={{ padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '0 8px 6px' }}>
          Most connected
        </div>
        {hubs.map(n => (
          <button
            key={n.id} type="button" onClick={() => navigate('/page/' + encodePagePath(n.path))}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 8px', textAlign: 'left', borderRadius: 'var(--radius-sm)' }}
          >
            <span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</span>
            <span style={{ fontSize: 11, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{n.degree}</span>
          </button>
        ))}
      </div>
      {groups.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '0 8px 6px' }}>
            Folders
          </div>
          {groups.map(g => (
            <div key={g || '·'} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: groupColor(g, groups), boxShadow: '0 0 0 1px color-mix(in oklch, #000 14%, transparent)' }} />
              <span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g || 'Root'}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '0 8px', lineHeight: 1.6 }}>
        Scroll to zoom · drag to pan · drag a node to move it · click to select.
      </div>
    </div>
  );
}

export default {
  register(api) {
    const { IconGraph } = api.ui.icons;

    api.slots.registerLeftSidebar({
      id: 'graph',
      render: ({ collapsed, accent, active }) => (
        <SidebarPill
          Icon={IconGraph}
          label="Graph"
          expanded={!collapsed}
          accent={accent}
          active={active}
          onClick={() => api.router.navigate('/graph')}
        />
      ),
      isActive: (route) => route.page === 'graph',
      renderSecondary: () => <GraphSidebar/>,
      order: 10,
    });

    api.slots.registerRoute({
      match: (path) => (path === '/graph' ? {} : false),
      render: ({ accent }) => (
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <GraphPage accent={accent}/>
        </div>
      ),
    });
  },
};

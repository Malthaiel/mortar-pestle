// Generic tree sidebar — the shared shell every NON-vault module mounts (Browser /
// Library / Skills / Docs). Same header band + scroll body + bottom spacer + candy
// primitives as the vault, but fed a plain in-memory node tree + a controller
// (expand / sort / reveal), so each surface keeps its own data + behaviour. The
// vault keeps its own lazy/disk renderer (VaultTree); this one renders fully-loaded
// children and is deliberately simpler.
//
//   Node = { id, label, isFolder, active?, onActivate?, onContextMenu?, suffix?,
//            leadIcon?, trailing?, children?[] }
//   controller = expand surface (isOpen/toggle/anyExpanded/expandAll/collapseAll)
//                + sort (sortMode/setSortMode/sortModes) + reveal — exactly what
//                TreeToolbar consumes.

import { useState, useEffect } from 'react';
import { useSettings } from '../../hooks/useSettings.js';
import {
  AnimCtx, SuffixCtx, REVEAL, MUTED, GAP,
  CandyHeader, TreeRow, TreeChildren, Collapsible, StaggerChild,
} from './treeKit.jsx';
import TreeToolbar from './TreeToolbar.jsx';

// A folder's children, staggered in once the group has "entered" (a deferred rAF
// flag so the first frame is hidden → it transitions instead of snapping). Top-level
// folders pass animateOnMount=false so a page load doesn't cascade every group.
function NodeBody({ node, controller, accent, open, animateOnMount = true }) {
  const [entered, setEntered] = useState(!animateOnMount);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const shown = entered && open;
  const kids = node.children || [];
  const n = kids.length;
  let inner;
  if (n === 0) inner = <div style={MUTED}>empty</div>;
  else inner = kids.map((child, i) => (
    <StaggerChild key={child.id} index={i} count={n} open={shown}>
      <TreeNode node={child} controller={controller} accent={accent}/>
    </StaggerChild>
  ));
  return <TreeChildren>{inner}</TreeChildren>;
}

function TreeNode({ node, controller, accent, topLevel = false }) {
  if (node.isFolder) {
    const open = controller.isOpen(node.id);
    const count = (node.children || []).length;
    const mounted = open || count > 0; // keep body for the collapse cascade
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <CandyHeader label={node.label} open={open} onToggle={() => controller.toggle(node)}
          accent={accent} onContextMenu={node.onContextMenu}
          leadIcon={node.leadIcon} trailing={node.trailing}/>
        <Collapsible open={open} count={count}>
          {mounted && <NodeBody node={node} controller={controller} accent={accent}
            open={open} animateOnMount={!topLevel}/>}
        </Collapsible>
      </div>
    );
  }
  return (
    <TreeRow label={node.label} selected={!!node.active} accent={accent}
      onClick={node.onActivate} onContextMenu={node.onContextMenu}
      suffix={node.suffix} leadIcon={node.leadIcon} trailing={node.trailing}/>
  );
}

export default function TreeSidebar({ nodes, controller, buttons, accent, showSuffix = false }) {
  const { settings } = useSettings();
  // Reuse the vault tree's cascade-timing preset so every sidebar animates alike.
  const anim = REVEAL[settings.vaultTreeReveal] || REVEAL.normal;

  return (
    <AnimCtx.Provider value={anim}>
    <SuffixCtx.Provider value={showSuffix}>
      <div style={{
        display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
        '--candy-depth-nav': 'calc(var(--candy-depth) * 0.85)',
      }}>
        {/* Pinned toolbar in the NON-scrolling header band — rides the sidebar's
            circuit texture; rows scroll in the box below. Bottom pad = GAP so the
            buttons' candy slab clears the first row. */}
        <div style={{ flexShrink: 0, padding: `8px 8px ${GAP}` }}>
          <TreeToolbar buttons={buttons} controller={controller} accent={accent}/>
        </div>
        {/* Scrolling tree body — the only scroller. overflowX hidden keeps long
            names ellipsizing (the min-width:0 chain). */}
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
          display: 'flex', flexDirection: 'column', gap: GAP, padding: '0 8px',
        }}>
          {(nodes || []).map((node) => (
            <TreeNode key={node.id} node={node} controller={controller} accent={accent} topLevel/>
          ))}
          {/* Bottom dock clearance — an in-flow spacer that rides the scroll so the
              last row always clears the flush bottom dock. */}
          <div aria-hidden style={{ flexShrink: 0, height: 9 }}/>
        </div>
      </div>
    </SuffixCtx.Provider>
    </AnimCtx.Provider>
  );
}

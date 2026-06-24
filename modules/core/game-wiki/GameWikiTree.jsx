// Game Wiki sidebar tree — the read-only games tree (top-level = games, expand into
// each game's raw folder structure). Renders with the shared treeKit candy-pill
// primitives so it's pixel-identical to the vault tree, backed by the lazy
// useGameWikiTree hook. No file ops / context menu (the gamewiki vault is read-only).

import { useState, useEffect } from 'react';
import { navigate } from '@host/router.js';
import { useSettings } from '@host/hooks/useSettings.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import {
  AnimCtx, SuffixCtx, REVEAL, GAP, MUTED,
  CandyHeader, TreeRow, TreeChildren, Collapsible, StaggerChild,
} from '@host/components/vault-tree/treeKit.jsx';
import { useGameWikiTree } from './useGameWikiTree.js';

// The Coaching/Scrim folder also navigates to the ScrimListLanding (Option C),
// not just toggling expansion.
const SCRIM_BASE = 'Deadlock/Coaching/Scrim';

function TreeBody({ node, tree, accent, currentPath, open, animateOnMount = true }) {
  const [entered, setEntered] = useState(!animateOnMount);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const shown = entered && open;
  const entry = tree.childrenOf(node.vaultPath);
  const nodes = entry?.nodes || [];
  const loading = !entry || entry.loading;
  const n = nodes.length;
  let inner;
  if (loading && n === 0) inner = <div style={MUTED}>…</div>;
  else if (n === 0) inner = <div style={MUTED}>empty</div>;
  else inner = nodes.map((child, i) => (
    <StaggerChild key={child.vaultPath} index={i} count={n} open={shown}>
      <TreeNode node={child} tree={tree} accent={accent} currentPath={currentPath}/>
    </StaggerChild>
  ));
  return <TreeChildren>{inner}</TreeChildren>;
}

function TreeNode({ node, tree, accent, currentPath }) {
  if (node.isFolder) {
    const open = tree.isOpen(node.vaultPath);
    const entry = tree.childrenOf(node.vaultPath);
    const mounted = open || !!entry;
    const count = entry?.nodes?.length || 0;
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <CandyHeader label={node.name} open={open} accent={accent}
          onToggle={() => {
            tree.toggle(node.vaultPath);
            if (node.vaultPath === SCRIM_BASE) navigate('/game-wiki/' + encodePagePath(node.vaultPath));
          }}/>
        <Collapsible open={open} count={count}>
          {mounted && <TreeBody open={open} node={node} tree={tree} accent={accent} currentPath={currentPath}/>}
        </Collapsible>
      </div>
    );
  }
  const selected = currentPath === node.vaultPath;
  return (
    <TreeRow label={node.name} selected={selected} accent={accent}
      onClick={() => navigate('/game-wiki/' + encodePagePath(node.vaultPath))}/>
  );
}

export default function GameWikiTree({ route, accent }) {
  const tree = useGameWikiTree();
  const { settings } = useSettings();
  const anim = REVEAL[settings.vaultTreeReveal] || REVEAL.normal;
  const currentPath = route?.page === 'game-wiki' ? (route.rest || '') : '';

  return (
    <AnimCtx.Provider value={anim}>
      <SuffixCtx.Provider value={false}>
        <div style={{
          display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
          '--candy-depth-nav': 'calc(var(--candy-depth) * 0.85)',
        }}>
          <div style={{
            flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
            display: 'flex', flexDirection: 'column', gap: GAP, padding: '8px 8px 0',
          }}>
            {tree.games == null && <div style={MUTED}>…</div>}
            {tree.games != null && tree.games.length === 0 && <div style={MUTED}>no games</div>}
            {(tree.games || []).map((g) => {
              const open = tree.isOpen(g.vaultPath);
              const entry = tree.childrenOf(g.vaultPath);
              const mounted = open || !!entry;
              const count = entry?.nodes?.length || 0;
              return (
                <div key={g.vaultPath} style={{ display: 'flex', flexDirection: 'column' }}>
                  <CandyHeader label={g.name} open={open} onToggle={() => tree.toggle(g.vaultPath)} accent={accent}/>
                  <Collapsible open={open} count={count}>
                    {mounted && <TreeBody open={open} animateOnMount={false} node={g}
                      tree={tree} accent={accent} currentPath={currentPath}/>}
                  </Collapsible>
                </div>
              );
            })}
            <div aria-hidden style={{ flexShrink: 0, height: 9 }}/>
          </div>
        </div>
      </SuffixCtx.Provider>
    </AnimCtx.Provider>
  );
}

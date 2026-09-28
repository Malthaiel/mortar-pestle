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
import { useContextMenu } from '../../context-menu/useContextMenu.js';
import { IconBrush } from '../icons.jsx';
import {
  AnimCtx, SuffixCtx, REVEAL, MUTED, GAP, TOOLBAR_BAND,
  CandyHeader, TreeRow, TreeChildren, Collapsible, StaggerChild,
} from './treeKit.jsx';
import TreeToolbar from './TreeToolbar.jsx';
import { searchTree } from './treeSearch.js';
import { useTreeIcons } from './treeIcons.jsx';
import TreeIconPicker from './TreeIconPicker.jsx';

// A folder's children, staggered in once the group has "entered" (a deferred rAF
// flag so the first frame is hidden → it transitions instead of snapping). Top-level
// folders pass animateOnMount=false so a page load doesn't cascade every group.
function NodeBody({ node, controller, accent, icons, open, animateOnMount = true }) {
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
      <TreeNode node={child} controller={controller} accent={accent} icons={icons}/>
    </StaggerChild>
  ));
  return <TreeChildren>{inner}</TreeChildren>;
}

function TreeNode({ node, controller, accent, icons, topLevel = false }) {
  // A surface's own right-click wins; with none, the row's icon picker takes it.
  const onContextMenu = node.onContextMenu || (icons ? (e) => icons.open(e, node.id) : undefined);
  // A node that ships its own leadIcon (a favicon, a count dot) keeps it.
  const leadIcon = node.leadIcon ?? icons?.leadIcon(node.id);
  // In-place rename swap (SP3 Broadcast inline-rename primitive): a node in
  // rename mode renders its own pill instead of the row/header. Absent for
  // every existing surface.
  if (node.renaming && node.renderRename) {
    return node.renderRename();
  }
  if (node.isFolder) {
    const open = controller.isOpen(node.id);
    const count = (node.children || []).length;
    const mounted = open || count > 0; // keep body for the collapse cascade
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <CandyHeader label={node.label} open={open} onToggle={() => controller.toggle(node)}
          accent={accent} onContextMenu={onContextMenu}
          leadIcon={leadIcon} trailing={node.trailing}
          onActivate={node.onActivate} activeFill={node.activeFill}
          onDoubleClick={node.onDoubleClick}
          onMouseEnter={node.onMouseEnter} onMouseLeave={node.onMouseLeave}/>
        <Collapsible open={open} count={count}>
          {mounted && <NodeBody node={node} controller={controller} accent={accent} icons={icons}
            open={open} animateOnMount={!topLevel}/>}
        </Collapsible>
      </div>
    );
  }
  return (
    <TreeRow label={node.label} selected={!!node.active} accent={accent}
      onClick={node.onActivate} onContextMenu={onContextMenu}
      suffix={node.suffix} leadIcon={leadIcon} trailing={node.trailing}
      onDoubleClick={node.onDoubleClick}
      onMouseEnter={node.onMouseEnter} onMouseLeave={node.onMouseLeave}/>
  );
}

// `search` (optional) = { value, onChange, onKeyDown?, inputRef?, placeholder?,
// match? }: the surface owns the toolbar search instead of the shell (the
// Settings tree, whose field searches every setting). `match(node)` picks the
// rows to keep; without it rows are kept by name as usual.
export default function TreeSidebar({ nodes, controller, buttons, accent, showSuffix = false, toolbarExtra, iconScope, search }) {
  const { settings } = useSettings();
  // Right-click icons. `iconScope` (e.g. 'docs:tree') namespaces the store and
  // turns the feature on; omitted → nothing changes for that surface.
  const store = useTreeIcons(iconScope);
  const { openContextMenu } = useContextMenu();
  const [picker, setPicker] = useState(null);
  const icons = iconScope ? {
    leadIcon: store.leadIcon,
    // A one-item menu, not the picker straight away: right-click has to read the
    // same everywhere, and openContextMenu is also what marks the event handled —
    // opening the picker off the raw event let the app's global right-click fire
    // its own menu on top of it.
    open: (e, id) => openContextMenu(e, [{ label: 'Change Icon', icon: IconBrush,
      onClick: () => setPicker({ at: { x: e.clientX, y: e.clientY }, key: id }) }], { accent }),
  } : null;
  // Reuse the vault tree's cascade-timing preset so every sidebar animates alike.
  const anim = REVEAL[settings.vaultTreeReveal] || REVEAL.normal;
  // Scroll position is remembered app-wide by util/scrollMemory.js — delegated,
  // so this shell (and every consumer of it) needs no prop and no ref.

  // Toolbar search: the tree shrinks to matching rows + the folders holding
  // them (forced open). The toolbar keeps the real controller.
  const [ownQuery, setOwnQuery] = useState('');
  const query = search ? search.value : ownQuery;
  const found = query.trim() && searchTree(nodes, query, { id: (n) => n.id, text: (n) => n.label, kids: (n) => n.children, match: search?.match });
  const prune = (list) => (list || []).filter((n) => found.keep.has(n.id))
    .map((n) => (found.open.has(n.id) ? { ...n, children: prune(n.children) } : n));
  const shownNodes = found ? prune(nodes) : nodes;
  const treeController = found ? { ...controller, isOpen: (id) => found.open.has(id) || controller.isOpen(id) } : controller;

  return (
    <AnimCtx.Provider value={anim}>
    <SuffixCtx.Provider value={showSuffix}>
      <div style={{
        display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
        '--candy-depth-nav': 'calc(var(--candy-depth) * 0.85)',
      }}>
        {/* Pinned toolbar in the NON-scrolling header band — rides the sidebar's
            circuit texture; rows scroll in the box below. TOOLBAR_BAND pads it so the
            toolbar's painted gap above == its gap below == the tree row gap. */}
        <div style={{ flexShrink: 0, padding: TOOLBAR_BAND }}>
          <TreeToolbar buttons={buttons} controller={controller} accent={accent} extra={toolbarExtra}
            search={search || { value: ownQuery, onChange: setOwnQuery }}/>
        </div>
        {/* Scrolling tree body — the only scroller. overflowX hidden keeps long
            names ellipsizing (the min-width:0 chain). */}
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
          display: 'flex', flexDirection: 'column', gap: GAP, padding: '0 8px',
        }}>
          {(shownNodes || []).map((node) => (
            <TreeNode key={node.id} node={node} controller={treeController} accent={accent} icons={icons} topLevel/>
          ))}
          {/* Bottom dock clearance — an in-flow spacer that rides the scroll so the
              last row always clears the flush bottom dock. */}
          <div aria-hidden style={{ flexShrink: 0, height: 9 }}/>
        </div>
        {picker && (
          <TreeIconPicker at={picker.at} current={store.nameOf(picker.key)} accent={accent}
            onPick={(name) => { store.set(picker.key, name); setPicker(null); }}
            onClose={() => setPicker(null)}/>
        )}
      </div>
    </SuffixCtx.Provider>
    </AnimCtx.Provider>
  );
}

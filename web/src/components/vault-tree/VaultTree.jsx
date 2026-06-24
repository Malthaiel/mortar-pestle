// Vault File Tree — the recursive, Obsidian-style sidebar (the ONLY vault nav).
// The candy-pill primitives (CandyHeader / TreeRow / Collapsible / StaggerChild /
// TreeChildren + the AnimCtx/SuffixCtx contexts + sizing consts) now live in the
// shared treeKit.jsx so every module sidebar renders byte-identically; this file
// keeps the VAULT-SPECIFIC renderer: lazy disk children, pinned virtual leaves,
// section roots, the file-op context menu + modals, and a controller it hands the
// shared config-driven TreeToolbar.
//
// Headers/files are single canonical <button class="candy-btn"> — the IMMOVABLE
// base is the hit target and .candy-face stays pointer-events:none, so a tap toggles
// instantly. Reveal/collapse slides via <Collapsible>; children cascade via
// <StaggerChild>. Timing comes from Settings → Animations → Vault tree, flowed down
// via AnimCtx; suffixes ("/" + ".md") via SuffixCtx.

import { useState, useEffect } from 'react';
import { navigate } from '../../router.js';
import { sharedEvents } from '../../module-sdk/index.js';
import { useContextMenu } from '../../context-menu/useContextMenu.js';
import { buildFileItemMenu } from '../../context-menu/defaultMenus.js';
import { useSettings } from '../../hooks/useSettings.js';
import { writeSectionPage } from '../../hooks/useSectionMemory.js';
import { useVaultTree, sortNodes } from './useVaultTree.js';
import {
  AnimCtx, SuffixCtx, REVEAL, GAP, MUTED,
  CandyHeader, TreeRow, TreeChildren, Collapsible, StaggerChild,
} from './treeKit.jsx';
import TreeToolbar from './TreeToolbar.jsx';
import { openInFiles } from './revealInFiles.js';
import NameInputModal from './NameInputModal.jsx';
import ConfirmModal from '../ui/ConfirmModal.jsx';

// The vault's six Obsidian-style sort modes (mode → menu label). sortNodes (in
// useVaultTree.js) understands these; the controller hands them to TreeToolbar.
const VAULT_SORT_MODES = [
  ['name-asc', 'File name (A → Z)'],
  ['name-desc', 'File name (Z → A)'],
  ['mtime-desc', 'Modified time (new → old)'],
  ['mtime-asc', 'Modified time (old → new)'],
  ['created-desc', 'Created time (new → old)'],
  ['created-asc', 'Created time (old → new)'],
];

function norm(s) { return (s || '').replace(/\.md$/, ''); }
function baseName(vp) { return (vp || '').split('/').pop().replace(/\.md$/, ''); }

// Renders a folder's children (loading / empty / staggered list), wrapped in the
// indent guide. `open` (gated on a deferred `entered` flag) drives the cascade.
function TreeBody({ node, tree, sectionMeta, accent, currentPage, openMenu, open, animateOnMount = true }) {
  const [entered, setEntered] = useState(!animateOnMount);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const shown = entered && open;

  // Pinned virtual leaves (section root only) — e.g. Infrastructure's "Update
  // Queue", which opens its interactive view at its own /vault route, not /page/.
  const pins = (node.depth < 0 && sectionMeta?.pins) ? sectionMeta.pins : [];
  const curHash = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
  const pinActive = (p) => curHash === p.hash || curHash === p.hash + '/';

  const entry = tree.childrenOf(node.vaultPath);
  const diskNodes = sortNodes(entry?.nodes || [], tree.sortMode);
  const loading = !entry || entry.loading;
  const items = [
    ...pins.map((p) => ({ kind: 'pin', pin: p, key: 'pin:' + p.hash })),
    ...diskNodes.map((child) => ({ kind: 'node', node: child, key: child.vaultPath })),
  ];
  const n = items.length;

  let inner;
  if (loading && pins.length === 0) inner = <div style={MUTED}>…</div>;
  else if (n === 0) inner = <div style={MUTED}>empty</div>;
  else inner = items.map((it, i) => (
    <StaggerChild key={it.key} index={i} count={n} open={shown}>
      {it.kind === 'pin'
        ? <TreeRow node={{ title: it.pin.label }} selected={pinActive(it.pin)} accent={accent} noSuffix onClick={() => navigate(it.pin.hash)}/>
        : <TreeNode node={it.node} tree={tree} sectionMeta={sectionMeta}
            accent={accent} currentPage={currentPage} openMenu={openMenu}/>}
    </StaggerChild>
  ));
  return <TreeChildren>{inner}</TreeChildren>;
}

function TreeNode({ node, tree, sectionMeta, accent, currentPage, openMenu }) {
  const onContextMenu = (e) => openMenu(e, node, sectionMeta);

  // Every node is a pill chip; folders recurse when open. Header actions all live
  // in the right-click menu.
  if (node.isFolder) {
    const open = tree.isOpen(node.vaultPath);
    const entry = tree.childrenOf(node.vaultPath);
    const mounted = open || !!entry; // keep body for collapse cascade
    const count = entry?.nodes?.length || 0;
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <CandyHeader label={node.name} open={open} onToggle={() => tree.toggle(node)}
          accent={accent} onContextMenu={onContextMenu}/>
        <Collapsible open={open} count={count}>
          {mounted && <TreeBody open={open} node={node} tree={tree} sectionMeta={sectionMeta}
            accent={accent} currentPage={currentPage} openMenu={openMenu}/>}
        </Collapsible>
      </div>
    );
  }

  // File → pill; opens in the reader.
  const selected = !!currentPage && norm(currentPage) === norm(node.vaultPath);
  return <TreeRow node={node} selected={selected} accent={accent} onClick={() => navigate(node.href)} onContextMenu={onContextMenu}/>;
}

export default function VaultTree({ sections, route, accent }) {
  const tree = useVaultTree(route);
  const { openContextMenu } = useContextMenu();
  const { settings } = useSettings();
  const anim = REVEAL[settings.vaultTreeReveal] || REVEAL.normal;
  const showSuffix = !!settings.vaultTreeSuffix;
  const currentPage = route?.page === 'page' ? route.sub : null;
  const [modal, setModal] = useState(null);

  // Record the open vault note so bare /vault (VaultLanding) can restore it.
  useEffect(() => {
    if (currentPage && (currentPage.startsWith('Knowledge/') || currentPage.startsWith('Infrastructure/'))) {
      writeSectionPage('vault', currentPage);
    }
  }, [currentPage]);

  const openMenu = (e, node, sectionMeta) => {
    const isRoot = node.isFolder && node.depth < 0; // a section root
    // Knowledge/Infrastructure are protected (structural); user-created root
    // folders (deletable) behave like normal folders — full create/rename/delete.
    const isProtectedRoot = isRoot && !sectionMeta?.deletable;
    const canCreate = node.isFolder && !isProtectedRoot;
    const isDomain = node.isFolder && node.depth === 0 && sectionMeta?.gearDomains;
    const ops = {
      onNewNote:     canCreate ? () => setModal({ kind: 'new-note',   node }) : undefined,
      onNewFolder:   canCreate ? () => setModal({ kind: 'new-folder', node }) : undefined,
      onNewDomain:   (isRoot && sectionMeta?.add === 'domain') ? () => sharedEvents.emit('domain-builder:open', {}) : undefined,
      onReconfigure: isDomain ? () => sharedEvents.emit('domain-builder:open', { reopen: { name: node.name } }) : undefined,
      onRename:      isProtectedRoot ? undefined : () => setModal({ kind: 'rename', node }),
      onDelete:      isProtectedRoot ? undefined : () => setModal({ kind: 'delete', node }),
    };
    openContextMenu(e, buildFileItemMenu({
      vaultPath: node.vaultPath,
      isFolder: node.isFolder,
      href: node.isFolder ? null : node.href,
      ops,
    }), { accent });
  };

  // Controller + button config handed to the shared, config-driven TreeToolbar.
  // The vault shows all six EXCEPT Reveal-in-files for now (flipped on once the
  // open_path backend lands). Reveal-current = re-expand ancestors then scroll the
  // selected row (tagged data-current-file) into view after the cascade settles.
  const rootPaths = (sections || []).map((s) => s.section);
  const controller = {
    isOpen: tree.isOpen,
    toggle: tree.toggle,
    sortMode: tree.sortMode,
    setSortMode: tree.setSortMode,
    sortModes: VAULT_SORT_MODES,
    anyExpanded: tree.anyExpanded,
    expandAll: () => tree.expandAll(rootPaths),
    collapseAll: tree.collapseAll,
    canReveal: !!currentPage,
    revealCurrent: () => {
      if (!currentPage) return;
      tree.revealPath(currentPage);
      setTimeout(() => {
        const el = document.querySelector('[data-current-file="true"]');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 280);
    },
  };
  const buttons = {
    new:           { show: true, title: 'New note',   onClick: () => setModal({ kind: 'new-note',   node: { vaultPath: '', name: 'vault root' } }) },
    newFolder:     { show: true, title: 'New folder', onClick: () => setModal({ kind: 'new-folder', node: { vaultPath: '', name: 'vault root' } }) },
    sort:          { show: true },
    collapse:      { show: true },
    revealCurrent: { show: true, title: 'Reveal current file' },
    // 6th button: open the host file manager INTO the content vault root. '.' →
    // backend resolves against vault_root() (no hardcoded absolute path).
    revealInFiles: { show: true, title: 'Reveal in files', onClick: () => openInFiles('.') },
  };

  return (
    <AnimCtx.Provider value={anim}>
      <SuffixCtx.Provider value={showSuffix}>
      <div style={{
        display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
        '--candy-depth-nav': 'calc(var(--candy-depth) * 0.85)',
      }}>
        {/* Pinned file-tree toolbar in the NON-scrolling header band ABOVE the
            scroll body — rides the sidebar's circuit texture; rows scroll below.
            Bottom pad = GAP so the buttons' candy slab clears the first section. */}
        <div style={{ flexShrink: 0, padding: `8px 8px ${GAP}` }}>
          <TreeToolbar buttons={buttons} controller={controller} accent={accent}/>
        </div>

        {/* Scrolling tree body — the only scroller. */}
        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
          display: 'flex', flexDirection: 'column', gap: GAP, padding: '0 8px',
        }}>
        {(sections || []).map((s) => {
          const sectionNode = { vaultPath: s.section, section: s.section, rel: '', depth: -1, isFolder: true, name: s.label };
          const open = tree.isOpen(s.section);
          const entry = tree.childrenOf(s.section);
          const mounted = open || !!entry;
          const count = entry?.nodes?.length || 0;
          return (
            <div key={s.key} style={{ display: 'flex', flexDirection: 'column' }}>
              <CandyHeader label={s.label} open={open} onToggle={() => tree.toggle(sectionNode)}
                accent={accent} onContextMenu={(e) => openMenu(e, sectionNode, s)}/>
              <Collapsible open={open} count={count}>
                {mounted && <TreeBody open={open} animateOnMount={false} node={sectionNode} tree={tree}
                  sectionMeta={s} accent={accent} currentPage={currentPage} openMenu={openMenu}/>}
              </Collapsible>
            </div>
          );
        })}

        {/* Root-level files (e.g. CLAUDE.md) — flat leaves below the sections. */}
        {sortNodes(tree.rootFiles || [], tree.sortMode).map((f) => (
          <TreeRow key={f.vaultPath} node={f}
            selected={!!currentPage && norm(currentPage) === norm(f.vaultPath)}
            accent={accent} onClick={() => navigate(f.href)}
            onContextMenu={(e) => openMenu(e, f, null)}/>
        ))}

        {/* Bottom dock clearance — an in-flow spacer that rides the scroll so the
            last row always clears the flush bottom dock. */}
        <div aria-hidden style={{ flexShrink: 0, height: 9 }}/>
        </div>

        {modal && modal.kind === 'new-note' && (
          <NameInputModal open title={`New note in ${modal.node.name}`} label="Note name" placeholder="New note" confirmLabel="Create"
            onCancel={() => setModal(null)}
            onSubmit={(name) => { setModal(null); tree.createNote(modal.node.vaultPath, name); }}/>
        )}
        {modal && modal.kind === 'new-folder' && (
          <NameInputModal open title={`New folder in ${modal.node.name}`} label="Folder name" placeholder="New folder" confirmLabel="Create"
            onCancel={() => setModal(null)}
            onSubmit={(name) => { setModal(null); tree.createFolder(modal.node.vaultPath, name); }}/>
        )}
        {modal && modal.kind === 'rename' && (
          <NameInputModal open title={`Rename ${modal.node.name}`} label="New name" confirmLabel="Rename" initialValue={baseName(modal.node.vaultPath)}
            onCancel={() => setModal(null)}
            onSubmit={(name) => { setModal(null); tree.renameNode(modal.node, name); }}/>
        )}
        {modal && modal.kind === 'delete' && (
          <ConfirmModal open title={`Delete ${modal.node.name}?`}
            message={modal.node.isFolder
              ? 'This permanently deletes the folder and everything inside it. This cannot be undone.'
              : 'This permanently deletes this note. This cannot be undone.'}
            confirmLabel="Delete" cancelLabel="Cancel"
            onCancel={() => setModal(null)}
            onConfirm={() => { setModal(null); tree.removeNode(modal.node); }}/>
        )}
      </div>
      </SuffixCtx.Provider>
    </AnimCtx.Provider>
  );
}

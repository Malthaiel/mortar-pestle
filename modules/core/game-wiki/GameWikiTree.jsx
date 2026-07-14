// Game Wiki sidebar tree — the games tree (top-level = games, expand into each
// game's raw folder structure). Renders with the shared treeKit candy-pill
// primitives so it's pixel-identical to the vault tree, backed by the lazy
// useGameWikiTree hook. The gamewiki vault is read-only reference EXCEPT the
// Deadlock/Coaching/Scrim bundle — scrims are user content, so scrim leaves +
// the Scrim folder get a right-click context menu (Rename / Delete whole bundle,
// New Scrim). Every other node stays menu-less.

import { useState, useEffect } from 'react';
import { navigate } from '@host/router.js';
import { api, invoke } from '@host/api.js';
import { useSettings } from '@host/hooks/useSettings.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { buildFileItemMenu } from '@host/context-menu/defaultMenus.js';
import NameInputModal from '@host/components/vault-tree/NameInputModal.jsx';
import ConfirmModal from '@host/components/ui/ConfirmModal.jsx';
import { IconPlus, IconFolder, IconLink } from '@host/components/icons.jsx';
import {
  AnimCtx, SuffixCtx, REVEAL, GAP, MUTED,
  CandyHeader, TreeRow, TreeChildren, Collapsible, StaggerChild,
} from '@host/components/vault-tree/treeKit.jsx';
import { useGameWikiTree } from './useGameWikiTree.js';
import { newScrimContent } from './scrimSchema.js';
import NewScrimModal from './NewScrimModal.jsx';

const SCRIM_BASE = 'Deadlock/Coaching/Scrim';

// A scrim "bundle" is NOT a folder — it's the `.md` plus every sibling sidecar in
// SCRIM_BASE keyed by the scrim basename. Per-match sidecars look like
// `.<prefix>.<base> — Match <n>.json` (matchdata/comms/autoclass/tfcomms); scrim-level
// sidecars look like `.<kind>.<base>.json` (vodcomms/vodreport/vodfeedback/vodnotes/
// vodnorm). Rename/delete the whole set by listing SCRIM_BASE and matching the
// base precisely (a bare `includes(base)` would over-match a shorter base against a
// longer sibling's sidecars). No new Rust — reuses vault_rename_path /
// vault_delete_file via api.renamePath / api.deleteFile.
function bundleMatcher(base) {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\.\\w+\\.${esc}( — Match \\d+)?\\.json$`);
}
async function listScrimBundle(base) {
  // vault_list_folder_raw lists ALL entries incl dotfiles (vault_get_folder hides
  // dotfiles + only returns .md, so it can't see the .json sidecars).
  const res = await api.listFolderRaw(SCRIM_BASE, 'gamewiki');
  const names = res?.files || [];
  const re = bundleMatcher(base);
  return names.filter((n) => n === `${base}.md` || re.test(n));
}
async function renameScrimBundle(oldBase, newBase) {
  const files = await listScrimBundle(oldBase);
  await Promise.all(files.map((n) => {
    const to = n === `${oldBase}.md` ? `${newBase}.md` : n.replace(oldBase, newBase);
    return api.renamePath(`${SCRIM_BASE}/${n}`, `${SCRIM_BASE}/${to}`, 'gamewiki');
  }));
}
async function deleteScrimBundle(base) {
  const files = await listScrimBundle(base);
  await Promise.all(files.map((n) => api.deleteFile(`${SCRIM_BASE}/${n}`, 'gamewiki')));
}

function TreeBody({ node, tree, accent, currentPath, open, openMenu, animateOnMount = true }) {
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
      <TreeNode node={child} tree={tree} accent={accent} currentPath={currentPath} openMenu={openMenu}/>
    </StaggerChild>
  ));
  return <TreeChildren>{inner}</TreeChildren>;
}

function TreeNode({ node, tree, accent, currentPath, openMenu }) {
  if (node.isFolder) {
    const open = tree.isOpen(node.vaultPath);
    const entry = tree.childrenOf(node.vaultPath);
    const mounted = open || !!entry;
    const count = entry?.nodes?.length || 0;
    const isScrimFolder = node.vaultPath === SCRIM_BASE;
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <CandyHeader label={node.name} open={open} accent={accent}
          onToggle={() => tree.toggle(node.vaultPath)}
          onContextMenu={isScrimFolder ? (e) => openMenu(e, node) : undefined}/>
        <Collapsible open={open} count={count}>
          {mounted && <TreeBody open={open} node={node} tree={tree} accent={accent} currentPath={currentPath} openMenu={openMenu}/>}
        </Collapsible>
      </div>
    );
  }
  const selected = currentPath === node.vaultPath;
  const isScrim = node.vaultPath.startsWith(SCRIM_BASE + '/');
  return (
    <TreeRow label={node.name} selected={selected} accent={accent}
      onClick={() => navigate('/game-wiki/' + encodePagePath(node.vaultPath))}
      onContextMenu={isScrim ? (e) => openMenu(e, node) : undefined}/>
  );
}

export default function GameWikiTree({ route, accent }) {
  const tree = useGameWikiTree();
  const { openContextMenu } = useContextMenu();
  const { settings } = useSettings();
  const anim = REVEAL[settings.vaultTreeReveal] || REVEAL.normal;
  const currentPath = route?.page === 'game-wiki' ? (route.rest || '') : '';
  const [modal, setModal] = useState(null);

  const openMenu = (e, node) => {
    if (node.isFolder) {
      if (node.vaultPath === SCRIM_BASE) {
        openContextMenu(e, [
          { label: 'New Scrim', icon: IconPlus, onClick: () => setModal({ kind: 'new-scrim' }) },
          { divider: true },
          { label: 'Reveal in Files', icon: IconFolder, onClick: () => { try { invoke('reveal_in_files', { path: SCRIM_BASE }); } catch {} } },
          { label: 'Copy path', icon: IconLink, onClick: () => { try { navigator.clipboard.writeText(SCRIM_BASE); } catch {} } },
        ], { accent });
      }
      return;
    }
    if (!node.vaultPath.startsWith(SCRIM_BASE + '/')) return;
    const base = node.name;
    openContextMenu(e, buildFileItemMenu({
      vaultPath: node.vaultPath,
      isFolder: false,
      href: '/game-wiki/' + encodePagePath(node.vaultPath),
      ops: {
        onRename: () => setModal({ kind: 'rename', base }),
        onDelete: () => setModal({ kind: 'delete', base }),
      },
    }), { accent });
  };

  const doCreate = async ({ team1, team2 }) => {
    const { base, content } = newScrimContent({ team1, team2 });
    const entry = tree.childrenOf(SCRIM_BASE);
    const existing = new Set((entry?.nodes || []).map((nn) => nn.name));
    let uniq = base;
    if (existing.has(uniq)) { let k = 2; while (existing.has(`${base} (${k})`)) k++; uniq = `${base} (${k})`; }
    const path = `${SCRIM_BASE}/${uniq}.md`;
    try {
      await api.savePage(path, content, 0, 'gamewiki');
      setModal(null);
      await tree.refresh(SCRIM_BASE);
      navigate('/game-wiki/' + encodePagePath(`${SCRIM_BASE}/${uniq}`));
    } catch (e) {
      setModal({ kind: 'new-scrim', err: String(e?.message || e) });
    }
  };

  const doRename = async (oldBase, newName) => {
    const newBase = newName.trim();
    if (!newBase || newBase === oldBase) { setModal(null); return; }
    try {
      await renameScrimBundle(oldBase, newBase);
      await tree.refresh(SCRIM_BASE);
      setModal(null);
      if (currentPath === `${SCRIM_BASE}/${oldBase}`) navigate('/game-wiki/' + encodePagePath(`${SCRIM_BASE}/${newBase}`));
    } catch (e) {
      setModal({ kind: 'rename', base: oldBase, err: String(e?.message || e) });
    }
  };

  const doDelete = async (base) => {
    try {
      await deleteScrimBundle(base);
      await tree.refresh(SCRIM_BASE);
      setModal(null);
      if (currentPath === `${SCRIM_BASE}/${base}`) navigate('/game-wiki');
    } catch (e) {
      setModal({ kind: 'delete', base, err: String(e?.message || e) });
    }
  };

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
                      tree={tree} accent={accent} currentPath={currentPath} openMenu={openMenu}/>}
                  </Collapsible>
                </div>
              );
            })}
            <div aria-hidden style={{ flexShrink: 0, height: 9 }}/>
          </div>

          {modal?.kind === 'new-scrim' && (
            <NewScrimModal open
              error={modal.err}
              onCancel={() => setModal(null)}
              onSubmit={doCreate}/>
          )}
          {modal?.kind === 'rename' && (
            <NameInputModal open title={`Rename ${modal.base}`} label="New name" confirmLabel="Rename" initialValue={modal.base}
              onCancel={() => setModal(null)}
              onSubmit={(name) => doRename(modal.base, name)}/>
          )}
          {modal?.kind === 'delete' && (
            <ConfirmModal open title={`Delete ${modal.base}?`}
              message={modal.err
                ? `Last attempt failed: ${modal.err}`
                : 'Sends the scrim and ALL its sidecars (match data, comms transcripts, VOD report, feedback, notes) to the Recycle Bin.'}
              confirmLabel="Delete" cancelLabel="Cancel"
              onCancel={() => setModal(null)}
              onConfirm={() => doDelete(modal.base)}/>
          )}
        </div>
      </SuffixCtx.Provider>
    </AnimCtx.Provider>
  );
}
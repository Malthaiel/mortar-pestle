// Game Wiki sidebar tree — the games tree (top-level = games, expand into each
// game's raw folder structure). Renders with the shared treeKit candy-pill
// primitives so it's pixel-identical to the vault tree, backed by the lazy
// useGameWikiTree hook.
//
// The gamewiki vault is read-only reference EXCEPT Deadlock/Coaching/Scrim,
// where a scrim can be created, renamed and deleted. Scrim Teardown (2026-07-26):
// a scrim is now a FOLDER AND NOTHING ELSE — the whole per-match shape (match
// groups, report-section leaves, segments leaves, the sidecar listing that fed
// them) came out with the report layer. A scrim folder renders through the same
// generic TreeBody as any other folder, so a fresh one simply reads "empty".
//
// The tree hook + New Scrim modal live in GameWikiRail (the shared composition
// both surfaces mount); this component takes `tree` + `onNewScrim` as props.

import { useState, useEffect } from 'react';
import { navigate } from '@host/router.js';
import { api, invoke } from '@host/api.js';
import { useSettings } from '@host/hooks/useSettings.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import NameInputModal from '@host/components/vault-tree/NameInputModal.jsx';
import ConfirmModal from '@host/components/ui/ConfirmModal.jsx';
import { IconPlus, IconFolder, IconLink, IconFile, IconX, IconSettings } from '@host/components/icons.jsx';
import { CircleChip } from '@host/components/ui/Button.jsx';
import CoachPopup from './CoachPopup.jsx';
import {
  AnimCtx, SuffixCtx, REVEAL, GAP, MUTED,
  CandyHeader, TreeRow, TreeChildren, Collapsible, StaggerChild,
} from '@host/components/vault-tree/treeKit.jsx';

// Re-exported (it now lives in scrimSchema.js, which CoachPopup can import
// without cycling back through this file) so existing importers are unchanged.
export { SCRIM_BASE } from './scrimSchema.js';
import { SCRIM_BASE } from './scrimSchema.js';

// "<base>" when vp is a scrim folder (direct subfolder of SCRIM_BASE), else null.
function scrimBaseOf(vp) {
  if (!vp || !vp.startsWith(SCRIM_BASE + '/')) return null;
  const rest = vp.slice(SCRIM_BASE.length + 1);
  return rest && !rest.includes('/') ? rest : null;
}

// "<scrim>/Match N" → { scrim, match }. `Match N` folders are created by
// coach.py (or the scrim gear) and are the unit the coaching pipeline runs over.
function matchOf(vp) {
  if (!vp || !vp.startsWith(SCRIM_BASE + '/')) return null;
  const parts = vp.slice(SCRIM_BASE.length + 1).split('/');
  if (parts.length !== 2) return null;
  const m = /^Match (\d+)$/.exec(parts[1]);
  return m ? { scrim: parts[0], match: parseInt(m[1], 10) } : null;
}

// Which folders carry the coaching gear: a scrim (creates a match folder) and
// each of its Match folders (runs the pipeline).
function gearOf(vp) {
  const scrim = scrimBaseOf(vp);
  if (scrim) return { kind: 'scrim', scrim };
  const m = matchOf(vp);
  return m ? { kind: 'match', ...m } : null;
}

function TreeBody({ node, tree, accent, currentPath, open, openMenu, nav, onGear, animateOnMount = true }) {
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
  else {
    inner = nodes.map((c, i) => (
      <StaggerChild key={c.vaultPath} index={i} count={n} open={shown}>
        <TreeNode node={c} tree={tree} accent={accent}
          currentPath={currentPath} openMenu={openMenu} nav={nav} onGear={onGear}/>
      </StaggerChild>
    ));
  }
  return <TreeChildren>{inner}</TreeChildren>;
}

function TreeNode({ node, tree, accent, currentPath, openMenu, nav, onGear }) {
  if (node.isFolder) {
    const open = tree.isOpen(node.vaultPath);
    const entry = tree.childrenOf(node.vaultPath);
    const mounted = open || !!entry;
    const count = entry?.nodes?.length || 0;
    const hasMenu = node.vaultPath === SCRIM_BASE || !!scrimBaseOf(node.vaultPath);
    const gear = gearOf(node.vaultPath);
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {/* The gear is a SIBLING of the row, never CandyHeader's `trailing`:
            CandyHeader is a <button>, and a button nested in a button is invalid
            and never receives its own click. The row is already
            width:fit-content, so it sits flush beside it. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <CandyHeader label={node.name} open={open} accent={accent}
            onToggle={() => tree.toggle(node.vaultPath)}
            onContextMenu={hasMenu ? (e) => openMenu(e, node) : undefined}/>
          {gear && (
            <CircleChip size={22} title="Coaching notes" onClick={() => onGear?.(gear)}>
              <IconSettings size={13}/>
            </CircleChip>
          )}
        </div>
        <Collapsible open={open} count={count}>
          {mounted && <TreeBody open={open} node={node} tree={tree} accent={accent}
            currentPath={currentPath} openMenu={openMenu} nav={nav} onGear={onGear}/>}
        </Collapsible>
      </div>
    );
  }
  const selected = currentPath === node.vaultPath;
  return (
    <TreeRow label={node.name} selected={selected} accent={accent}
      onClick={() => nav('/game-wiki/' + encodePagePath(node.vaultPath))}/>
  );
}

export default function GameWikiTree({ route, accent, tree, nav = navigate, onNewScrim }) {
  const { openContextMenu } = useContextMenu();
  const { settings } = useSettings();
  const anim = REVEAL[settings.vaultTreeReveal] || REVEAL.normal;
  const currentPath = route?.page === 'game-wiki' ? (route.rest || '') : '';
  const [modal, setModal] = useState(null);
  // Which gear was clicked ({ kind:'scrim'|'match', scrim, match }), or null.
  const [coach, setCoach] = useState(null);

  // Open a finished match's notes. The filename is coach.py's deliverable
  // convention; navigating to the folder would land on an empty-folder blurb.
  const openNotes = (scrim, n) => nav(
    '/game-wiki/' + encodePagePath(
      `${SCRIM_BASE}/${scrim}/Match ${n}/Deadlock Coaching — ${scrim} Match ${n}`,
    ),
  );

  const openMenu = (e, node) => {
    if (node.vaultPath === SCRIM_BASE) {
      openContextMenu(e, [
        { label: 'New Scrim', icon: IconPlus, onClick: () => onNewScrim?.() },
        { divider: true },
        // reveal_in_files excludes the gamewiki root — coaching_reveal_path is the
        // gamewiki-rooted arm (also below, for scrim folders).
        { label: 'Reveal in Files', icon: IconFolder, onClick: () => { invoke('coaching_reveal_path', { path: SCRIM_BASE }).catch(() => {}); } },
        { label: 'Copy path', icon: IconLink, onClick: () => { try { navigator.clipboard.writeText(SCRIM_BASE); } catch {} } },
      ], { accent });
      return;
    }
    const base = scrimBaseOf(node.vaultPath);
    if (!base) return;
    openContextMenu(e, [
      { label: 'Rename…', icon: IconFile, onClick: () => setModal({ kind: 'rename', base }) },
      { label: 'Delete', icon: IconX, danger: true, onClick: () => setModal({ kind: 'delete', base }) },
      { divider: true },
      { label: 'Reveal in Files', icon: IconFolder, onClick: () => { invoke('coaching_reveal_path', { path: node.vaultPath }).catch(() => {}); } },
      { label: 'Copy path', icon: IconLink, onClick: () => { try { navigator.clipboard.writeText(node.vaultPath); } catch {} } },
    ], { accent });
  };

  // Folder rename. Nothing inside a scrim folder holds a path back to it any
  // more, so this is the folder move and nothing else.
  const doRename = async (oldBase, newName) => {
    const newBase = newName.trim();
    if (!newBase || newBase === oldBase) { setModal(null); return; }
    const oldFolder = `${SCRIM_BASE}/${oldBase}`;
    const newFolder = `${SCRIM_BASE}/${newBase}`;
    try {
      await api.renamePath(oldFolder, newFolder, 'gamewiki');
      await tree.refresh(SCRIM_BASE);
      setModal(null);
      if (currentPath === oldFolder || currentPath.startsWith(oldFolder + '/')) {
        nav('/game-wiki/' + encodePagePath(newFolder + currentPath.slice(oldFolder.length)));
      }
    } catch (e) {
      setModal({ kind: 'rename', base: oldBase, err: String(e?.message || e) });
    }
  };

  const doDelete = async (base) => {
    const folder = `${SCRIM_BASE}/${base}`;
    try {
      await api.deleteFolder(folder, 'gamewiki');
      await tree.refresh(SCRIM_BASE);
      setModal(null);
      if (currentPath === folder || currentPath.startsWith(folder + '/')) nav('/game-wiki');
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
            display: 'flex', flexDirection: 'column', gap: GAP, padding: '0 8px',
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
                      tree={tree} accent={accent} currentPath={currentPath}
                      openMenu={openMenu} nav={nav} onGear={setCoach}/>}
                  </Collapsible>
                </div>
              );
            })}
            <div aria-hidden style={{ flexShrink: 0, height: 9 }}/>
          </div>

          {coach && (
            <CoachPopup target={coach} accent={accent}
              onClose={() => setCoach(null)}
              onFolderChange={() => tree.refresh(`${SCRIM_BASE}/${coach.scrim}`)}
              onOpenNotes={openNotes}/>
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
                : 'Sends the whole scrim folder and everything in it to the Recycle Bin as one item.'}
              confirmLabel="Delete" cancelLabel="Cancel"
              onCancel={() => setModal(null)}
              onConfirm={() => doDelete(modal.base)}/>
          )}
        </div>
      </SuffixCtx.Provider>
    </AnimCtx.Provider>
  );
}

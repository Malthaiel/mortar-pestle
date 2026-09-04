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
import { IconPlus, IconFolder, IconLink, IconFile, IconX, IconSettings, IconBrush } from '@host/components/icons.jsx';
import { CircleChip } from '@host/components/ui/Button.jsx';
import CoachPopup from './CoachPopup.jsx';
import {
  AnimCtx, SuffixCtx, REVEAL, GAP, MUTED, NAV_H,
  CandyHeader, TreeRow, TreeChildren, Collapsible, StaggerChild,
} from '@host/components/vault-tree/treeKit.jsx';
import { useTreeIcons } from '@host/components/vault-tree/treeIcons.jsx';
import TreeIconPicker from '@host/components/vault-tree/TreeIconPicker.jsx';

// Re-exported (it now lives in scrimSchema.js, which CoachPopup can import
// without cycling back through this file) so existing importers are unchanged.
export { SCRIM_BASE, VOD_BASE } from './scrimSchema.js';
import { SCRIM_BASE, VOD_BASE, newVodName } from './scrimSchema.js';
import { newVodScaffold, vodFile } from './vodNotes.js';

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

// A Personal VOD note file (a direct .md child of VOD_BASE) — the only leaf in
// this tree with a menu of its own, because it is the only file the app writes.
function vodOf(vp) {
  if (!vp || !vp.startsWith(VOD_BASE + '/')) return null;
  const rest = vp.slice(VOD_BASE.length + 1);
  return rest && !rest.includes('/') ? rest : null;
}

// Which folders carry the coaching gear: a scrim (creates a match folder) and
// each of its Match folders (runs the pipeline).
function gearOf(vp) {
  const scrim = scrimBaseOf(vp);
  if (scrim) return { kind: 'scrim', scrim };
  const m = matchOf(vp);
  return m ? { kind: 'match', ...m } : null;
}

const matchFolder = (scrim, n) => `${SCRIM_BASE}/${scrim}/Match ${n}`;

function TreeBody({ node, tree, accent, currentPath, open, openMenu, nav, onGear, icons, animateOnMount = true }) {
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
  if (loading && n === 0) inner = <div style={MUTED}>loading</div>;
  else if (n === 0) inner = <div style={MUTED}>empty</div>;
  else {
    inner = nodes.map((c, i) => (
      <StaggerChild key={c.vaultPath} index={i} count={n} open={shown}>
        <TreeNode node={c} tree={tree} accent={accent}
          currentPath={currentPath} openMenu={openMenu} nav={nav} onGear={onGear} icons={icons}/>
      </StaggerChild>
    ));
  }
  return <TreeChildren>{inner}</TreeChildren>;
}

function TreeNode({ node, tree, accent, currentPath, openMenu, nav, onGear, icons }) {
  if (node.isFolder) {
    const open = tree.isOpen(node.vaultPath);
    const entry = tree.childrenOf(node.vaultPath);
    const mounted = open || !!entry;
    const count = entry?.nodes?.length || 0;
    // VOD_BASE belongs here for the same reason SCRIM_BASE does: it is the other
    // folder whose menu carries a "New" action. Leaving it out made the whole
    // `node.vaultPath === VOD_BASE` branch in openMenu dead code — the folder fell
    // through to the no-menu path and offered only Change Icon, so there was no
    // way to create a Personal VOD at all (measured 2026-09-04).
    const hasMenu = node.vaultPath === SCRIM_BASE || node.vaultPath === VOD_BASE || !!gearOf(node.vaultPath);
    const gear = gearOf(node.vaultPath);
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {/* The gear is a SIBLING of the row, never CandyHeader's `trailing`:
            CandyHeader is a <button>, and a button nested in a button is invalid
            and never receives its own click. The row is already
            width:fit-content, so it sits flush beside it. */}
        {/* minWidth:0 so the name pill (which caps at maxWidth:100%) yields width
            instead of pushing the gear past the sidebar's overflow-x:hidden edge —
            a long scrim name made its own gear unclickable. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <CandyHeader label={node.name} open={open} accent={accent}
            onToggle={() => tree.toggle(node.vaultPath)} leadIcon={icons.leadIcon(node.vaultPath)}
            onContextMenu={(e) => openMenu(e, node, hasMenu)}/>
          {/* size=NAV_H, not a hand-picked number: it is the same min-height the
              row pill uses, so the two buttons side by side are exactly the same
              height. Buttons in a row match each other's size. */}
          {gear && (
            <CircleChip size={NAV_H} title="Coaching notes" style={{ flexShrink: 0 }} onClick={() => onGear?.(gear)}>
              <IconSettings size={13}/>
            </CircleChip>
          )}
        </div>
        <Collapsible open={open} count={count}>
          {mounted && <TreeBody open={open} node={node} tree={tree} accent={accent}
            currentPath={currentPath} openMenu={openMenu} nav={nav} onGear={onGear} icons={icons}/>}
        </Collapsible>
      </div>
    );
  }
  const selected = currentPath === node.vaultPath;
  return (
    <TreeRow label={node.name} selected={selected} accent={accent}
      leadIcon={icons.leadIcon(node.vaultPath)}
      onContextMenu={(e) => openMenu(e, node, !!vodOf(node.vaultPath))}
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
  // Right-click row icons (shared store + picker with the vault tree).
  const icons = useTreeIcons('gamewiki:tree');
  const [picker, setPicker] = useState(null);

  // The Personal VODs folder is the ONLY way in to "New VOD", and the only thing
  // that used to create it was doCreateVod — which you can't reach without the
  // folder already being there. Scrim never hit this because its folder has
  // existed on disk since the scrim tooling shipped. Ensure it once on mount;
  // createFolder is not idempotent (it throws "Already exists"), so swallow.
  useEffect(() => { api.createFolder(VOD_BASE, 'gamewiki').catch(() => {}); }, []);

  // Open a finished match's notes. The filename is coach.py's deliverable
  // convention; navigating to the folder would land on an empty-folder blurb.
  const openNotes = (scrim, n) => nav(
    '/game-wiki/' + encodePagePath(
      `${SCRIM_BASE}/${scrim}/Match ${n}/Deadlock Coaching — ${scrim} Match ${n}`,
    ),
  );

  const openMenu = (e, node, hasMenu = true) => {
    // Every row can take an icon; only some rows have a menu of their own. With
    // no menu, right-click IS the picker.
    const iconItem = { label: 'Change Icon', icon: IconBrush,
      onClick: () => setPicker({ at: { x: e.clientX, y: e.clientY }, key: node.vaultPath }) };
    // Route even the one-item case through openContextMenu: it marks the event
    // handled and preventDefaults it. Opening the picker straight from the raw
    // event left the app's global right-click free to fire its own menu too, so
    // BOTH appeared at once.
    if (!hasMenu) { openContextMenu(e, [iconItem], { accent }); return; }
    if (node.vaultPath === SCRIM_BASE) {
      openContextMenu(e, [
        { label: 'New Scrim', icon: IconPlus, onClick: () => onNewScrim?.() },
        { divider: true },
        // reveal_in_files excludes the gamewiki root — coaching_reveal_path is the
        // gamewiki-rooted arm (also below, for scrim folders).
        { label: 'Reveal in Files', icon: IconFolder, onClick: () => { invoke('coaching_reveal_path', { path: SCRIM_BASE }).catch(() => {}); } },
        { label: 'Copy Path', icon: IconLink, onClick: () => { try { navigator.clipboard.writeText(SCRIM_BASE); } catch {} } },
        iconItem,
      ], { accent });
      return;
    }
    if (node.vaultPath === VOD_BASE) {
      openContextMenu(e, [
        { label: 'New VOD', icon: IconPlus, onClick: () => setModal({ kind: 'new-vod' }) },
        { divider: true },
        { label: 'Reveal in Files', icon: IconFolder, onClick: () => { invoke('coaching_reveal_path', { path: VOD_BASE }).catch(() => {}); } },
        { label: 'Copy Path', icon: IconLink, onClick: () => { try { navigator.clipboard.writeText(VOD_BASE); } catch {} } },
        iconItem,
      ], { accent });
      return;
    }
    // A VOD note file. Free rename (unlike `Match N`, nothing parses this name)
    // and a delete that is one file, so the Recycle Bin restores it whole.
    const vod = vodOf(node.vaultPath);
    if (vod) {
      openContextMenu(e, [
        { label: 'New VOD', icon: IconPlus, onClick: () => setModal({ kind: 'new-vod' }) },
        { label: 'Rename', icon: IconFile, onClick: () => setModal({ kind: 'rename-vod', vod }) },
        { label: 'Delete', icon: IconX, danger: true, onClick: () => setModal({ kind: 'delete-vod', vod }) },
        { divider: true },
        { label: 'Reveal in Files', icon: IconFolder, onClick: () => { invoke('coaching_reveal_path', { path: node.vaultPath }).catch(() => {}); } },
        { label: 'Copy Path', icon: IconLink, onClick: () => { try { navigator.clipboard.writeText(node.vaultPath); } catch {} } },
        iconItem,
      ], { accent });
      return;
    }
    // A Match folder: its own menu, because the scrim's Delete would take the whole
    // folder with every other match in it — the same word meaning two very different
    // amounts of destruction is exactly the trap worth avoiding here.
    const m = matchOf(node.vaultPath);
    if (m) {
      openContextMenu(e, [
        { label: 'New Match', icon: IconPlus, onClick: () => setCoach({ kind: 'scrim', scrim: m.scrim }) },
        // Renumber, not free rename: `Match N` is what matchOf parses and what coach.py
        // names its deliverable after, so a free-text name would quietly cut the folder
        // off from its own gear and from the notes pipeline.
        { label: 'Change Number', icon: IconFile, onClick: () => setModal({ kind: 'renumber', ...m }) },
        { label: 'Delete Match', icon: IconX, danger: true, onClick: () => setModal({ kind: 'delete-match', ...m }) },
        { divider: true },
        { label: 'Reveal in Files', icon: IconFolder, onClick: () => { invoke('coaching_reveal_path', { path: node.vaultPath }).catch(() => {}); } },
        { label: 'Copy Path', icon: IconLink, onClick: () => { try { navigator.clipboard.writeText(node.vaultPath); } catch {} } },
        iconItem,
      ], { accent });
      return;
    }
    const base = scrimBaseOf(node.vaultPath);
    if (!base) { iconItem.onClick(); return; }
    openContextMenu(e, [
      { label: 'New Match', icon: IconPlus, onClick: () => setCoach({ kind: 'scrim', scrim: base }) },
      { label: 'Rename', icon: IconFile, onClick: () => setModal({ kind: 'rename', base }) },
      { label: 'Delete', icon: IconX, danger: true, onClick: () => setModal({ kind: 'delete', base }) },
      { divider: true },
      { label: 'Reveal in Files', icon: IconFolder, onClick: () => { invoke('coaching_reveal_path', { path: node.vaultPath }).catch(() => {}); } },
      { label: 'Copy Path', icon: IconLink, onClick: () => { try { navigator.clipboard.writeText(node.vaultPath); } catch {} } },
      iconItem,
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

  // Move `Match <old>` to `Match <new>` inside the same scrim. Refuses a non-number and
  // refuses to land on a match that already exists — renamePath would otherwise merge or
  // clobber a folder holding someone's written-out talk.
  const doRenumber = async (scrim, match, raw) => {
    const want = String(raw ?? '').trim();
    if (!/^\d+$/.test(want)) {
      setModal({ kind: 'renumber', scrim, match, err: 'A match is numbered, so this has to be a number — 1, 2, 3' });
      return;
    }
    const n = parseInt(want, 10);
    if (n === match) { setModal(null); return; }
    const taken = (tree.childrenOf(`${SCRIM_BASE}/${scrim}`)?.nodes || [])
      .some((c) => c.name === `Match ${n}`);
    if (taken) {
      setModal({ kind: 'renumber', scrim, match, err: `Match ${n} already exists in this scrim.` });
      return;
    }
    const oldFolder = matchFolder(scrim, match);
    const newFolder = matchFolder(scrim, n);
    try {
      await api.renamePath(oldFolder, newFolder, 'gamewiki');
      await tree.refresh(`${SCRIM_BASE}/${scrim}`);
      setModal(null);
      if (currentPath === oldFolder || currentPath.startsWith(oldFolder + '/')) {
        nav('/game-wiki/' + encodePagePath(newFolder + currentPath.slice(oldFolder.length)));
      }
    } catch (e) {
      setModal({ kind: 'renumber', scrim, match, err: String(e?.message || e) });
    }
  };

  const doDeleteMatch = async (scrim, match) => {
    const folder = matchFolder(scrim, match);
    try {
      await api.deleteFolder(folder, 'gamewiki');
      await tree.refresh(`${SCRIM_BASE}/${scrim}`);
      setModal(null);
      if (currentPath === folder || currentPath.startsWith(folder + '/')) nav('/game-wiki');
    } catch (e) {
      setModal({ kind: 'delete-match', scrim, match, err: String(e?.message || e) });
    }
  };

  // Create one VOD note file. createFolder is NOT idempotent — it throws
  // "Already exists" (measured 2026-09-03), which would abort every VOD after
  // the first — so its failure is swallowed. savePage is the operation that
  // actually has to work, and it reports its own error into the modal.
  const doNewVod = async (label) => {
    const name = newVodName(label);
    const path = `${VOD_BASE}/${name}`;
    try {
      await api.createFolder(VOD_BASE, 'gamewiki').catch(() => {});
      await api.savePage(vodFile(path), newVodScaffold(name), null, 'gamewiki');
      await tree.refresh(VOD_BASE);
      setModal(null);
      nav('/game-wiki/' + encodePagePath(path));
    } catch (e) {
      setModal({ kind: 'new-vod', err: String(e?.message || e) });
    }
  };

  const doRenameVod = async (oldName, raw) => {
    const next = String(raw || '').trim();
    if (!next || next === oldName) { setModal(null); return; }
    const from = `${VOD_BASE}/${oldName}`;
    const to = `${VOD_BASE}/${next}`;
    try {
      await api.renamePath(vodFile(from), vodFile(to), 'gamewiki');
      await tree.refresh(VOD_BASE);
      setModal(null);
      if (currentPath === from) nav('/game-wiki/' + encodePagePath(to));
    } catch (e) {
      setModal({ kind: 'rename-vod', vod: oldName, err: String(e?.message || e) });
    }
  };

  const doDeleteVod = async (name) => {
    const path = `${VOD_BASE}/${name}`;
    try {
      await api.deleteFile(vodFile(path), 'gamewiki');
      await tree.refresh(VOD_BASE);
      setModal(null);
      if (currentPath === path) nav('/game-wiki');
    } catch (e) {
      setModal({ kind: 'delete-vod', vod: name, err: String(e?.message || e) });
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
            {tree.games == null && <div style={MUTED}>loading</div>}
            {tree.games != null && tree.games.length === 0 && <div style={MUTED}>no games</div>}
            {(tree.games || []).map((g) => {
              const open = tree.isOpen(g.vaultPath);
              const entry = tree.childrenOf(g.vaultPath);
              const mounted = open || !!entry;
              const count = entry?.nodes?.length || 0;
              return (
                <div key={g.vaultPath} style={{ display: 'flex', flexDirection: 'column' }}>
                  <CandyHeader label={g.name} open={open} onToggle={() => tree.toggle(g.vaultPath)} accent={accent}
                    leadIcon={icons.leadIcon(g.vaultPath)} onContextMenu={(e) => openMenu(e, g, false)}/>
                  <Collapsible open={open} count={count}>
                    {mounted && <TreeBody open={open} animateOnMount={false} node={g}
                      tree={tree} accent={accent} currentPath={currentPath}
                      openMenu={openMenu} nav={nav} onGear={setCoach} icons={icons}/>}
                  </Collapsible>
                </div>
              );
            })}
            <div aria-hidden style={{ flexShrink: 0, height: 9 }}/>
          </div>

          {picker && (
            <TreeIconPicker at={picker.at} current={icons.nameOf(picker.key)} accent={accent}
              onPick={(name) => { icons.set(picker.key, name); setPicker(null); }}
              onClose={() => setPicker(null)}/>
          )}

          {coach && (
            <CoachPopup target={coach} accent={accent}
              onClose={() => setCoach(null)}
              // Both levels: a new/deleted Match changes the scrim's listing, a deleted
              // scrim changes the root's. Refreshing a folder that no longer exists is a
              // no-op, so one call covers both without branching on what happened.
              onFolderChange={() => { tree.refresh(SCRIM_BASE); tree.refresh(`${SCRIM_BASE}/${coach.scrim}`); }}
              onOpenNotes={openNotes}/>
          )}
          {modal?.kind === 'new-vod' && (
            <NameInputModal open title="New personal VOD" confirmLabel="Create"
              label={modal.err || 'What was this match?'} placeholder="Lash mid"
              onCancel={() => setModal(null)}
              onSubmit={doNewVod}/>
          )}
          {modal?.kind === 'rename-vod' && (
            <NameInputModal open title={`Rename ${modal.vod}`} confirmLabel="Rename" initialValue={modal.vod}
              label={modal.err || 'New name'}
              onCancel={() => setModal(null)}
              onSubmit={(name) => doRenameVod(modal.vod, name)}/>
          )}
          {modal?.kind === 'delete-vod' && (
            <ConfirmModal open title={`Delete ${modal.vod}?`}
              message={modal.err
                ? `Last attempt failed: ${modal.err}`
                : 'Sends this one VOD note file to the Recycle Bin. Every note you dictated during that match goes with it.'}
              confirmLabel="Delete" cancelLabel="Cancel"
              onCancel={() => setModal(null)}
              onConfirm={() => doDeleteVod(modal.vod)}/>
          )}
          {modal?.kind === 'rename' && (
            <NameInputModal open title={`Rename ${modal.base}`} label="New name" confirmLabel="Rename" initialValue={modal.base}
              onCancel={() => setModal(null)}
              onSubmit={(name) => doRename(modal.base, name)}/>
          )}
          {modal?.kind === 'renumber' && (
            <NameInputModal open title={`Match ${modal.match} — change number`}
              label={modal.err || 'New number'} confirmLabel="Change" initialValue={String(modal.match)}
              onCancel={() => setModal(null)}
              onSubmit={(name) => doRenumber(modal.scrim, modal.match, name)}/>
          )}
          {modal?.kind === 'delete-match' && (
            <ConfirmModal open title={`Delete Match ${modal.match}?`}
              message={modal.err
                ? `Last attempt failed: ${modal.err}`
                : `Sends this match's folder — the written-out talk and any notes in it — to the Recycle Bin. The rest of ${modal.scrim} is untouched.`}
              confirmLabel="Delete" cancelLabel="Cancel"
              onCancel={() => setModal(null)}
              onConfirm={() => doDeleteMatch(modal.scrim, modal.match)}/>
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

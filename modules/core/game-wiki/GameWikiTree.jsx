// Game Wiki sidebar tree — the games tree (top-level = games, expand into each
// game's raw folder structure). Renders with the shared treeKit candy-pill
// primitives so it's pixel-identical to the vault tree, backed by the lazy
// useGameWikiTree hook. The gamewiki vault is read-only reference EXCEPT
// Deadlock/Coaching/Scrim — a scrim is a FOLDER (GameWiki Unification 2026-07-16:
// Overview.md + Matches/Match <n>.md + dot-sidecars), so scrim folders get a
// right-click Rename / Delete, Matches/ grows a "+ New Match" trailing row, and
// two VIRTUAL groups (Report/ + Coaching/ — sidecar-driven panes, never real .md)
// are injected per scrim. Every other node stays menu-less.
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
import { IconPlus, IconFolder, IconLink, IconFile, IconX } from '@host/components/icons.jsx';
import {
  AnimCtx, SuffixCtx, REVEAL, GAP, MUTED,
  CandyHeader, TreeRow, TreeChildren, Collapsible, StaggerChild,
} from '@host/components/vault-tree/treeKit.jsx';
import { parseOverview, newMatchContent } from './scrimSchema.js';
import { scrimSidecarPath } from './matchData.js';
import { requestSectionJump } from './sectionJump.js';

export const SCRIM_BASE = 'Deadlock/Coaching/Scrim';

// The virtual scrim sub-views. Ids double as route tails
// (/game-wiki/<scrim>/Report/<id>) — GameWikiPage dispatches on them. Split of
// ScrimViewer's DEFAULT_REPORT_TABS (REPORT_GROUP / COACHING_GROUP); custom tabs a
// generated report publishes beyond these render in the pane's own tab strip.
export const REPORT_VIEWS = [
  { id: 'tldr', label: 'Report' }, { id: 'players', label: 'Player Cards' },
  { id: 'macro', label: 'Macro' }, { id: 'comms', label: 'Comms Grade' },
];
export const COACHING_VIEWS = [
  { id: 'actions', label: 'Action Items' }, { id: 'qa', label: 'Q&A' },
  { id: 'keep', label: 'Keep Doing' }, { id: 'debates', label: 'Debates' },
  { id: 'followups', label: 'Follow-ups' }, { id: 'segments', label: 'Segments' },
];

// "<base>" when vp is a scrim folder (direct subfolder of SCRIM_BASE), else null.
function scrimBaseOf(vp) {
  if (!vp || !vp.startsWith(SCRIM_BASE + '/')) return null;
  const rest = vp.slice(SCRIM_BASE.length + 1);
  return rest && !rest.includes('/') ? rest : null;
}

// The scrim folder when vp is a scrim's Matches/ folder, else null.
function matchesScrimOf(vp) {
  if (!vp || !vp.endsWith('/Matches')) return null;
  const scrim = vp.slice(0, -'/Matches'.length);
  return scrimBaseOf(scrim) ? scrim : null;
}

// A virtual Report/Coaching group — CandyHeader + static leaf rows (no disk
// children; useGameWikiTree skips fetching these paths). Expansion rides the same
// expanded Set as real folders, so persistence + collapse-all just work.
function VirtualGroup({ scrimPath, name, views, tree, accent, currentPath, nav }) {
  const vp = `${scrimPath}/${name}`;
  const open = tree.isOpen(vp);
  // M20: the Report group's "Report" (tldr) leaf gets the generated report's sections as a sub-nav.
  // Load them from the .vodreport sidecar once this group is open (Report group only; Coaching stays flat).
  const [sections, setSections] = useState([]);
  useEffect(() => {
    if (name !== 'Report' || !open) return undefined;
    let cancelled = false;
    api.getRawFileMeta(scrimSidecarPath(scrimPath, 'vodreport'), 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        try {
          const j = JSON.parse(r.content);
          setSections((j.sections || []).filter((s) => s?.id && s?.heading).map((s) => ({ id: String(s.id), heading: String(s.heading) })));
        } catch { setSections([]); }
      })
      .catch(() => { if (!cancelled) setSections([]); });
    return () => { cancelled = true; };
  }, [name, open, scrimPath]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <CandyHeader label={name} open={open} accent={accent} onToggle={() => tree.toggle(vp)}/>
      <Collapsible open={open} count={views.length}>
        <TreeChildren>
          {views.map((v, i) => (
            <StaggerChild key={v.id} index={i} count={views.length} open={open}>
              {v.id === 'tldr' && sections.length
                ? <ReportSectionLeaf vp={vp} view={v} sections={sections} scrimPath={scrimPath}
                    tree={tree} accent={accent} currentPath={currentPath} nav={nav}/>
                : <TreeRow label={v.label} accent={accent}
                    selected={currentPath === `${vp}/${v.id}`}
                    onClick={() => nav('/game-wiki/' + encodePagePath(`${vp}/${v.id}`))}/>}
            </StaggerChild>
          ))}
        </TreeChildren>
      </Collapsible>
    </div>
  );
}

// M20: the Report (tldr) leaf as an expandable sub-group — the label opens the Report tab, the caret
// reveals the section sub-nav. A section navigates to the Report tab (if not already there) and asks
// the content pane to scroll that heading into view via the module-scope sectionJump bridge. Shares
// the tree's expanded Set (keyed by the virtual path) like the Report/Coaching groups do.
function ReportSectionLeaf({ vp, view, sections, scrimPath, tree, accent, currentPath, nav }) {
  const key = `${vp}/${view.id}`;
  const open = tree.isOpen(key);
  const goReport = () => nav('/game-wiki/' + encodePagePath(key));
  const goSection = (id) => { goReport(); requestSectionJump(scrimPath, id); };
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <CandyHeader label={view.label} open={open} accent={accent}
        activeFill={currentPath === key} onActivate={goReport} onToggle={() => tree.toggle(key)}/>
      <Collapsible open={open} count={sections.length}>
        <TreeChildren>
          {sections.map((s, i) => (
            <StaggerChild key={s.id} index={i} count={sections.length} open={open}>
              <TreeRow label={s.heading} accent={accent} onClick={() => goSection(s.id)}/>
            </StaggerChild>
          ))}
        </TreeChildren>
      </Collapsible>
    </div>
  );
}

function TreeBody({ node, tree, accent, currentPath, open, openMenu, nav, onNewMatch, animateOnMount = true }) {
  const [entered, setEntered] = useState(!animateOnMount);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const shown = entered && open;
  const entry = tree.childrenOf(node.vaultPath);
  let nodes = entry?.nodes || [];
  const loading = !entry || entry.loading;
  const scrimBase = scrimBaseOf(node.vaultPath);
  const matchesScrim = matchesScrimOf(node.vaultPath);
  if (scrimBase) {
    // Fixed scrim-folder order: Overview page, Matches/, then anything stray.
    const rank = (c) => (!c.isFolder && c.name === 'Overview') ? 0 : (c.isFolder && c.name === 'Matches') ? 1 : 2;
    nodes = nodes.slice().sort((a, b) => rank(a) - rank(b));
  } else if (matchesScrim) {
    // Numeric match order (localeCompare puts "Match 10" before "Match 2").
    const num = (s) => Number((s.match(/(\d+)/) || [])[1] || 0);
    nodes = nodes.slice().sort((a, b) => num(a.name) - num(b.name) || a.name.localeCompare(b.name));
  }
  const extras = scrimBase ? 2 : matchesScrim ? 1 : 0;
  const n = nodes.length + extras;
  let inner;
  if (loading && n === 0) inner = <div style={MUTED}>…</div>;
  else if (n === 0) inner = <div style={MUTED}>empty</div>;
  else {
    inner = [
      ...nodes.map((child, i) => (
        <StaggerChild key={child.vaultPath} index={i} count={n} open={shown}>
          <TreeNode node={child} tree={tree} accent={accent} currentPath={currentPath}
            openMenu={openMenu} nav={nav} onNewMatch={onNewMatch}/>
        </StaggerChild>
      )),
      ...(scrimBase ? [
        <StaggerChild key="virtual:report" index={nodes.length} count={n} open={shown}>
          <VirtualGroup scrimPath={node.vaultPath} name="Report" views={REPORT_VIEWS}
            tree={tree} accent={accent} currentPath={currentPath} nav={nav}/>
        </StaggerChild>,
        <StaggerChild key="virtual:coaching" index={nodes.length + 1} count={n} open={shown}>
          <VirtualGroup scrimPath={node.vaultPath} name="Coaching" views={COACHING_VIEWS}
            tree={tree} accent={accent} currentPath={currentPath} nav={nav}/>
        </StaggerChild>,
      ] : []),
      ...(matchesScrim ? [
        <StaggerChild key="virtual:new-match" index={nodes.length} count={n} open={shown}>
          <TreeRow label="+ New Match" accent={accent} onClick={() => onNewMatch(matchesScrim)}/>
        </StaggerChild>,
      ] : []),
    ];
  }
  return <TreeChildren>{inner}</TreeChildren>;
}

function TreeNode({ node, tree, accent, currentPath, openMenu, nav, onNewMatch }) {
  if (node.isFolder) {
    const open = tree.isOpen(node.vaultPath);
    const entry = tree.childrenOf(node.vaultPath);
    const mounted = open || !!entry;
    const scrimBase = scrimBaseOf(node.vaultPath);
    const extras = scrimBase ? 2 : matchesScrimOf(node.vaultPath) ? 1 : 0;
    const count = (entry?.nodes?.length || 0) + extras;
    const hasMenu = node.vaultPath === SCRIM_BASE || !!scrimBase;
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <CandyHeader label={node.name} open={open} accent={accent}
          onToggle={() => tree.toggle(node.vaultPath)}
          onContextMenu={hasMenu ? (e) => openMenu(e, node) : undefined}/>
        <Collapsible open={open} count={count}>
          {mounted && <TreeBody open={open} node={node} tree={tree} accent={accent}
            currentPath={currentPath} openMenu={openMenu} nav={nav} onNewMatch={onNewMatch}/>}
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

  // "+ New Match": next n from the Matches/ listing, team names from Overview.md.
  const doNewMatch = async (scrimFolder) => {
    try {
      const res = await api.listFolderRaw(`${scrimFolder}/Matches`, 'gamewiki').catch(() => null);
      const n = Math.max(0, ...(res?.files || []).map((f) => Number((f.match(/^Match (\d+)\.md$/) || [])[1] || 0))) + 1;
      const ov = await api.getRawFileMeta(`${scrimFolder}/Overview.md`, 'gamewiki');
      const fm = parseOverview(ov.content).frontmatter || {};
      const coached = fm['Coached Team'] || fm['Team 1'] || '';
      const enemy = (fm['Team 1'] === coached ? fm['Team 2'] : fm['Team 1']) || '';
      await api.savePage(`${scrimFolder}/Matches/Match ${n}.md`, newMatchContent(n, coached, enemy), 0, 'gamewiki');
      await tree.refresh(`${scrimFolder}/Matches`);
      nav('/game-wiki/' + encodePagePath(`${scrimFolder}/Matches/Match ${n}`));
    } catch (e) { console.warn('new match failed', e); }
  };

  // Folder rename. The recordings folder follows the scrim name, and recording
  // fields hold absolute paths INTO it (Overview: VOD Review; Match <n>: Scrim
  // Recording) — rewrite the folder segment in every page or they dangle.
  const doRename = async (oldBase, newName) => {
    const newBase = newName.trim();
    if (!newBase || newBase === oldBase) { setModal(null); return; }
    const oldFolder = `${SCRIM_BASE}/${oldBase}`;
    const newFolder = `${SCRIM_BASE}/${newBase}`;
    try {
      await api.renamePath(oldFolder, newFolder, 'gamewiki');
      try {
        await invoke('coaching_rename_scrim_dir', { oldBase, newBase });
        const res = await api.listFolderRaw(`${newFolder}/Matches`, 'gamewiki').catch(() => null);
        const pages = ['Overview.md', ...(res?.files || []).filter((f) => f.endsWith('.md')).map((f) => `Matches/${f}`)];
        for (const rel of pages) {
          const p = `${newFolder}/${rel}`;
          const r = await api.getRawFileMeta(p, 'gamewiki');
          const swapped = r.content
            .replaceAll(`Scrims\\${oldBase}\\`, `Scrims\\${newBase}\\`)
            .replaceAll(`Scrims/${oldBase}/`, `Scrims/${newBase}/`);
          if (swapped !== r.content) await api.savePage(p, swapped, r.mtime ?? null, 'gamewiki');
        }
      } catch (e) { console.warn('scrim recordings folder rename skipped', e); }
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
                      openMenu={openMenu} nav={nav} onNewMatch={doNewMatch}/>}
                  </Collapsible>
                </div>
              );
            })}
            <div aria-hidden style={{ flexShrink: 0, height: 9 }}/>
          </div>

          {modal?.kind === 'rename' && (
            <NameInputModal open title={`Rename ${modal.base}`} label="New name" confirmLabel="Rename" initialValue={modal.base}
              onCancel={() => setModal(null)}
              onSubmit={(name) => doRename(modal.base, name)}/>
          )}
          {modal?.kind === 'delete' && (
            <ConfirmModal open title={`Delete ${modal.base}?`}
              message={modal.err
                ? `Last attempt failed: ${modal.err}`
                : 'Sends the whole scrim folder (Overview, matches, and ALL sidecar data — match data, comms transcripts, VOD report, feedback, notes) to the Recycle Bin as one item.'}
              confirmLabel="Delete" cancelLabel="Cancel"
              onCancel={() => setModal(null)}
              onConfirm={() => doDelete(modal.base)}/>
          )}
        </div>
      </SuffixCtx.Provider>
    </AnimCtx.Provider>
  );
}

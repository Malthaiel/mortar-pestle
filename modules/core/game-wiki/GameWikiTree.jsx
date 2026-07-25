// Game Wiki sidebar tree — the games tree (top-level = games, expand into each
// game's raw folder structure). Renders with the shared treeKit candy-pill
// primitives so it's pixel-identical to the vault tree, backed by the lazy
// useGameWikiTree hook. The gamewiki vault is read-only reference EXCEPT
// Deadlock/Coaching/Scrim — a scrim is a FOLDER (GameWiki Unification 2026-07-16:
// Overview.md + Matches/Match <n>.md + dot-sidecars). M1 (VOD Report Final
// Improvements): each match renders as a FOLDER node with report-section +
// segments children; the old scrim-level Report/ + Coaching/ virtual groups and
// the "+ New Match" trailing row are gone. M2: scrim + match folders carry
// right-click menus (New Match / Rename / Delete, scrim adds Export
// Carry-Forward) through the app-wide useContextMenu primitive. Every other
// node stays menu-less.
//
// The tree hook + New Scrim modal live in GameWikiRail (the shared composition
// both surfaces mount); this component takes `tree` + `onNewScrim` as props.

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
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
import { parseOverview, parseMatchFile, serializeMatchFile, newMatchContent } from './scrimSchema.js';
import { sidecarPath, matchPath } from './matchData.js';
import { exportCarryForward } from './carryForward.js';
import { requestSectionJump } from './sectionJump.js';

export const SCRIM_BASE = 'Deadlock/Coaching/Scrim';

// The per-match report views (M1). Ids double as route tails
// (/game-wiki/<scrim>/Matches/Match <n>/<id>) — GameWikiPage dispatches on them,
// VodReportView (variant="match") renders them as tabs. Section children under
// the Report leaf jump via the sectionJump bridge, keyed by the match page path.
export const MATCH_VIEWS = [
  { id: 'tldr', label: 'Report' },
  { id: 'players', label: 'Player Cards' },
  { id: 'macro', label: 'Macro' },
  { id: 'comms', label: 'Comms Grade' },
  { id: 'actions', label: 'Action Items' },
  { id: 'qa', label: 'Q&A' },
  { id: 'keep', label: 'Keep Doing' },
  { id: 'debates', label: 'Debates' },
  { id: 'followups', label: 'Follow-ups' },
];
// The two transcript pages (M1, locked decision 10): comms stamps land in Comms
// Segments, review stamps in Review Segments — separate leaves, never one page.
export const SEGMENT_VIEWS = [
  { id: 'comms-segments', label: 'Comms Segments' },
  { id: 'review-segments', label: 'Review Segments' },
];

// "<base>" when vp is a scrim folder (direct subfolder of SCRIM_BASE), else null.
function scrimBaseOf(vp) {
  if (!vp || !vp.startsWith(SCRIM_BASE + '/')) return null;
  const rest = vp.slice(SCRIM_BASE.length + 1);
  return rest && !rest.includes('/') ? rest : null;
}

// Scrim-scoped tree services (listings, display labels, menus, match ops) —
// context, not prop-drilling: TreeBody/MatchGroup sit several layers under the
// component that owns the state (same reason treeKit's AnimCtx is a context).
const ScrimCtx = createContext(null);

// One disk listing per scrim: match numbers + the sidecar filenames (dot-files
// are invisible to vault_get_folder, so the tree's normal fetch can't see them)
// + the scrim-root files (.vodcomms presence gates the Review Segments leaf for
// legacy single-match scrims; Carry-Forward.md renders when present).
async function fetchScrimListing(scrim) {
  const [matches, root] = await Promise.all([
    api.listFolderRaw(`${scrim}/Matches`, 'gamewiki').catch(() => null),
    api.listFolderRaw(scrim, 'gamewiki').catch(() => null),
  ]);
  const files = matches?.files || [];
  const ns = files
    .map((f) => Number((f.match(/^Match (\d+)\.md$/) || [])[1]))
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  // Display names (M2: rename edits the display name only; the folder key stays
  // Match N). Read from each match file's Name field — small files, read once
  // per listing refresh.
  const labels = {};
  await Promise.all(ns.map(async (n) => {
    try {
      const m = parseMatchFile((await api.getRawFileMeta(matchPath(scrim, n), 'gamewiki')).content, n);
      if (String(m.fields?.Name || '').trim()) labels[n] = String(m.fields.Name).trim();
    } catch { /* unreadable match file → default label */ }
  }));
  return {
    ns,
    labels,
    sidecars: new Set(files.filter((f) => f.startsWith('.'))),
    rootFiles: new Set(root?.files || []),
  };
}

// A match folder (M1) — CandyHeader + the flattened children: Overview, then
// (when a report sidecar exists) the report views with a section sub-nav under
// Report, then the two segments leaves. Expansion rides the tree's expanded Set
// keyed by the virtual path, so persistence + collapse-all just work.
function MatchGroup({ scrimPath, n, tree, accent, currentPath, nav }) {
  const ctx = useContext(ScrimCtx);
  const listing = ctx.listings[scrimPath];
  const hasSc = (prefix) => !!listing?.sidecars.has(`.${prefix}.Match ${n}.json`);
  // Final replaces first everywhere (locked decision 2) — the tree reads whichever wins.
  const reportKind = hasSc('matchfinal') ? 'matchfinal' : hasSc('matchreport') ? 'matchreport' : null;
  const hasComms = hasSc('commstranscript');
  const hasReview = hasSc('reviewcomms')
    || (listing?.ns.length === 1 && listing.rootFiles.has('.vodcomms.json')); // M8 legacy adoption, single-match only
  const vp = `${scrimPath}/Matches/Match ${n}`;
  const open = tree.isOpen(vp);
  const label = listing?.labels[n] || `Match ${n}`;

  // Report meta for the section sub-nav + the Follow-ups leaf (hidden when the
  // report has none — same rule as the report view's tab strip). Read when the
  // group opens, like the retired VirtualGroup did.
  const [rmeta, setRmeta] = useState({ sections: [], followUps: 0 });
  useEffect(() => {
    if (!open || !reportKind) return undefined;
    let cancelled = false;
    api.getRawFileMeta(sidecarPath(scrimPath, n, reportKind), 'gamewiki')
      .then((r) => {
        if (cancelled) return;
        try {
          const j = JSON.parse(r.content);
          setRmeta({
            sections: (j.sections || []).filter((s) => s?.id && s?.heading).map((s) => ({ id: String(s.id), heading: String(s.heading) })),
            followUps: (j.followUps || []).length,
          });
        } catch { setRmeta({ sections: [], followUps: 0 }); }
      })
      .catch(() => { if (!cancelled) setRmeta({ sections: [], followUps: 0 }); });
    return () => { cancelled = true; };
  }, [open, reportKind, scrimPath, n]);

  const go = (id) => nav('/game-wiki/' + encodePagePath(id ? `${vp}/${id}` : vp));
  const rows = [];
  rows.push(<TreeRow key="overview" label="Overview" accent={accent} selected={currentPath === vp} onClick={() => go(null)} />);
  if (reportKind) {
    for (const v of MATCH_VIEWS) {
      if (v.id === 'followups' && !rmeta.followUps) continue;
      rows.push(v.id === 'tldr' && rmeta.sections.length
        ? <ReportSectionLeaf key={v.id} vp={vp} view={v} sections={rmeta.sections}
            jumpKey={matchPath(scrimPath, n)} tree={tree} accent={accent} currentPath={currentPath} nav={nav} />
        : <TreeRow key={v.id} label={v.label} accent={accent}
            selected={currentPath === `${vp}/${v.id}`} onClick={() => go(v.id)} />);
    }
  }
  for (const v of SEGMENT_VIEWS) {
    const present = v.id === 'comms-segments' ? hasComms : hasReview;
    rows.push(present
      ? <TreeRow key={v.id} label={v.label} accent={accent}
          selected={currentPath === `${vp}/${v.id}`} onClick={() => go(v.id)} />
      : <div key={v.id} style={MUTED}>{v.label} — no recording yet</div>);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <CandyHeader label={label} open={open} accent={accent}
        onToggle={() => tree.toggle(vp)}
        onContextMenu={(e) => ctx.openMatchMenu(e, scrimPath, n, label)} />
      <Collapsible open={open} count={rows.length}>
        <TreeChildren>
          {rows.map((el, i) => (
            <StaggerChild key={el.key} index={i} count={rows.length} open={open}>{el}</StaggerChild>
          ))}
        </TreeChildren>
      </Collapsible>
    </div>
  );
}

// The Report (tldr) leaf as an expandable sub-group — the label opens the Report
// tab, the caret reveals the section sub-nav. A section navigates to the Report
// tab and asks the content pane to scroll that heading into view via the
// module-scope sectionJump bridge (keyed by the match page path, which is the
// mdPath the match report view consumes). Shares the tree's expanded Set.
function ReportSectionLeaf({ vp, view, sections, jumpKey, tree, accent, currentPath, nav }) {
  const key = `${vp}/${view.id}`;
  const open = tree.isOpen(key);
  const goReport = () => nav('/game-wiki/' + encodePagePath(key));
  const goSection = (id) => { goReport(); requestSectionJump(jumpKey, id); };
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

function TreeBody({ node, tree, accent, currentPath, open, openMenu, nav, animateOnMount = true }) {
  const ctx = useContext(ScrimCtx);
  const [entered, setEntered] = useState(!animateOnMount);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const scrimBase = scrimBaseOf(node.vaultPath);
  useEffect(() => {
    if (scrimBase && open) ctx.ensureListing(node.vaultPath);
  }, [scrimBase, open, node.vaultPath, ctx]);
  const shown = entered && open;
  const entry = tree.childrenOf(node.vaultPath);
  let nodes = entry?.nodes || [];
  const loading = !entry || entry.loading;
  let ns = [];
  if (scrimBase) {
    // M1 scrim shape: slim Overview first, then the match folders (from the raw
    // listing — the Matches/ disk folder itself no longer renders), then any
    // remaining real files (Carry-Forward.md when the M24 export has run).
    nodes = nodes.filter((c) => !(c.isFolder && c.name === 'Matches'));
    const rank = (c) => ((!c.isFolder && c.name === 'Overview') ? 0 : 2);
    nodes = nodes.slice().sort((a, b) => rank(a) - rank(b));
    ns = ctx.listings[node.vaultPath]?.ns || [];
  }
  const pre = scrimBase ? nodes.filter((c) => !c.isFolder && c.name === 'Overview') : nodes;
  const post = scrimBase ? nodes.filter((c) => !(!c.isFolder && c.name === 'Overview')) : [];
  const n = pre.length + ns.length + post.length;
  let inner;
  if (loading && n === 0) inner = <div style={MUTED}>…</div>;
  else if (n === 0) inner = <div style={MUTED}>empty</div>;
  else {
    let i = 0;
    const child = (el) => { const k = i++; return <StaggerChild key={el.key} index={k} count={n} open={shown}>{el}</StaggerChild>; };
    inner = [
      ...pre.map((c) => child(<TreeNode key={c.vaultPath} node={c} tree={tree} accent={accent}
        currentPath={currentPath} openMenu={openMenu} nav={nav}/>)),
      ...ns.map((k) => child(<MatchGroup key={`match:${k}`} scrimPath={node.vaultPath} n={k}
        tree={tree} accent={accent} currentPath={currentPath} nav={nav}/>)),
      ...post.map((c) => child(<TreeNode key={c.vaultPath} node={c} tree={tree} accent={accent}
        currentPath={currentPath} openMenu={openMenu} nav={nav}/>)),
    ];
  }
  return <TreeChildren>{inner}</TreeChildren>;
}

function TreeNode({ node, tree, accent, currentPath, openMenu, nav }) {
  const ctx = useContext(ScrimCtx);
  if (node.isFolder) {
    const open = tree.isOpen(node.vaultPath);
    const entry = tree.childrenOf(node.vaultPath);
    const mounted = open || !!entry;
    const scrimBase = scrimBaseOf(node.vaultPath);
    const extras = scrimBase ? (ctx.listings[node.vaultPath]?.ns.length || 0) : 0;
    const count = (entry?.nodes?.length || 0) + extras;
    const hasMenu = node.vaultPath === SCRIM_BASE || !!scrimBase;
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <CandyHeader label={node.name} open={open} accent={accent}
          onToggle={() => tree.toggle(node.vaultPath)}
          onContextMenu={hasMenu ? (e) => openMenu(e, node) : undefined}/>
        <Collapsible open={open} count={count}>
          {mounted && <TreeBody open={open} node={node} tree={tree} accent={accent}
            currentPath={currentPath} openMenu={openMenu} nav={nav}/>}
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
  const [listings, setListings] = useState({});
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  const refreshListing = useCallback(async (scrim) => {
    const l = await fetchScrimListing(scrim);
    setListings((L) => ({ ...L, [scrim]: l }));
    return l;
  }, []);
  const ensureListing = useCallback((scrim) => {
    if (!listingsRef.current[scrim]) refreshListing(scrim).catch(() => {});
  }, [refreshListing]);

  // "New Match" (M2: context-menu only — the trailing "+ New Match" row is gone):
  // next n from the Matches/ listing, team names from Overview.md.
  const doNewMatch = async (scrimFolder) => {
    try {
      const res = await api.listFolderRaw(`${scrimFolder}/Matches`, 'gamewiki').catch(() => null);
      const n = Math.max(0, ...(res?.files || []).map((f) => Number((f.match(/^Match (\d+)\.md$/) || [])[1] || 0))) + 1;
      const ov = await api.getRawFileMeta(`${scrimFolder}/Overview.md`, 'gamewiki');
      const fm = parseOverview(ov.content).frontmatter || {};
      const coached = fm['Coached Team'] || fm['Team 1'] || '';
      const enemy = (fm['Team 1'] === coached ? fm['Team 2'] : fm['Team 1']) || '';
      await api.savePage(`${scrimFolder}/Matches/Match ${n}.md`, newMatchContent(n, coached, enemy), 0, 'gamewiki');
      await refreshListing(scrimFolder);
      nav('/game-wiki/' + encodePagePath(`${scrimFolder}/Matches/Match ${n}`));
    } catch (e) { console.warn('new match failed', e); }
  };

  // M2 match rename: display name ONLY — written to the match file's Name field;
  // the folder key (file name, sidecar names, routes) stays `Match N` so nothing
  // keyed to the index can dangle.
  const doRenameMatch = async (scrim, n, name) => {
    const trimmed = String(name ?? '').trim();
    try {
      const p = matchPath(scrim, n);
      const r = await api.getRawFileMeta(p, 'gamewiki');
      const m = parseMatchFile(r.content, n);
      const fields = { ...m.fields };
      if (trimmed && trimmed !== `Match ${n}`) fields.Name = trimmed;
      else delete fields.Name; // blank or the default → back to "Match N"
      await api.savePage(p, serializeMatchFile({ ...m, fields }), r.mtime ?? null, 'gamewiki');
      await refreshListing(scrim);
      setModal(null);
    } catch (e) {
      setModal({ kind: 'rename-match', scrim, n, label: name, err: String(e?.message || e) });
    }
  };

  // M2 match delete: the match page AND every dot-sidecar keyed to its index
  // (reports, transcripts, classifications) — the confirm modal names that.
  const doDeleteMatch = async (scrim, n) => {
    try {
      const listing = listingsRef.current[scrim] || await refreshListing(scrim);
      const suffix = `.Match ${n}.json`;
      for (const f of listing.sidecars) {
        if (f.endsWith(suffix)) await api.deleteFile(`${scrim}/Matches/${f}`, 'gamewiki').catch(() => {});
      }
      await api.deleteFile(`${scrim}/Matches/Match ${n}.md`, 'gamewiki');
      await refreshListing(scrim);
      setModal(null);
      const vp = `${scrim}/Matches/Match ${n}`;
      if (currentPath === vp || currentPath.startsWith(vp + '/')) nav('/game-wiki/' + encodePagePath(`${scrim}/Overview`));
    } catch (e) {
      setModal({ kind: 'delete-match', scrim, n, err: String(e?.message || e) });
    }
  };

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
    // M2 scrim menu (locked decision 9): New Match / Export Carry-Forward /
    // Rename / Delete. Export enables once a final report exists (M24 wires the
    // compiler; until then the item stays disabled — no finals can exist yet).
    const hasFinals = [...(listingsRef.current[node.vaultPath]?.sidecars || [])].some((f) => f.startsWith('.matchfinal.'));
    openContextMenu(e, [
      { label: 'New Match', icon: IconPlus, onClick: () => doNewMatch(node.vaultPath) },
      {
        label: 'Export Carry-Forward',
        icon: IconFile,
        disabled: !hasFinals,
        // M24: mechanical, no AI. Writes Carry-Forward.md at the scrim root from every final report
        // in the scrim. BOTH caches must be re-read or the new node stays invisible: refreshListing
        // re-reads Matches/ (match numbers + sidecars), while the scrim folder's own FILE children —
        // where Carry-Forward.md lands — live in the tree hook's cache and only tree.refresh drops it.
        onClick: () => {
          exportCarryForward(api, node.vaultPath, { scrim: base, date: new Date().toISOString().slice(0, 10) })
            .then(() => { tree.refresh(node.vaultPath); return refreshListing(node.vaultPath); })
            .catch(() => {});
        },
      },
      { divider: true },
      { label: 'Rename…', icon: IconFile, onClick: () => setModal({ kind: 'rename', base }) },
      { label: 'Delete', icon: IconX, danger: true, onClick: () => setModal({ kind: 'delete', base }) },
      { divider: true },
      { label: 'Reveal in Files', icon: IconFolder, onClick: () => { invoke('coaching_reveal_path', { path: node.vaultPath }).catch(() => {}); } },
      { label: 'Copy path', icon: IconLink, onClick: () => { try { navigator.clipboard.writeText(node.vaultPath); } catch {} } },
    ], { accent });
  };

  // M2 match menu (locked decision 9): New Match / Rename / Delete.
  const openMatchMenu = (e, scrim, n, label) => {
    openContextMenu(e, [
      { label: 'New Match', icon: IconPlus, onClick: () => doNewMatch(scrim) },
      { label: 'Rename…', icon: IconFile, onClick: () => setModal({ kind: 'rename-match', scrim, n, label }) },
      { label: 'Delete', icon: IconX, danger: true, onClick: () => setModal({ kind: 'delete-match', scrim, n }) },
    ], { accent });
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
    <ScrimCtx.Provider value={{ listings, ensureListing, refreshListing, openMatchMenu }}>
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
                        openMenu={openMenu} nav={nav}/>}
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
                  : 'Sends the whole scrim folder (Overview, matches, and ALL sidecar data — match data, comms transcripts, reports, feedback, notes) to the Recycle Bin as one item.'}
                confirmLabel="Delete" cancelLabel="Cancel"
                onCancel={() => setModal(null)}
                onConfirm={() => doDelete(modal.base)}/>
            )}
            {modal?.kind === 'rename-match' && (
              <NameInputModal open title={`Rename Match ${modal.n}`} label="Display name" confirmLabel="Rename"
                initialValue={modal.label || `Match ${modal.n}`}
                onCancel={() => setModal(null)}
                onSubmit={(name) => doRenameMatch(modal.scrim, modal.n, name)}/>
            )}
            {modal?.kind === 'delete-match' && (
              <ConfirmModal open title={`Delete Match ${modal.n}?`}
                message={modal.err
                  ? `Last attempt failed: ${modal.err}`
                  : `Deletes Match ${modal.n} and its reports/recordings metadata (match data, comms + review transcripts, classifications, reports). Recordings on disk are not touched.`}
                confirmLabel="Delete" cancelLabel="Cancel"
                onCancel={() => setModal(null)}
                onConfirm={() => doDeleteMatch(modal.scrim, modal.n)}/>
            )}
          </div>
        </SuffixCtx.Provider>
      </AnimCtx.Provider>
    </ScrimCtx.Provider>
  );
}

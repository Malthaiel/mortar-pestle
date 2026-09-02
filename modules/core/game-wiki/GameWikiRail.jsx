// GameWikiRail — the shared GameWiki tree rail (GameWiki Unification):
// TreeToolbar (New Scrim · Collapse/Expand · Reveal current · Reveal in files)
// + the GameWikiTree body — the same shell shape as VaultTree/TreeSidebar, so
// the main app's sidebar reads identical to the vault + Library trees (no
// header pill there; the app brand block already lives in the primary nav).
// The scrim overlay mounts the same composition inside its CollapsibleRail
// (Phase 5) with its own RailHeaderPill in the rail's header slot and a
// local-selection `nav` shim. Owns the tree hook + the New Scrim modal so both
// surfaces share one create path. No new primitives — the pill is the
// ScrimRailHeader recipe, the toolbar is the shared TreeToolbar.

import { useState } from 'react';
import { navigate } from '@host/router.js';
import { api, invoke } from '@host/api.js';
import TreeToolbar from '@host/components/vault-tree/TreeToolbar.jsx';
import { TOOLBAR_BAND } from '@host/components/vault-tree/treeKit.jsx';
import { IconChevronRight } from '@host/components/icons.jsx';
import { VAULT_SORT_MODES } from '@host/components/vault-tree/useVaultTree.js';
import GameWikiTree, { SCRIM_BASE } from './GameWikiTree.jsx';
import { useGameWikiTree } from './useGameWikiTree.js';
import NewScrimModal from './NewScrimModal.jsx';
import { newScrimName } from './scrimSchema.js';

// The rail's top pill — the ScrimRailHeader recipe (the main nav's brand block,
// .candy-btn.is-primary data-variant="brand"). Collapsed shows an expand chevron.
export function RailHeaderPill({ label, title, accent, onClick, expanded = true }) {
  return (
    <div style={{ height: 'var(--brand-section-h)', flexShrink: 0, display: 'flex' }}>
      <button type="button" onClick={onClick} data-own-press aria-label={title} title={title}
        className="candy-btn is-primary" data-shape="block" data-variant="brand"
        style={accent ? { '--accent': accent } : undefined}>
        <span className="candy-face" style={{ justifyContent: 'center', padding: expanded ? '0 12px' : 0 }}>
          {expanded
            ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            : <IconChevronRight size={16}/>}
        </span>
      </button>
    </div>
  );
}

export default function GameWikiRail({ route, accent, nav = navigate, header }) {
  const tree = useGameWikiTree();
  const [modal, setModal] = useState(null);

  // No header pill by default — the main app's sidebar matches the vault +
  // Library shells (toolbar band first; duplicating the primary nav's brand
  // block read as two "MORTAR & PESTLE" buttons, cut 2026-07-16). A surface
  // that wants a pill passes { label, title, onClick } (the overlay instead
  // mounts RailHeaderPill in its CollapsibleRail header slot and passes null).
  const h = header || null;

  const currentPath = route?.page === 'game-wiki' ? (route.rest || '') : '';

  // Scrim Teardown (2026-07-26): New Scrim creates the correctly-named folder and
  // NOTHING inside it. There is no Overview, no Matches, no seed file to write and
  // nowhere to navigate afterwards — the tree refresh is the whole feedback.
  const doCreate = async ({ team1, team2 }) => {
    const base = newScrimName({ team1, team2 });
    try {
      // Dedup against the authoritative disk listing (the tree cache may be cold).
      const res = await api.listFolderRaw(SCRIM_BASE, 'gamewiki').catch(() => null);
      const existing = new Set(res?.subfolders || []);
      let uniq = base;
      if (existing.has(uniq)) { let k = 2; while (existing.has(`${base} (${k})`)) k++; uniq = `${base} (${k})`; }
      await api.createFolder(`${SCRIM_BASE}/${uniq}`, 'gamewiki');
      setModal(null);
      await tree.refresh(SCRIM_BASE);
    } catch (e) {
      setModal({ kind: 'new-scrim', err: String(e?.message || e) });
    }
  };

  // The vault tree-toolbar recipe minus New folder (GameWiki is read-only
  // reference — scrims are created via the Scrim folder's right-click menu; a
  // generic create-folder had no delete/rename affordance, so it's cut).
  const buttons = {
    new: { show: true, title: 'New Scrim', onClick: () => setModal({ kind: 'new-scrim' }) },
    sort: { show: true },
    collapse: { show: true },
    revealCurrent: { show: true, title: 'Reveal current' },
    // reveal_in_files excludes the gamewiki root — coaching_reveal_path is the
    // gamewiki-rooted arm; revealing Deadlock/ lands the file manager at the root.
    revealInFiles: { show: true, onClick: () => invoke('coaching_reveal_path', { path: 'Deadlock' }).catch(() => {}) },
  };

  // TreeToolbar controller = the tree hook (sortMode/setSortMode live there) +
  // the vault's mode list + the Reveal-current surface (expand ancestors, then
  // scroll the tagged row into view after the cascade — the VaultTree recipe).
  const controller = {
    ...tree,
    sortModes: VAULT_SORT_MODES,
    canReveal: !!currentPath,
    revealCurrent: () => {
      tree.reveal(currentPath);
      setTimeout(() => {
        const el = document.querySelector('[data-current-file="true"]');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 280);
    },
  };

  return (
    // --candy-depth-nav must exist HERE, not just inside GameWikiTree: the
    // toolbar band's padding is TOOLBAR_BAND, whose bottom pad is calc(4px +
    // var(--candy-depth-nav)) — an unresolvable var() voids the whole padding
    // shorthand (measured: toolbar rode 7px high, tree started 10px early vs
    // the vault sidebar). Same declaration as VaultTree's root.
    <div style={{
      display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
      '--candy-depth-nav': 'calc(var(--candy-depth) * 0.85)',
    }}>
      {h && <RailHeaderPill label={h.label} title={h.title} accent={accent} onClick={h.onClick} expanded={h.expanded !== false}/>}
      <div style={{ flexShrink: 0, padding: TOOLBAR_BAND }}>
        <TreeToolbar buttons={buttons} controller={controller} accent={accent}/>
      </div>
      <GameWikiTree route={route} accent={accent} tree={tree} nav={nav}
        onNewScrim={() => setModal({ kind: 'new-scrim' })}/>
      {modal?.kind === 'new-scrim' && (
        <NewScrimModal open error={modal.err} onCancel={() => setModal(null)} onSubmit={doCreate}/>
      )}
    </div>
  );
}

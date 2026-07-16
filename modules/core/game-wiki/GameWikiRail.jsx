// GameWikiRail — the shared GameWiki tree rail (GameWiki Unification): header
// pill + TreeToolbar (New Scrim · Collapse/Expand · Reveal in files) + the
// GameWikiTree body. The main app mounts it as the module's secondary sidebar;
// the scrim overlay mounts the same composition inside its CollapsibleRail
// (Phase 5) with a `header` override (scrim title / "GAMEWIKI OVERLAY" +
// collapse toggle) and a local-selection `nav` shim. Owns the tree hook + the
// New Scrim modal so both surfaces share one create path. No new primitives —
// the pill is the ScrimRailHeader recipe, the toolbar is the shared TreeToolbar.

import { useState } from 'react';
import { navigate } from '@host/router.js';
import { api, invoke } from '@host/api.js';
import TreeToolbar from '@host/components/vault-tree/TreeToolbar.jsx';
import { GAP } from '@host/components/vault-tree/treeKit.jsx';
import { IconPlus, IconChevronRight } from '@host/components/icons.jsx';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import GameWikiTree, { SCRIM_BASE } from './GameWikiTree.jsx';
import { useGameWikiTree } from './useGameWikiTree.js';
import NewScrimModal from './NewScrimModal.jsx';
import { newScrimScaffold } from './scrimSchema.js';

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

  // Main-app default header: the brand pill routes to the Game Wiki landing.
  // The overlay passes `null` (its pill lives in the CollapsibleRail header slot
  // so it survives the collapsed state) or its own { label, title, onClick }.
  const h = header === null ? null : (header || { label: 'MORTAR & PESTLE', title: 'Game Wiki home', onClick: () => nav('/game-wiki') });

  const doCreate = async ({ team1, team2 }) => {
    const { base, files } = newScrimScaffold({ team1, team2 });
    try {
      // Dedup against the authoritative disk listing (the tree cache may be cold).
      const res = await api.listFolderRaw(SCRIM_BASE, 'gamewiki').catch(() => null);
      const existing = new Set(res?.subfolders || []);
      let uniq = base;
      if (existing.has(uniq)) { let k = 2; while (existing.has(`${base} (${k})`)) k++; uniq = `${base} (${k})`; }
      for (const f of files) await api.savePage(`${SCRIM_BASE}/${uniq}/${f.rel}`, f.content, 0, 'gamewiki');
      // Per-scrim recordings folder (Videos\Mortar & Pestle\Scrims\<base>) — also
      // ensured lazily before every record, so a failure here is non-fatal.
      try { await invoke('coaching_scrim_dir', { base: uniq }); } catch {}
      setModal(null);
      await tree.refresh(SCRIM_BASE);
      nav('/game-wiki/' + encodePagePath(`${SCRIM_BASE}/${uniq}/Overview`));
    } catch (e) {
      setModal({ kind: 'new-scrim', err: String(e?.message || e) });
    }
  };

  const buttons = {
    new: { show: true, title: 'New Scrim', icon: <IconPlus/>, onClick: () => setModal({ kind: 'new-scrim' }) },
    collapse: { show: true },
    // reveal_in_files excludes the gamewiki root — coaching_reveal_path is the
    // gamewiki-rooted arm; revealing Deadlock/ lands the file manager at the root.
    revealInFiles: { show: true, onClick: () => invoke('coaching_reveal_path', { path: 'Deadlock' }).catch(() => {}) },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {h && <RailHeaderPill label={h.label} title={h.title} accent={accent} onClick={h.onClick} expanded={h.expanded !== false}/>}
      <div style={{ flexShrink: 0, padding: `8px 8px ${GAP}` }}>
        <TreeToolbar buttons={buttons} controller={tree} accent={accent}/>
      </div>
      <GameWikiTree route={route} accent={accent} tree={tree} nav={nav}
        onNewScrim={() => setModal({ kind: 'new-scrim' })}/>
      {modal?.kind === 'new-scrim' && (
        <NewScrimModal open error={modal.err} onCancel={() => setModal(null)} onSubmit={doCreate}/>
      )}
    </div>
  );
}

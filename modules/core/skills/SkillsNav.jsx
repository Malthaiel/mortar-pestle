// Skills Runner left sidebar — now the shared candy tree (TreeSidebar), matching
// the vault. The three fixed backend categories (SLASH / INGEST / TRANSCRIPTS) are
// the folders; skills are leaves (label = command, navigate to /tools/skills/<slug>,
// like the old SidebarNav). A running job shows a glowing accent dot in the row's
// trailing slot. New Skill / New Folder are cosmetic no-ops for now; Reveal in files
// opens the content-vault Infrastructure/Skills folder.

import { useMemo } from 'react';
import { navigate } from '@host/router.js';
import TreeSidebar from '@host/components/vault-tree/TreeSidebar.jsx';
import { useTreeExpansion, usePersistedState } from '@host/components/vault-tree/useTreeExpansion.js';
import { openInFiles } from '@host/components/vault-tree/revealInFiles.js';
import { useSkillsData, findSkillBySlug } from './SkillsProvider.jsx';

const CATEGORY_LABELS = { slash: 'SLASH', ingest: 'INGEST', transcripts: 'TRANSCRIPTS' };
const CATEGORY_ORDER = ['slash', 'ingest', 'transcripts'];
const SORT_MODES = [['name-asc', 'Name (A → Z)'], ['name-desc', 'Name (Z → A)']];

// Running-job marker — a small glowing accent dot in the leaf's trailing slot.
function RunningDot() {
  return <span aria-label="running" style={{
    width: 6, height: 6, borderRadius: 999, flexShrink: 0,
    background: 'var(--accent)',
    boxShadow: '0 0 0 2px color-mix(in oklch, var(--accent) 28%, transparent), 0 0 5px var(--accent)',
  }}/>;
}

function sortSkills(list, mode) {
  const dir = mode === 'name-desc' ? -1 : 1;
  return list.slice().sort((a, b) => dir * (a.command || a.slug).localeCompare(b.command || b.slug));
}

export default function SkillsNav({ route, accent }) {
  const { skills, runningJobs } = useSkillsData();
  const selectedSlug = route?.rest || null;
  const exp = useTreeExpansion('skills:tree:expanded', CATEGORY_ORDER);
  const [sortMode, setSortMode] = usePersistedState('skills:tree:sort', 'name-asc');

  const nodes = useMemo(() => (
    CATEGORY_ORDER
      .filter((cat) => skills[cat]?.length > 0)
      .map((cat) => ({
        id: cat,
        label: CATEGORY_LABELS[cat],
        isFolder: true,
        children: sortSkills(skills[cat], sortMode).map((s) => ({
          id: 'skill:' + s.slug,
          label: s.command,
          isFolder: false,
          active: s.slug === selectedSlug,
          onActivate: () => navigate('/tools/skills/' + encodeURIComponent(s.slug)),
          trailing: runningJobs[s.slug] ? <RunningDot/> : null,
        })),
      }))
  ), [skills, sortMode, selectedSlug, runningJobs]);

  const controller = {
    isOpen: exp.isOpen,
    toggle: exp.toggle,
    anyExpanded: exp.anyExpanded,
    expandAll: () => exp.expandAll(CATEGORY_ORDER),
    collapseAll: exp.collapseAll,
    sortMode, setSortMode, sortModes: SORT_MODES,
    canReveal: !!findSkillBySlug(skills, selectedSlug),
    revealCurrent: () => {
      const sel = findSkillBySlug(skills, selectedSlug);
      if (!sel) return;
      exp.reveal([sel.category]);
      setTimeout(() => {
        const el = document.querySelector('[data-current-file="true"]');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 280);
    },
  };

  const buttons = {
    new:           { show: true, title: 'New skill', onClick: () => {} },   // cosmetic for now
    newFolder:     { show: true, title: 'New folder', onClick: () => {} },  // cosmetic for now
    sort:          { show: true },
    collapse:      { show: true },
    revealCurrent: { show: true, title: 'Reveal current skill' },
    revealInFiles: { show: true, title: 'Reveal in files', onClick: () => openInFiles('Infrastructure/Skills') },
  };

  return <TreeSidebar nodes={nodes} controller={controller} buttons={buttons} accent={accent}/>;
}

// Planner left sidebar — the shared candy tree (TreeSidebar), same recipe as
// LibraryNav / DocsNav. Replaces the retired Pulse module's three-group
// SidebarNav (Planner Consolidation).
//
//   Dashboard          leaf   -> /planner            (calendar + day + health)
//   Planning           folder (expander only)
//     Calendar         leaf   -> /planner/calendar
//     Ideas            folder (expander only)
//       <page>         leaf   -> /page/Pulse/Ideas/<name>
//   Health             folder (expander only)
//     Nutrition        leaf   -> /planner/nutrition
//     Fitness          leaf   -> /planner/fitness
//
// Planning / Health / Ideas carry no onActivate on purpose — clicking them
// opens the folder, nothing more. Calendar / Nutrition / Fitness point at
// surfaces that already exist; they become fuller pages later.
//
// Daily logs get no group here by design: they're found by DATE (the DayPane's
// MiniMonthPicker) or browsed in the file tree, not listed in the sidebar.

import { useEffect, useMemo, useState } from 'react';
import { navigate } from '@host/router.js';
import { api, subscribeEvents } from '@host/api.js';
import TreeSidebar from '@host/components/vault-tree/TreeSidebar.jsx';
import { useTreeExpansion } from '@host/components/vault-tree/useTreeExpansion.js';
import { openInFiles } from '@host/components/vault-tree/revealInFiles.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import { writeSectionPage } from '@host/hooks/useSectionMemory.js';

const IDEAS_DIR = 'Pulse/Ideas';
// Every folder id, for expandAll.
const FOLDER_IDS = ['planning', 'planning:ideas', 'health'];

// Ideas folder listing. Same call PulseSidebar and IdeaPickerModal already make;
// re-reads whenever the vault manifest settles.
function useIdeaPages() {
  const [pages, setPages] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.getPulseFolder('Ideas')
        .then((r) => {
          if (cancelled) return;
          const list = (r?.pages || []).slice()
            .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
          setPages(list);
        })
        .catch(() => { if (!cancelled) setPages([]); });
    };
    load();
    const unsub = subscribeEvents((name) => { if (name === 'manifest') load(); });
    return () => { cancelled = true; unsub(); };
  }, []);

  return pages;
}

// The tree's notion of "what is selected" for the current route:
//   /planner            -> 'planner:dashboard'
//   /planner/<sub>      -> '/planner/<sub>'
//   /page/Pulse/Ideas/x -> 'Pulse/Ideas/x.md'
function selectedIdFor(route) {
  if (route?.page === 'planner') {
    return route.sub ? '/planner/' + route.sub : 'planner:dashboard';
  }
  if (route?.page === 'page' && typeof route?.sub === 'string' && route.sub.startsWith(IDEAS_DIR + '/')) {
    return route.sub.endsWith('.md') ? route.sub : route.sub + '.md';
  }
  return null;
}

export default function PlannerNav({ route, accent }) {
  const ideaPages = useIdeaPages();
  const exp = useTreeExpansion('planner:tree:expanded', ['planning']);
  const selectedId = selectedIdFor(route);

  const nodes = useMemo(() => {
    const leaf = (id, label, path, icon) => ({
      id, label, icon, isFolder: false,
      active: selectedId === id,
      onActivate: () => navigate(path),
    });
    const ideaLeaves = ideaPages.map((p) => ({
      id: p.path,
      label: p.title || p.name,
      isFolder: false,
      active: selectedId === p.path,
      onActivate: () => navigate('/page/' + encodePagePath(p.path)),
    }));
    return [
      leaf('planner:dashboard', 'Dashboard', '/planner', 'IconDashboard'),
      {
        id: 'planning', label: 'Planning', icon: 'IconChecklist', isFolder: true,
        children: [
          leaf('/planner/calendar', 'Calendar', '/planner/calendar', 'IconCalendar'),
          { id: 'planning:ideas', label: 'Ideas', icon: 'IconLightbulb', isFolder: true, children: ideaLeaves },
        ],
      },
      {
        id: 'health', label: 'Health', icon: 'IconHeartPulse', isFolder: true,
        children: [
          leaf('/planner/nutrition', 'Nutrition', '/planner/nutrition', 'IconForkKnife'),
          leaf('/planner/fitness', 'Fitness', '/planner/fitness', 'IconDumbbell'),
        ],
      },
    ];
  }, [ideaPages, selectedId]);

  const controller = {
    isOpen: exp.isOpen,
    toggle: exp.toggle,
    anyExpanded: exp.anyExpanded,
    expandAll: () => exp.expandAll(FOLDER_IDS),
    collapseAll: exp.collapseAll,
    canReveal: !!selectedId,
    revealCurrent: () => {
      if (!selectedId) return;
      // Open the ancestor chain of whatever is selected.
      if (selectedId.startsWith(IDEAS_DIR + '/')) exp.reveal(['planning', 'planning:ideas']);
      else if (selectedId === '/planner/calendar') exp.reveal(['planning']);
      else if (selectedId.startsWith('/planner/')) exp.reveal(['health']);
      setTimeout(() => {
        const el = document.querySelector('[data-current-file="true"]');
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 280);
    },
  };

  const buttons = {
    new:           { show: false },
    newFolder:     { show: false },
    sort:          { show: false },
    collapse:      { show: true },
    revealCurrent: { show: true, title: 'Reveal current' },
    // 'pulse' root -> the Pulse vault; the folder itself is still named Pulse/.
    revealInFiles: { show: true, title: 'Reveal in files',
      onClick: () => openInFiles('Pulse/Ideas', { isFolder: true, root: 'pulse' }) },
  };

  // Remember the last Planner page so dock-switching restores it.
  useEffect(() => { writeSectionPage('planner', selectedId); }, [selectedId]);

  return <TreeSidebar nodes={nodes} controller={controller} buttons={buttons} accent={accent}/>;
}

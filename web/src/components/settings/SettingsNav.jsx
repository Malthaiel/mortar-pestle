// Settings drawer left rail — the shared candy tree (TreeSidebar), replacing the
// old column of tab buttons AND every sub-tab strip (Settings Tree Navigation,
// 2026-09-28). A tab with a strip is a folder of its sections; Modules holds a
// folder per tier listing EVERY module in it, installed or not (the tier card
// pages retired the same day), each one its settings page, itself a folder when
// it has sections; right-click a module for Keybinds / Releases / Install or
// Uninstall. Then the Tools + Community pages. Releases holds the
// module-less Areas. Folders only unfold; leaves navigate. Built entirely from
// the registry (TAB_SECTIONS / PAGE_SECTIONS) + the drawer's own page map.
//
// Node ids ARE address keys (leafId), so the active row, the search filter and
// the reveal-on-navigate all read the drawer address directly.

import { useEffect, useMemo, useState } from 'react';
import TreeSidebar from '../vault-tree/TreeSidebar.jsx';
import { useTreeExpansion } from '../vault-tree/useTreeExpansion.js';
import { ICON_SIZE } from '../vault-tree/treeIcons.jsx';
import { hit } from '../vault-tree/treeSearch.js';
import { useContextMenu } from '../../context-menu/useContextMenu.js';
import { useManifests } from '../../module-sdk/useModuleRegistry.js';
import { useModuleEnabledMap, useDirtyModules, setModuleEnabled } from '../../hooks/useModuleEnabled.js';
import { useSidebarOrder, applyOrder } from '../../hooks/useSidebarOrder.js';
import { moduleIdForArea } from '../../hooks/useModuleAreas.js';
import { AREA_PALETTE } from '../../hooks/useReleaseQueue.js';
import { SETTINGS_DEFAULTS } from '../../hooks/useSettings.js';
import { getFullRegistry } from '../../keybinds/registry.js';
import { ModifiedDot } from '../ui/Topbar.jsx';
import { IconDownload, IconKeyboard, IconTag, IconTrash } from '../icons.jsx';
import { TAB_SECTIONS, PAGE_SECTIONS, tierOf, scopeFor, scopeModified, normalizeAddress } from './settings-registry.js';
import { ConfirmUninstall } from './ModulesTab.jsx';

const TIERS = [['core', 'Core'], ['studio', 'Studio'], ['widget', 'Widget']];
const sectionLabel = (id) => TAB_SECTIONS.modules.sections.find(s => s.id === id)?.label || id;

// The tree row an address lights. Tools / Community live at modules/tier/<id>;
// a module page is modules/<id>, or modules/<id>/<section> when it has a strip.
export function leafId(a) {
  if (!a?.tab) return null;
  if (a.tab === 'modules') {
    if (!a.page) return `modules/tier/${a.section || TAB_SECTIONS.modules.default}`;
    return PAGE_SECTIONS[a.page] ? `modules/${a.page}/${a.section}` : `modules/${a.page}`;
  }
  return a.section ? `${a.tab}/${a.section}` : a.tab;
}

function UpdateDot({ accent }) {
  return (
    <span aria-hidden title="Update available" style={{
      width: 7, height: 7, borderRadius: '50%', marginLeft: 6, flexShrink: 0,
      background: accent || 'var(--accent)',
      boxShadow: '0 0 0 2px var(--surface-2)',
      animation: 'newBadgePulse 2.5s ease-in-out infinite',
    }}/>
  );
}

export default function SettingsNav({
  tabs, addr, onNavigate, pagesByModuleId, settings, accent, updateDot,
  onOpenKeybinds, query, onQueryChange, onSearchKeyDown, searchRef, results,
}) {
  const manifests = useManifests();
  const enabledMap = useModuleEnabledMap();
  const dirty = useDirtyModules();
  const { openContextMenu } = useContextMenu();
  const exp = useTreeExpansion('settings:tree:expanded', []);
  const [confirmId, setConfirmId] = useState(null);
  // Tree order = each tier's saved order (from the retired card list's drag).
  const orders = {
    core:   useSidebarOrder('modules:tier-core').order,
    studio: useSidebarOrder('modules:tier-studio').order,
    widget: useSidebarOrder('modules:tier-widget').order,
  };
  const activeId = leafId(addr);

  // An uninstalled module keeps its row (its page says it is not installed);
  // right-click installs it again.
  const uninstall = (m) => setModuleEnabled(m.id, false);
  // Right-click a module row = what its old Modules card offered.
  const openAddonMenu = (e, m) => openContextMenu(e, [
    ...(getFullRegistry().some(k => k.group === m.name)
      ? [{ label: 'Keybinds', icon: IconKeyboard, onClick: () => onOpenKeybinds(m.name) }] : []),
    { label: 'Releases', icon: IconTag, onClick: () => onNavigate({ tab: 'modules', page: m.id, section: 'releases' }) },
    { sep: true },
    enabledMap[m.id] === false
      ? { label: 'Install', icon: IconDownload, onClick: () => setModuleEnabled(m.id, true) }
      : { label: 'Uninstall', icon: IconTrash, danger: true,
          onClick: () => (dirty.has(m.id) ? setConfirmId(m.id) : uninstall(m)) },
  ], { accent });

  const { nodes, parents, folderIds } = useMemo(() => {
    const leaf = (target, label, extra) => {
      const id = leafId(target);
      return { id, label, isFolder: false, active: id === activeId, onActivate: () => onNavigate(target), ...extra };
    };
    const dot = (target) => (scopeModified(scopeFor(target), settings, SETTINGS_DEFAULTS) ? <ModifiedDot/> : null);
    const iconOf = (t) => <span style={{ display: 'inline-flex', flexShrink: 0 }}><t.icon size={ICON_SIZE}/></span>;

    const addonNode = (m) => {
      const name = m.name || pagesByModuleId[m.id]?.label || m.id;
      const onContextMenu = (e) => openAddonMenu(e, m);
      const secs = PAGE_SECTIONS[m.id];
      // Settings that live on a host tab (agents → Agents) open that tab.
      if (!secs) return leaf({ tab: 'modules', page: m.id }, name, {
        onContextMenu, ...(m.settingsTarget && { onActivate: () => onNavigate(m.settingsTarget) }),
      });
      return {
        id: `modules/${m.id}`, label: name, isFolder: true, onContextMenu,
        children: secs.sections.map(s => leaf({ tab: 'modules', page: m.id, section: s.id }, s.label)),
      };
    };

    const modulesChildren = () => [
      ...TIERS.flatMap(([tier, label]) => {
        const inTier = Object.values(manifests).filter(m => tierOf(m) === tier)
          .sort((a, b) => a.name.localeCompare(b.name));
        // An empty tier (no widget modules exist yet) shows no folder.
        if (!inTier.length) return [];
        return [{ id: `modules:${tier}`, label, isFolder: true,
          children: applyOrder(inTier, orders[tier], m => m.id).map(addonNode) }];
      }),
      leaf({ tab: 'modules', section: 'tools' }, sectionLabel('tools')),
      leaf({ tab: 'modules', section: 'community' }, sectionLabel('community')),
    ];

    const nodes = tabs.map((t) => {
      const leadIcon = iconOf(t);
      const sysDot = t.id === 'system' && updateDot ? <UpdateDot accent={accent}/> : null;
      if (t.id === 'modules') return { id: 'modules', label: t.label, isFolder: true, leadIcon, children: modulesChildren() };
      if (t.id === 'releases') {
        const areas = AREA_PALETTE.filter(a => !moduleIdForArea(a, manifests));
        return { id: 'releases', label: t.label, isFolder: true, leadIcon,
          children: areas.map(a => leaf({ tab: 'releases', section: a }, a)) };
      }
      const strip = TAB_SECTIONS[t.id]?.sections;
      if (strip?.length) {
        return { id: t.id, label: t.label, isFolder: true, leadIcon, trailing: sysDot,
          children: strip.map(s => {
            const target = { tab: t.id, section: s.id };
            return leaf(target, s.label, { trailing: (t.id === 'system' && s.id === 'system' && sysDot) || dot(target) });
          }) };
      }
      return leaf({ tab: t.id, section: null }, t.label, { leadIcon });
    });

    // Every leaf's folder chain (for reveal) + every folder id (for Expand all).
    const parents = new Map();
    const folderIds = [];
    const walk = (list, chain) => list.forEach((n) => {
      if (n.isFolder) { folderIds.push(n.id); walk(n.children, [...chain, n.id]); }
      else parents.set(n.id, chain);
    });
    walk(nodes, []);
    return { nodes, parents, folderIds };
    // openAddonMenu / onNavigate are fresh closures each render; everything they
    // read is in this list, so the tree rebuilds whenever their output would change.
  }, [tabs, activeId, pagesByModuleId, manifests, enabledMap, dirty, settings, accent, updateDot, orders.core, orders.studio, orders.widget]);

  // Unfold the active row's folders whenever the address moves (deep link,
  // search jump, dock-gear open). Keyed on the row, not the tree, so collapsing
  // the folder you are in stays collapsed until you go somewhere else.
  const chain = parents.get(activeId);
  useEffect(() => { if (chain?.length) exp.reveal(chain); }, [activeId, !!chain]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search keeps the pages holding a matching setting, plus any row whose own
  // name matches.
  const matchIds = useMemo(() => new Set((results || []).map(e =>
    leafId(normalizeAddress({ tab: e.tabId, page: e.page ?? null, section: e.section ?? null })))), [results]);

  const controller = {
    isOpen: exp.isOpen,
    toggle: exp.toggle,
    anyExpanded: exp.anyExpanded,
    expandAll: () => exp.expandAll(folderIds),
    collapseAll: exp.collapseAll,
  };

  return (
    <>
      <TreeSidebar
        nodes={nodes}
        controller={controller}
        buttons={{ collapse: { show: true } }}
        accent={accent}
        search={{
          value: query, onChange: onQueryChange, onKeyDown: onSearchKeyDown,
          inputRef: searchRef, placeholder: 'Search settings',
          match: (n) => matchIds.has(n.id) || hit(n.label, query),
        }}
      />
      {confirmId && (
        <ConfirmUninstall
          manifest={manifests[confirmId]}
          accent={accent}
          onCancel={() => setConfirmId(null)}
          onConfirm={() => { uninstall(manifests[confirmId]); setConfirmId(null); }}
        />
      )}
    </>
  );
}

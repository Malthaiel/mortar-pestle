// Three-group secondary nav for the Pulse section. Surfaced inside the
// primary Sidebar's hover-overlay; no longer renders alongside main content.
//
//   PULSE       →  Today / Calendar / Recurring (interactive routes)
//   DAILY LOGS  →  Pulse/Daily Logs/*.md, default newest first
//   IDEAS       →  Pulse/Ideas/*.md, default alphabetical

import { useEffect, useState } from 'react';
import { api, subscribeEvents } from '../api.js';
import { SidebarNav, encodePagePath } from './SidebarBrowser.jsx';
import { useSidebarOrder, applyOrder } from '../hooks/useSidebarOrder.js';
import { writeSectionPage } from '../hooks/useSectionMemory.js';

export const PULSE_SIDEBAR_KEYS = {
  SECTIONS: 'Pulse:sections',
  DAILY_LOGS: 'Pulse/Daily Logs',
  IDEAS: 'Pulse/Ideas',
};

export const PULSE_SECTIONS = [
  { path: '/pulse/today',     name: 'today',     title: 'Today' },
  { path: '/pulse/calendar',  name: 'calendar',  title: 'Calendar' },
  { path: '/pulse/recurring', name: 'recurring', title: 'Recurring' },
];

function emptyData() {
  return { dailyLogs: null, ideas: null };
}

export function pickFirst(group) {
  if (!group || !group.items || group.items.length === 0) return null;
  return group.items[0];
}

function loadAll(setData) {
  Promise.all([
    api.getPulseFolder('Daily Logs').catch(() => null),
    api.getPulseFolder('Ideas').catch(() => null),
  ]).then(([dailyLogs, ideas]) => {
    setData({ dailyLogs, ideas });
  });
}

export function usePulseSidebarData() {
  const [data, setData] = useState(emptyData);

  useEffect(() => {
    loadAll(setData);
    const unsub = subscribeEvents((name) => {
      if (name === 'manifest') loadAll(setData);
    });
    return () => unsub();
  }, []);

  return data;
}

function defaultSortDailyLogs(pages) {
  return [...pages].sort((a, b) => b.name.localeCompare(a.name));
}
function defaultSortIdeas(pages) {
  return [...pages].sort((a, b) => a.name.localeCompare(b.name));
}

export function buildPulseGroups(data, orders) {
  const dailyLogPages = data.dailyLogs?.pages || [];
  const ideaPages = data.ideas?.pages || [];

  const sectionsOrdered = applyOrder(PULSE_SECTIONS, orders.sections, x => x.name);
  const dailyOrdered = applyOrder(defaultSortDailyLogs(dailyLogPages), orders.dailyLogs, p => p.name);
  const ideasOrdered = applyOrder(defaultSortIdeas(ideaPages), orders.ideas, p => p.name);

  return [
    { key: 'sections',   label: 'PULSE',      items: sectionsOrdered },
    { key: 'dailyLogs',  label: 'DAILY LOGS', items: dailyOrdered.map(p => ({ ...p, title: p.name })) },
    { key: 'ideas',      label: 'IDEAS',      items: ideasOrdered },
  ];
}

// Derives { groups, selectedPath, defaultExpandedKey, onSelect } from the
// current route. Pulse selects on either /pulse/<sub> or /page/Pulse/<...>.
function selectedPathFor(route) {
  if (route?.page === 'pulse' && route?.sub) return '/pulse/' + route.sub;
  if (route?.page === 'page' && typeof route?.sub === 'string' && route.sub.startsWith('Pulse/')) {
    const sub = route.sub.endsWith('.md') ? route.sub : route.sub + '.md';
    return sub;
  }
  return null;
}

function defaultExpandedKeyFor(selectedPath) {
  if (typeof selectedPath === 'string') {
    if (selectedPath.startsWith('Pulse/Daily Logs/')) return 'dailyLogs';
    if (selectedPath.startsWith('Pulse/Ideas/'))      return 'ideas';
    if (selectedPath.startsWith('/pulse/'))           return 'sections';
  }
  return 'sections';
}

export default function PulseNav({ route, accent }) {
  const data = usePulseSidebarData();
  const { order: sectionsOrder } = useSidebarOrder(PULSE_SIDEBAR_KEYS.SECTIONS);
  const { order: dailyOrder } = useSidebarOrder(PULSE_SIDEBAR_KEYS.DAILY_LOGS);
  const { order: ideasOrder } = useSidebarOrder(PULSE_SIDEBAR_KEYS.IDEAS);

  const groups = buildPulseGroups(data, {
    sections: sectionsOrder, dailyLogs: dailyOrder, ideas: ideasOrder,
  });

  const onSelect = (item) => {
    if (item.path.startsWith('/')) window.location.hash = item.path;
    else window.location.hash = '/page/' + encodePagePath(item.path);
  };

  const selectedPath = selectedPathFor(route);
  const defaultExpandedKey = defaultExpandedKeyFor(selectedPath);

  // Remember the last Pulse page so dock-switching restores it (falls back to
  // today's daily log when there's no valid memory). No-ops on null.
  useEffect(() => { writeSectionPage('pulse', selectedPath); }, [selectedPath]);

  return (
    <SidebarNav
      groups={groups}
      selectedPath={selectedPath}
      accent={accent}
      onSelect={onSelect}
      defaultExpandedKey={defaultExpandedKey}
    />
  );
}

import { useEffect, useState } from 'react';
import { subscribeEvents } from '../api.js';
import { useRouteSlots } from '../module-sdk/useModuleRegistry.js';
import { usePulseSidebarData, buildPulseGroups, PULSE_SIDEBAR_KEYS } from '../components/PulseSidebar.jsx';
import { useSidebarOrder } from '../hooks/useSidebarOrder.js';
import { itemHash, findItemByKey } from '../components/SidebarBrowser.jsx';
import { readSectionPage } from '../hooks/useSectionMemory.js';
import RecurringSection from './pulse/RecurringSection.jsx';
import { todayLocalStr } from '../util/time.js';

// Rendered when /pulse/calendar is hit but no module owns the route — i.e.
// the Planner module is uninstalled. The Pulse tab nav stays visible (it
// lives in the left rail), so the user can still navigate to recurring.
function EmptyCalendar() {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-muted)', fontSize: 13, padding: 24, textAlign: 'center',
    }}>
      Planner module not loaded — calendar view unavailable.
    </div>
  );
}

function replaceHash(newHash) {
  const base = window.location.href.split('#')[0];
  window.history.replaceState(null, '', base + '#' + newHash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// /pulse/today is a synonym for /page/Pulse/Daily Logs/<today>. The daily-log
// page renders via PageView's universal editor/reader; the redirect keeps
// existing sidebar links + bookmarks working.
const VALID_SUBS = new Set(['calendar', 'recurring']);

export default function PulsePage(props) {
  const { sub, accent, settings } = props;
  const [keys, setKeys] = useState({ recurring: 0 });
  const routeSlots = useRouteSlots();
  const pulseData = usePulseSidebarData();
  const { order: sectionsOrder } = useSidebarOrder(PULSE_SIDEBAR_KEYS.SECTIONS);
  const { order: dailyOrder } = useSidebarOrder(PULSE_SIDEBAR_KEYS.DAILY_LOGS);
  const { order: ideasOrder } = useSidebarOrder(PULSE_SIDEBAR_KEYS.IDEAS);

  const bump = (k) => setKeys(prev => ({ ...prev, [k]: prev[k] + 1 }));

  useEffect(() => {
    if (sub && VALID_SUBS.has(sub)) return;  // calendar/recurring render in place
    // Bare /pulse (dock-click) → restore the last Pulse page if it still maps to a
    // sidebar item. Explicit /pulse/today (and invalid subs) always go to today.
    if (!sub) {
      const remembered = readSectionPage('pulse');
      if (remembered) {
        // Wait for folder data before deciding so valid memory isn't clobbered.
        if (pulseData.dailyLogs === null && pulseData.ideas === null) return;
        const groups = buildPulseGroups(pulseData, {
          sections: sectionsOrder, dailyLogs: dailyOrder, ideas: ideasOrder,
        });
        const match = findItemByKey(groups, remembered);
        if (match) { replaceHash(itemHash(match)); return; }
      }
    }
    replaceHash('/page/' + encodeURIComponent('Pulse/Daily Logs/' + todayLocalStr()));
  }, [sub, pulseData, sectionsOrder, dailyOrder, ideasOrder]);

  useEffect(() => {
    const unsub = subscribeEvents((name) => {
      if (name === 'routine') bump('recurring');
    });
    return () => unsub();
  }, []);

  const nav = VALID_SUBS.has(sub) ? sub : null;
  if (!nav) return null;

  let inner;
  if (nav === 'calendar') {
    const slot = routeSlots.find(s => s.match('/pulse/calendar'));
    inner = slot ? slot.render({ route: '/pulse/calendar', params: {} }) : <EmptyCalendar/>;
  }
  else if (nav === 'recurring')  inner = <RecurringSection refetchKey={keys.recurring} accent={accent}/>;

  if (nav === 'calendar') return inner;
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
      <div style={{ maxWidth: 920, width: '100%', margin: '0 auto' }}>
        {inner}
      </div>
    </div>
  );
}

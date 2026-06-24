// Host-level reminder scheduler for Planner events. Mounted once in MainApp so
// reminders fire whether or not the Planner modal is open — but only while the
// app is running (accepted limitation; no OS-level scheduling). Scans the
// forward window of `## Upcoming` events on mount, on vault change events, and
// on a 60s tick, firing an `agentic:notify` toast + bell entry when an event's
// reminder lead-time has arrived. Fired reminders are de-duped via localStorage
// so a reminder fires at most once per (date, time, title).

import { useEffect, useRef } from 'react';
import { api, subscribeEvents } from '../api.js';
import { parseUpcomingSection, eventDateTime, reminderLeadToMin, keyForDate } from '../util/events.js';

const FIRED_KEY = 'planner:reminders:fired:v1';
const TICK_MS = 60000;

function loadFired() {
  try {
    const arr = JSON.parse(localStorage.getItem(FIRED_KEY) || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveFired(set) {
  try { localStorage.setItem(FIRED_KEY, JSON.stringify([...set].slice(-200))); } catch {}
}
function offsetKey(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return keyForDate(d);
}

export function useEventReminders(days = 21) {
  const firedRef = useRef(loadFired());

  useEffect(() => {
    let alive = true;

    async function scan() {
      try {
        const base = new Date();
        const dsList = Array.from({ length: days + 1 }, (_, i) => offsetKey(base, i));
        const sections = await Promise.all(
          dsList.map(ds => api.upcoming.readSection(ds).catch(() => ''))
        );
        if (!alive) return;
        const now = Date.now();
        dsList.forEach((ds, i) => {
          for (const ev of parseUpcomingSection(sections[i])) {
            if (!ev.reminderLead || !ev.start || !ev.title) continue;
            const lead = reminderLeadToMin(ev.reminderLead);
            if (lead == null) continue;
            const when = eventDateTime(ds, ev.start);
            if (!when) continue;
            const fireAt = when.getTime() - lead * 60000;
            const id = `${ds}|${ev.start}|${ev.title}`;
            if (firedRef.current.has(id)) continue;
            // Fire once the lead time has arrived, up to ~1 min past the event.
            if (now >= fireAt && now <= when.getTime() + 60000) {
              firedRef.current.add(id);
              saveFired(firedRef.current);
              const label = ev.typeName ? `${ev.typeName}: ${ev.title}` : ev.title;
              window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
                type: 'event-reminder',
                title: label,
                message: `${ev.time12 || ev.start} — upcoming`,
                iconKey: 'bell',
                duration: 9000,
              } }));
            }
          }
        });
      } catch { /* transient read errors are non-fatal; next tick retries */ }
    }

    scan();
    const timer = setInterval(scan, TICK_MS);
    const unsub = subscribeEvents((name) => {
      // 'today'/'day' cover daily-log edits; the 60s tick backstops external
      // changes. We skip the high-frequency 'manifest' event to avoid scanning
      // ~22 files on every unrelated vault change.
      if (name === 'today' || name === 'day') scan();
    });
    return () => { alive = false; clearInterval(timer); unsub(); };
  }, [days]);
}

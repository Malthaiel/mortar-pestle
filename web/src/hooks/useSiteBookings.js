// Bookings pull (Site Bridge, Phase 4). The other direction of useSitePush:
// confirmed malthaiel.com bookings become real events in the daily log's
// `## Upcoming`, so a paid session sits on the planner like anything else.
//
// Mounted in App beside useSitePush and gated on the SAME `sitePushEnabled`
// setting — one switch owns the whole bridge, both directions.
//
// Dedupe carries no side state: the bullet's note line ends in `#<first 8 of
// the booking id>`, and a day is skipped if its section already contains that
// tag. The vault is the record of what has been imported. Delete a bullet and
// the next poll puts it back, which is the right answer for a paid session.

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { api } from '../api.js';
import { keyForDate } from '../util/events.js';

const POLL_MS = 60 * 60 * 1000; // hourly, per the plan
const START_MS = 8000;          // let the app finish booting first

// Mirrors SERVICES in the site's src/services.js. A second copy on purpose:
// the app cannot import from the site repo, and a booking row carries only the
// id. If a service is renamed there, rename it here too.
const SERVICE_NAMES = {
  intro: 'Free intro call',
  live: 'Live coaching session',
  'vod-solo': 'VOD review — one player',
  'vod-team': 'VOD review — team',
  theory: 'Theory coaching',
  extended: 'Extended session',
  custom: 'Custom request',
};

function hm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// One booking row → { ds, tag, fields } ready for api.events.add. Times are
// stored UTC and rendered in his local zone, which is the zone the planner is
// written in.
export function bookingToEvent(row) {
  const start = new Date(row.start_ts);
  if (Number.isNaN(start.getTime())) return null;
  // ponytail: a session starting late enough to cross midnight prints an end
  // time earlier than its start. OPEN_HOURS ends at 23:00 so the worst case is
  // a 90-min booking ending 00:30. Split the bullet across days if it bites.
  const end = new Date(start.getTime() + (row.mins || 60) * 60000);
  const tag = `#${String(row.id).slice(0, 8)}`;
  const note = [row.client_name, row.client_discord && `@${row.client_discord}`, row.notes, tag]
    .filter(Boolean)
    .join(' · ');
  return {
    ds: keyForDate(start),
    tag,
    fields: {
      start: hm(start),
      end: hm(end),
      typeName: 'Coaching',
      title: SERVICE_NAMES[row.service_id] || row.service_id,
      note,
    },
  };
}

async function importBookings() {
  const rows = await invoke('site_fetch_bookings');
  if (!Array.isArray(rows) || !rows.length) return;

  // Past sessions are history, not agenda. Keep today's earlier ones visible.
  const floor = new Date();
  floor.setHours(0, 0, 0, 0);
  const events = rows
    .map(bookingToEvent)
    .filter(e => e && e.ds >= keyForDate(floor));
  if (!events.length) return;

  const sections = {};
  for (const ds of new Set(events.map(e => e.ds))) {
    sections[ds] = await api.upcoming.readSection(ds).catch(() => '');
  }

  // Sequential: api.events.add round-trips an mtime, so two adds racing on the
  // same day would lose one.
  for (const e of events) {
    if (sections[e.ds].includes(e.tag)) continue;
    await api.events.add(e.ds, e.fields);
    sections[e.ds] += `\n${e.tag}`; // two bookings, same day, same poll
  }
}

export function useSiteBookings(enabled) {
  const busyRef = useRef(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    const run = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await importBookings();
      } catch (e) {
        // Signed out, offline, or RLS said no — same silence as the push side.
        if (!cancelled) console.warn('site bookings pull failed', e);
      } finally {
        busyRef.current = false;
      }
    };

    const first = setTimeout(run, START_MS);
    const timer = setInterval(run, POLL_MS);
    return () => { cancelled = true; clearTimeout(first); clearInterval(timer); };
  }, [enabled]);
}

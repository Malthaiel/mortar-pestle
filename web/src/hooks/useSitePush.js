// Availability push (Site Bridge, Phase 2). Watches the planner's two schedule
// sources for the next 30 days and republishes the merged busy window to
// Supabase, so malthaiel.com's booking calendar can grey out the times he is
// genuinely unavailable — without ever learning what he is doing.
//
// Mounted once in App, beside useFeedbackNotifications. Gated on the
// `sitePushEnabled` setting (Settings → System) and OFF by default: nothing
// leaves the machine until he turns it on.
//
// Deliberately NOT built on useFrameForDates/useUpcomingWindow. Those hooks read
// eagerly on mount, and this feature spends its whole life switched off — a
// disabled push must cost zero file reads, which a conditional hook cannot do.
// It reuses their pure halves (mergeFrameForDate, parseUpcomingSection) instead.

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { api, subscribeEvents } from '../api.js';
import { keyForDate, weekdayForKey, parseUpcomingSection } from '../util/events.js';
import { mergeFrameForDate } from './useFrameForDate.js';
import { computeBusyRanges } from '../util/busyRanges.js';

// Booking horizon — must match BOOKING_RULES.horizonDays in the site's services.js.
const HORIZON_DAYS = 30;
// Planner edits arrive in bursts (drag a block, drop it, nudge it). Coalesce.
const DEBOUNCE_MS = 4000;

function windowDates(days) {
  const base = new Date();
  return Array.from({ length: days + 1 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    return keyForDate(d);
  });
}

async function collectBusyRanges() {
  const dates = windowDates(HORIZON_DAYS);
  const { frames } = await api.dailyFrame.read();
  // ponytail: 62 sequential-ish reads per push (one override + one log per day).
  // Fine behind a 4s debounce at ~a few pushes an hour; batch in Rust if the
  // push ever needs to be interactive.
  const [overrides, sections] = await Promise.all([
    Promise.all(dates.map(ds => api.dailyFrame.getOverride(ds).catch(() => ({})))),
    Promise.all(dates.map(ds => api.upcoming.readSection(ds).catch(() => ''))),
  ]);

  const perDay = {};
  const upcoming = [];
  dates.forEach((ds, i) => {
    const dayFrame = frames[weekdayForKey(ds).toLowerCase()] || [];
    perDay[ds] = mergeFrameForDate(dayFrame, overrides[i] || {}, ds);
    const events = parseUpcomingSection(sections[i]).filter(e => e.title);
    if (events.length) upcoming.push({ ds, events });
  });

  return computeBusyRanges({ perDay, upcoming });
}

export function useSitePush(enabled) {
  const timerRef = useRef(null);
  const lastRef = useRef(null); // last payload actually pushed, as JSON

  useEffect(() => {
    if (!enabled) {
      lastRef.current = null; // re-enabling must republish, even if nothing changed
      return undefined;
    }
    let cancelled = false;

    const push = async () => {
      try {
        const ranges = await collectBusyRanges();
        if (cancelled) return;
        const payload = JSON.stringify(ranges);
        if (payload === lastRef.current) return; // nothing moved — skip the round trip
        await invoke('site_push_busy', { ranges });
        if (!cancelled) lastRef.current = payload;
      } catch (e) {
        // Signed out, offline, or RLS said no. Silent by design: this is a
        // background sync, not something he asked for at this instant.
        console.warn('site push failed', e);
      }
    };

    const schedule = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(push, DEBOUNCE_MS);
    };

    schedule(); // app start (still debounced — the vault watcher fires early too)
    const unsub = subscribeEvents((name) => {
      if (name === 'day' || name === 'today' || name === 'schedule' || name === 'manifest') schedule();
    });

    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
      unsub();
    };
  }, [enabled]);
}

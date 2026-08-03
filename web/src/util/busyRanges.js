// Busy-range math for the malthaiel.com availability push (Site Bridge, Phase 2).
// Turns the planner's two schedule sources — recurring weekday frame segments and
// one-off `## Upcoming` events — into merged absolute UTC ranges.
//
// TIMES ONLY. Nothing here carries a title, note, or type: the destination table
// (`availability_busy`) is world-readable, so the site learns WHEN he is busy and
// never WHAT he is doing. Do not add a label field to the output.
//
// Pure and dep-free on purpose — `web/scripts/check-busy-ranges.mjs` imports it.

// An event with a start time but no end time. Matches the standard session length.
export const OPEN_EVENT_MINS = 60;
const DAY_MINS = 1440;

// "HH:MM" → minutes from local midnight. '24:00' is the frame end-of-day sentinel.
function toMins(hhmm) {
  if (hhmm === '24:00') return DAY_MINS;
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// { ds, s, e } in local minutes → sorted, merged, ISO-stamped ranges.
// The Date constructor normalizes minute overflow, so s/e may legitimately reach
// 1440 (= next local midnight) without special-casing.
function mergeSpans(spans) {
  const abs = spans
    .map(({ ds, s, e }) => {
      const [y, mo, d] = String(ds).split('-').map(Number);
      if ([y, mo, d].some(Number.isNaN)) return null;
      return [new Date(y, mo - 1, d, 0, s).getTime(), new Date(y, mo - 1, d, 0, e).getTime()];
    })
    .filter(r => r && r[1] > r[0])
    .sort((a, b) => a[0] - b[0]);

  const out = [];
  for (const [s, e] of abs) {
    const last = out[out.length - 1];
    // `s <= last[1]` merges touching ranges too (09:00–10:00 + 10:00–11:00 = one).
    if (last && s <= last[1]) { if (e > last[1]) last[1] = e; }
    else out.push([s, e]);
  }
  return out.map(([s, e]) => ({
    start_ts: new Date(s).toISOString(),
    end_ts: new Date(e).toISOString(),
  }));
}

/**
 * @param perDay  { [ds]: segment[] } from mergeFrameForDate — { start, end } 24h.
 * @param upcoming [{ ds, events }] from parseUpcomingSection — { start, end, time12, title }.
 * Returns [{ start_ts, end_ts }] in ISO UTC, sorted and non-overlapping.
 */
export function computeBusyRanges({ perDay = {}, upcoming = [], openEventMins = OPEN_EVENT_MINS } = {}) {
  const spans = [];

  for (const [ds, segments] of Object.entries(perDay)) {
    for (const seg of segments || []) {
      const s = toMins(seg.start);
      const e = toMins(seg.end);
      if (s == null || e == null || e <= s) continue; // midnight-crossers arrive pre-split
      spans.push({ ds, s, e });
    }
  }

  for (const { ds, events } of upcoming || []) {
    for (const ev of events || []) {
      if (!ev || !ev.title) continue;
      const s = toMins(ev.start);
      if (s == null) {
        if (/all day/i.test(ev.time12 || '')) spans.push({ ds, s: 0, e: DAY_MINS });
        continue;
      }
      const rawEnd = toMins(ev.end);
      let e;
      if (rawEnd == null) e = s + openEventMins;
      else if (rawEnd <= s) e = DAY_MINS;  // crosses midnight — block to end of day
      else e = rawEnd;
      spans.push({ ds, s, e: Math.min(e, DAY_MINS) });
    }
  }

  return mergeSpans(spans);
}

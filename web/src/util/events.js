// Shared event helpers for the Planner — the single source of truth for how a
// scheduled event is written into a daily log's `## Upcoming` section, parsed
// back for the agenda + reminder scheduler, and turned into an absolute time.
//
// Bullet format matches the daily-log time-range convention (cf. Focus Block
// "1:45 PM – 5:30 PM — Title"):
//   - {Weekday} {start} [– {end}] — {Type}: {Title} [⏰ {lead}] [([[link]])]
//     - {note}            (optional, indented sub-bullet)
//
// Times in the bullet are always 12-hour (daily-log human-readable convention);
// the calendar grid's 24h preference does not apply here.

import { parseStoredTo12h, combineTo24h } from './time.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Cycling reminder selectors for the New Event popup: a minutes/hours chip and a
// days chip, each advancing through its list on click. reminderLeadToMin already
// parses any \d+[mhd], so these values need no scheduler change.
export const MIN_REMINDERS = ['5m', '10m', '30m', '1h'];
export const DAY_REMINDERS = ['1d', '2d', '3d', '4d', '5d', '6d', '7d'];

// '5m' → '5 min', '1h' → '1 hr', '1d' → '1 day', '3d' → '3 days'. Falsy → 'None'.
export function reminderLabel(value) {
  const m = String(value || '').match(/^(\d+)([mhd])$/i);
  if (!m) return 'None';
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === 'm') return `${n} min`;
  if (unit === 'h') return `${n} hr`;
  return n === 1 ? '1 day' : `${n} days`;
}

export function reminderLeadToMin(lead) {
  if (!lead) return null;
  const m = String(lead).match(/^(\d+)\s*([mhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n;
}

function pad(n) { return String(n).padStart(2, '0'); }

// "YYYY-MM-DD" → Date at local midnight (avoids the UTC drift of new Date(str)).
export function dateFromKey(ds) {
  const [y, mo, d] = ds.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

export function keyForDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function weekdayForKey(ds) {
  return WEEKDAYS[dateFromKey(ds).getDay()];
}

// date key + "HH:MM" (24h) → absolute Date.
export function eventDateTime(ds, startHM) {
  if (!ds || !startHM) return null;
  const [y, mo, d] = ds.split('-').map(Number);
  const [hh, mm] = startHM.split(':').map(Number);
  if ([y, mo, d, hh, mm].some(Number.isNaN)) return null;
  return new Date(y, mo - 1, d, hh, mm);
}

function disp(hm) {
  const { display, meridiem } = parseStoredTo12h(hm);
  return `${display} ${meridiem}`;
}

// Build the `- ` event line + optional `  - note` line. start/end are 24h "HH:MM".
export function formatEventBullet({ ds, start, end, typeName, title, reminderLead, link, note, allDay }) {
  const weekday = weekdayForKey(ds);
  let timePart;
  if (allDay || !start) {
    timePart = 'All day';
  } else {
    timePart = disp(start);
    if (end && end !== start) timePart += ` – ${disp(end)}`;
  }
  const label = typeName ? `${typeName}: ${title}` : title;
  let line = `- ${weekday} ${timePart} — ${label}`;
  if (reminderLead) line += ` ⏰ ${reminderLead}`;
  if (link) line += ` ([[${link}]])`;
  const lines = [line];
  if (note && note.trim()) lines.push(`  - ${note.trim()}`);
  return lines.join('\n');
}

// Parse a top-level `- ` event line (still including the leading "- ") plus an
// optional indented note line. Returns a structured event; falls back to
// { raw, title } for freeform bullets that don't match our shape.
export function parseEventBullet(line, noteLine) {
  const note = noteLine ? noteLine.replace(/^\s*-\s+/, '').trim() : null;
  let body = line.replace(/^\s*-\s+/, '').trim();

  let link = null;
  const linkM = body.match(/\s*\(\[\[([^\]]+)\]\]\)\s*$/);
  if (linkM) { link = linkM[1]; body = body.slice(0, linkM.index).trim(); }

  let reminderLead = null;
  const remM = body.match(/\s*⏰\s*(\d+[mhd])\s*$/i);
  if (remM) { reminderLead = remM[1].toLowerCase(); body = body.slice(0, remM.index).trim(); }

  const dashIdx = body.indexOf(' — ');
  if (dashIdx === -1) {
    return { raw: body, title: body, typeName: null, start: null, end: null, time12: null, note, link, reminderLead };
  }
  const left = body.slice(0, dashIdx).trim();
  const right = body.slice(dashIdx + 3).trim();

  // Right side: "Type: Title" or bare "Title".
  let typeName = null;
  let title = right;
  const colon = right.indexOf(': ');
  if (colon > 0 && colon < 32) { typeName = right.slice(0, colon).trim(); title = right.slice(colon + 2).trim(); }

  // Left side: "{Weekday} {time} [– {time}]" — weekday optional.
  const times = [...left.matchAll(/(\d{1,2}:\d{2})\s*(AM|PM)/gi)].map(m => ({ d: m[1], mer: m[2].toUpperCase() }));
  let start = null;
  let end = null;
  let time12 = null;
  if (times.length) {
    start = combineTo24h(times[0].d, times[0].mer);
    if (times[1]) end = combineTo24h(times[1].d, times[1].mer);
    time12 = left.replace(/^[A-Za-z]{3,}\s+/, '').trim();
  } else if (/all day/i.test(left)) {
    time12 = 'All day';
  }
  return { raw: body, title, typeName, start, end, time12, note, link, reminderLead };
}

// Split a `## Upcoming` section's raw text into structured events. Top-level
// `- ` bullets are events; an immediately-following indented `- ` line is the
// preceding event's note.
export function parseUpcomingSection(text) {
  if (!text) return [];
  const rawLines = text.split('\n');
  const events = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (/^- /.test(rawLines[i])) {
      const next = rawLines[i + 1];
      const noteLine = next && /^\s{2,}-\s+/.test(next) ? next : null;
      events.push(parseEventBullet(rawLines[i], noteLine));
      if (noteLine) i++;
    }
  }
  return events;
}

// Repeat rules for Routine items — hand-rolled, no dependency (approved
// 2026-09-20). One entry point: `occursOn(item, ds)`.
//
// A rule lives FLAT on the item as scalar YAML fields, so `Pulse/Schedule.md`
// stays readable in Obsidian and the existing hand-rolled serializer needs
// nothing but the keys added to FRAME_FIELD_ORDER:
//
//   freq:     daily | weekly | monthly | monthlyNth | yearly
//   interval: every N of that unit (default 1)
//   weekday:  mon..sun    — weekly, monthlyNth
//   monthday: 1..31       — monthly, yearly
//   nth:      1..5 | -1   — monthlyNth (-1 = last of the month)
//   month:    1..12       — yearly
//   from:     YYYY-MM-DD  — the anchor every interval counts from, and the
//                           first date the rule can fire on
//
// An item with NO `freq` has no rule and never reaches here: it lives in its
// weekday drawer in the frames map and occurs on that weekday, exactly as
// before. Ruled items live in the one extra `any:` drawer beside the seven.

import { dateFromKey, weekdayForKey } from './events.js';

// getDay() is Sunday-indexed; the frames map's DAY_ORDER is Monday-first. This
// array is the getDay() one — do not sort it to match.
export const WEEKDAY_BY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DAY_MS = 86400000;

// Whole days between two local-midnight dates. Rounded because a DST boundary
// makes one of those "days" 23 or 25 hours long.
function daysBetween(a, b) {
  return Math.round((b - a) / DAY_MS);
}

function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function daysInMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

// Sunday of the week `d` falls in — the anchor every-N-weeks counts from, so
// the rhythm is the same whichever weekday `from` itself happened to be.
function startOfWeek(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
}

// "The 31st" in a 30-day month means the 30th, and "29 Feb" in a common year
// means the 28th. Clamping fires the rule every period; skipping would silently
// drop five months a year for a monthday of 31.
function clampDay(day, d) {
  return Math.min(day, daysInMonth(d));
}

// Which occurrence of its own weekday this date is (1st Tuesday, 3rd Friday…).
// nth === -1 asks for the LAST one, which is any date with under a week left.
function nthMatches(date, nth) {
  if (nth === -1) return date.getDate() + 7 > daysInMonth(date);
  return Math.floor((date.getDate() - 1) / 7) + 1 === nth;
}

// The item list for ONE date: that weekday's drawer, plus every ruled item in
// the `any` drawer that falls on it. This is the only place the two drawers are
// merged — both read paths (useRoutineItems for the tick list, useFrameForDates
// for the calendar) funnel through here, so a rule can never be honoured on one
// surface and ignored on the other.
export function itemsForDate(frames, ds) {
  if (!frames || !ds) return [];
  const dayKey = weekdayForKey(ds).toLowerCase();
  return [
    ...(frames[dayKey] || []),
    ...(frames.any || []).filter(b => occursOn(b, ds)),
  ];
}

export function hasRule(item) {
  return !!item?.freq;
}

// Does this ruled item fall on this date key? False for an item with no rule —
// callers keep those on the weekday path rather than asking here.
export function occursOn(item, ds) {
  const freq = item?.freq;
  if (!freq || !ds) return false;
  const date = dateFromKey(ds);
  if (Number.isNaN(date.getTime())) return false;

  const from = item.from ? dateFromKey(item.from) : null;
  if (from && Number.isNaN(from.getTime())) return false;
  if (from && date < from) return false;

  const n = Math.max(1, Number(item.interval) || 1);
  const weekday = item.weekday || (from ? WEEKDAY_BY_INDEX[from.getDay()] : null);
  const onWeekday = () => !weekday || WEEKDAY_BY_INDEX[date.getDay()] === weekday;

  switch (freq) {
    case 'daily':
      if (n === 1) return true;
      return !!from && daysBetween(from, date) % n === 0;

    case 'weekly':
      if (!onWeekday()) return false;
      if (n === 1) return true;
      return !!from && Math.floor(daysBetween(startOfWeek(from), date) / 7) % n === 0;

    case 'monthly': {
      const want = Number(item.monthday) || (from ? from.getDate() : 0);
      if (!want || date.getDate() !== clampDay(want, date)) return false;
      if (n === 1) return true;
      return !!from && monthsBetween(from, date) % n === 0;
    }

    case 'monthlyNth': {
      const nth = Number(item.nth) || 1;
      if (!weekday || !onWeekday() || !nthMatches(date, nth)) return false;
      if (n === 1) return true;
      return !!from && monthsBetween(from, date) % n === 0;
    }

    case 'yearly': {
      const wantMonth = Number(item.month) || (from ? from.getMonth() + 1 : 0);
      const wantDay = Number(item.monthday) || (from ? from.getDate() : 0);
      if (!wantMonth || !wantDay) return false;
      if (date.getMonth() + 1 !== wantMonth) return false;
      if (date.getDate() !== clampDay(wantDay, date)) return false;
      if (n === 1) return true;
      return !!from && (date.getFullYear() - from.getFullYear()) % n === 0;
    }

    default:
      return false;
  }
}

const DAY_NAMES = {
  sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
  thu: 'Thursday', fri: 'Friday', sat: 'Saturday',
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function ordinal(n) {
  if (n === -1) return 'last';
  const s = ['th', 'st', 'nd', 'rd'][(n % 100 - n % 10 !== 10) && n % 10 < 4 ? n % 10 : 0];
  return `${n}${s}`;
}

// One short human line for the chip and the repeat panel's trigger.
export function describeRule(item) {
  if (!hasRule(item)) return 'Does not repeat';
  const n = Math.max(1, Number(item.interval) || 1);
  const day = DAY_NAMES[item.weekday] || '';
  switch (item.freq) {
    case 'daily':
      return n === 1 ? 'Daily' : `Every ${n} days`;
    case 'weekly':
      return n === 1 ? `Weekly on ${day}` : `Every ${n} weeks on ${day}`;
    case 'monthly':
      return n === 1
        ? `Monthly on the ${ordinal(Number(item.monthday) || 1)}`
        : `Every ${n} months on the ${ordinal(Number(item.monthday) || 1)}`;
    case 'monthlyNth':
      return n === 1
        ? `Monthly on the ${ordinal(Number(item.nth) || 1)} ${day}`
        : `Every ${n} months on the ${ordinal(Number(item.nth) || 1)} ${day}`;
    case 'yearly': {
      const mo = MONTH_NAMES[(Number(item.month) || 1) - 1];
      const d = Number(item.monthday) || 1;
      return n === 1 ? `Yearly on ${mo} ${d}` : `Every ${n} years on ${mo} ${d}`;
    }
    default:
      return 'Does not repeat';
  }
}

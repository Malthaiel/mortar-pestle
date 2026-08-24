// Daily-frame helpers, ported from the former FrameEditorModal so the
// on-calendar Frame Edit Mode (CalendarPane) and any future consumer share one
// source for id-slugging, per-day validation, and weekday copy.

// Monday-first weekday ordering + weekday/weekend subsets (the copy actions).
export const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const WEEKEND_KEYS = ['sat', 'sun'];

// HH:MM (24h) or the 24:00 end-of-day sentinel.
export const TIME_RE = /^(([01]?\d|2[0-3]):[0-5]\d|24:00)$/;

export function slugify(s) {
  return String(s)
    .toLowerCase().trim()
    .replace(/&/g, 'and')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// True when a routine item carries a time range (and therefore paints on the
// calendar). An item with NEITHER start nor end is untimed — a repeating task
// that only ever appears in the Routine tick list. See isUntimed below.
export function isTimed(b) {
  return !!(b && b.start && b.end);
}
// An item is untimed only when BOTH ends are blank. One-of-two is a half-filled
// row, which validateDay rejects rather than silently dropping to untimed.
export function isUntimed(b) {
  return !!b && !b.start && !b.end;
}

// Per-day row validation → { [rowIdx]: [msgs] } (clean days → {}). Empty days
// are allowed; ids must be unique WITHIN a day (the same id across days is
// expected).
//
// Times are OPTIONAL (Planner Consolidation — Frame and Recurring merged into
// one Routine item). Both blank = an untimed repeating task. Both set = the
// old frame block, same rules as before. Exactly one set is an error.
export function validateDay(list) {
  const errors = {};
  const ids = new Set();
  (list || []).forEach((b, i) => {
    const e = [];
    if (!b.name || !b.name.trim()) e.push('Name required');
    if (!isUntimed(b)) {
      if (!TIME_RE.test(b.start || '')) e.push('Start must be HH:MM (24h)');
      if (!TIME_RE.test(b.end || '')) e.push('End must be HH:MM (24h)');
      if (TIME_RE.test(b.start) && TIME_RE.test(b.end) && b.start === b.end) {
        e.push('Zero-duration not allowed');
      }
    }
    const id = b.id || slugify(b.name || '');
    if (id) {
      if (ids.has(id)) e.push(`Duplicate id "${id}"`);
      ids.add(id);
    } else if (b.name?.trim()) {
      e.push('Name produced empty id (use ASCII letters)');
    }
    if (e.length > 0) errors[i] = e;
  });
  return errors; // { [rowIdx]: [msgs] }
}

// Deep-copy one day's block list into target days, returning a NEW frames map.
// Days stay independent afterward (a fresh object per block per target).
export function copyDayToTargets(frames, srcDay, targetDays) {
  const src = (frames[srcDay] || []);
  const next = { ...frames };
  for (const d of targetDays) next[d] = src.map(b => ({ ...b }));
  return next;
}

// A slug id for `name`, made unique within `list` by suffixing -2, -3, … .
export function makeUniqueId(list, name) {
  const base = slugify(name) || 'block';
  const taken = new Set((list || []).map(b => b.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

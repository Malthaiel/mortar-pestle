function pad(n) { return String(n).padStart(2, '0'); }

export function fmtTimeOfDay(date, use24h) {
  const h = date.getHours();
  const m = date.getMinutes();
  if (use24h) return `${pad(h)}:${pad(m)}`;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${period}`;
}

export function fmtHourLabel(h, use24h) {
  if (use24h) return `${pad(h)}:00`;
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

export function fmtHHMMFromHM(h, m, use24h) {
  if (use24h) return `${pad(h)}:${pad(m)}`;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${period}`;
}

// Compact wall-clock for tight spots (e.g. the calendar now-pill in the 44px
// gutter): drops the AM/PM suffix in 12h mode so the longest label is "12:34"
// (5 chars) rather than "12:34 PM" — the gutter hour labels already give the
// AM/PM context.
export function fmtClockCompact(h, m, use24h) {
  if (use24h) return `${pad(h)}:${pad(m)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)}`;
}

export function fmtHHMMString(timeStr, use24h) {
  if (!timeStr || use24h) return timeStr || '';
  if (timeStr === '24:00') return '12:00 AM';
  const [hStr, mStr] = timeStr.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return timeStr;
  return fmtHHMMFromHM(h, m, use24h);
}

const TIME_RE_24 = /^(([01]?\d|2[0-3]):[0-5]\d|24:00)$/;
const TIME_RE_12 = /^(0?[1-9]|1[0-2]):[0-5]\d$/;

// "07:30" -> { display: "7:30",  meridiem: "AM", endOfDay: false }
// "19:30" -> { display: "7:30",  meridiem: "PM", endOfDay: false }
// "00:15" -> { display: "12:15", meridiem: "AM", endOfDay: false }
// "12:00" -> { display: "12:00", meridiem: "PM", endOfDay: false }
// "24:00" -> { display: "12:00", meridiem: "AM", endOfDay: true  }
export function parseStoredTo12h(stored) {
  if (!stored || !TIME_RE_24.test(stored)) {
    return { display: stored || '', meridiem: 'AM', endOfDay: false };
  }
  if (stored === '24:00') return { display: '12:00', meridiem: 'AM', endOfDay: true };
  const [hStr, mStr] = stored.split(':');
  const h = parseInt(hStr, 10);
  const meridiem = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { display: `${h12}:${mStr}`, meridiem, endOfDay: false };
}

// (display12 string, meridiem) -> "HH:MM" 24h string, or null if input invalid.
export function combineTo24h(display12, meridiem) {
  if (!TIME_RE_12.test(display12)) return null;
  const [hStr, mStr] = display12.split(':');
  let h = parseInt(hStr, 10);
  if (meridiem === 'AM') h = (h === 12 ? 0 : h);
  else                   h = (h === 12 ? 12 : h + 12);
  return `${pad(h)}:${mStr}`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = (Date.now() - then) / 1000;
  if (diff < 60)       return `${Math.max(0, Math.floor(diff))}s ago`;
  if (diff < 3600)     return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)    return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400*7)  return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400*30) return `${Math.floor(diff / (86400*7))}w ago`;
  return `${Math.floor(diff / (86400*30))}mo ago`;
}

// Local "today" as a YYYY-MM-DD string (Swedish locale = ISO-like, local TZ).
export function todayLocalStr() {
  return new Date().toLocaleDateString('sv-SE');
}

// Date -> "YYYY-MM-DD" local date key (matches the calendar's dateKeys).
export function dateToKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Calendar-day difference a − b (both "YYYY-MM-DD"), positive when a is later.
// UTC-based so a DST boundary never shifts the count.
export function daysDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
}

// Add n days to a "YYYY-MM-DD" string, returning "YYYY-MM-DD".
export function addDays(ds, n) {
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Minutes-from-midnight -> "HH:MM" (hours wrap at 24 for the calendar grid).
export function minsToHM(m) {
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}

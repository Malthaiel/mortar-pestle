// Note half of the per-match Run Process (Deadlock Scrim Coaching, sub-plan 3).
// Pure ESM (no React, no @host) so it round-trips through a Node harness exactly
// like matchData.js / scrimSchema.js. Parses the coached team's hand-tagged notes
// into chess.com-style classifications, compiles them into counts + grouped
// buckets, and serializes the result into the opaque `### Coaching Summary`
// subsection. Mirrors the data-half logic in matchData.js.

import { clock } from './matchData.js';

// Classification taxonomy — the chess.com Game Review set, in stable display order.
// confirm-at-build → confirmed full chess.com set (AskUserQuestion, 2026-06-17).
export const CLASSIFICATIONS = [
  'Brilliant', 'Great', 'Best', 'Excellent', 'Good', 'Book',
  'Inaccuracy', 'Mistake', 'Miss', 'Blunder', 'Forced',
];

// Multi-word tag aliases → canonical label. Longest-match wins (see MATCHERS sort).
// `Best Move` / `Great Move` are chess.com's long-form labels for the `Best` / `Great` badges.
const ALIASES = { 'Best Move': 'Best', 'Great Move': 'Great' };

const MARKER = '_(Run-Process-owned, regenerated)_';

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One regex per tag word, sorted longest-first so `Best Move` is tested before
// `Best`. A bullet matches when it leads with the tag word + a `:` or `-`
// separator (case-insensitive); the remainder is the note text.
const MATCHERS = [
  ...CLASSIFICATIONS.map((c) => ({ word: c, canonical: c })),
  ...Object.entries(ALIASES).map(([word, canonical]) => ({ word, canonical })),
]
  .sort((a, b) => b.word.length - a.word.length)
  .map(({ word, canonical }) => ({
    canonical,
    re: new RegExp(`^\\s*(${escapeRe(word)})\\s*[:-]\\s*(.*)$`, 'i'),
  }));

// Parse one bullet (the clean text scrimSchema.parseScrim already stripped of its
// leading `- `) into { classification, text }. No recognized tag → classification null.
export function parseNote(bullet) {
  const raw = String(bullet ?? '');
  for (const { canonical, re } of MATCHERS) {
    const m = re.exec(raw);
    if (m) return { classification: canonical, text: m[2] };
  }
  return { classification: null, text: raw };
}

// A leading `[m:ss]` token stamped onto a note bullet by the Notes timer (sub-plan 5).
// 1–2 digit minutes + 2-digit seconds; anything else is plain text (no prefix).
export const TIME_PREFIX_RE = /^\[(\d{1,2}):([0-5]\d)\]\s*/;

// "7:42" → 462 seconds; null when not a clean m:ss.
export function secFromClock(str) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(str ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Split a bullet into its optional leading timestamp + the rest, then parse the rest
// for a classification tag → { atSec, at, classification, text }. The time token is
// stripped BEFORE parseNote so it never collides with the `Label:` matcher.
export function parseTimedNote(bullet) {
  const raw = String(bullet ?? '');
  const tm = TIME_PREFIX_RE.exec(raw);
  let atSec = null, at = null, rest = raw;
  if (tm) { atSec = Number(tm[1]) * 60 + Number(tm[2]); at = `${Number(tm[1])}:${tm[2]}`; rest = raw.slice(tm[0].length); }
  const { classification, text } = parseNote(rest);
  return { atSec, at, classification, text };
}

// Inverse of parseTimedNote: compose a bullet string from parts. Round-trips —
// parseTimedNote(formatTimedBullet(x)) recovers x. atSec null → no time prefix.
export function formatTimedBullet({ atSec = null, classification = null, text = '' } = {}) {
  const t = String(text ?? '').trim();
  const body = classification ? (t ? `${classification}: ${t}` : `${classification}:`) : t;
  return atSec == null ? body : `[${clock(atSec)}] ${body}`;
}

// Stable sort by in-game seconds ascending; untimed (getSec → null/NaN) grouped at
// the END preserving original order. Returns { ordered, untimedCount }.
export function sortByTimeAsc(items, getSec) {
  const timed = [], untimed = [];
  (items || []).forEach((it, i) => {
    const s = getSec(it);
    if (s == null || !Number.isFinite(s)) untimed.push({ it, i });
    else timed.push({ it, i, s });
  });
  timed.sort((a, b) => (a.s - b.s) || (a.i - b.i));
  return { ordered: [...timed, ...untimed].map((x) => x.it), untimedCount: untimed.length };
}

// Parsed bullets for the compiler — time prefix stripped so it never leaks into the
// Coaching Summary. Shape unchanged ({ classification, text }) for compileNotes.
export function parseNotes(bullets) {
  return (bullets || []).map((b) => { const { classification, text } = parseTimedNote(b); return { classification, text }; });
}

// Light cleanup ONLY: trim, collapse internal whitespace, capitalize first letter.
// Never reword, reorder, summarize, or reclassify.
function cleanupText(s) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

// Compile parsed bullets into counts + grouped buckets in taxonomy order, empty
// buckets dropped, unclassified last. Within a bucket, first-seen order is kept.
export function compileNotes(bullets) {
  const buckets = new Map(); // canonical → [text…]
  const unclassified = [];
  for (const { classification, text } of parseNotes(bullets)) {
    const clean = cleanupText(text);
    if (classification) {
      if (!buckets.has(classification)) buckets.set(classification, []);
      buckets.get(classification).push(clean); // keep deliberate tags even if text is empty
    } else if (clean) {
      unclassified.push(clean);
    }
  }
  const groups = [];
  const counts = [];
  for (const label of CLASSIFICATIONS) {
    const notes = buckets.get(label);
    if (notes && notes.length) {
      groups.push({ classification: label, notes });
      counts.push({ label, n: notes.length });
    }
  }
  return { counts, groups, unclassified };
}

// Serialize a compiled structure to the markdown body of `### Coaching Summary`.
// Header is count-suffix (`Blunder ×3 · Best ×2`), classified only; then a
// `#### <classification>` mini-section per non-empty bucket; unclassified last.
export function renderCoachingSummary(compiled) {
  const { counts, groups, unclassified } = compiled;
  const lines = [];
  if (counts.length) {
    lines.push(counts.map(({ label, n }) => `${label} ×${n}`).join(' · '), '');
  }
  for (const { classification, notes } of groups) {
    lines.push(`#### ${classification}`);
    for (const t of notes) lines.push(`- ${t}`);
    lines.push('');
  }
  if (unclassified.length) {
    lines.push('#### Unclassified');
    for (const t of unclassified) lines.push(`- ${t}`);
    lines.push('');
  }
  if (!counts.length && !unclassified.length) lines.push('_(No notes to compile.)_', '');
  lines.push(MARKER);
  return lines.join('\n');
}

// Set the `### Coaching Summary` opaque body on match n — replace if present,
// append if absent. Exact mirror of setMatchDataBody in matchData.js (disk-owned
// region; Run Process writes it straight to disk through serializeScrim).
export function setCoachingSummaryBody(scrim, n, body) {
  return {
    ...scrim,
    matches: (scrim.matches || []).map((mm) => {
      if (mm.n !== n) return mm;
      const subs = mm.subsections || [];
      const has = subs.some((s) => s.kind === 'opaque' && s.heading === 'Coaching Summary');
      return {
        ...mm,
        subsections: has
          ? subs.map((s) => (s.kind === 'opaque' && s.heading === 'Coaching Summary' ? { ...s, body } : s))
          : [...subs, { kind: 'opaque', heading: 'Coaching Summary', body }],
      };
    }),
  };
}

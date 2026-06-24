// Daily-log Fitness parsers (Health Column, sub-plans 4–5). JS parity with the
// Rust `parsers/health.rs` parse_workout / parse_cardio — the day read is JS-side
// (api.health.readDay); the Rust copies exist for any future Rust reader.
//
// Grammar (locked): `—` U+2014 name/target · `→` U+2192 target/actual · `×`
// U+00D7 sets×reps. Each H2 is scanned independently like the Nutrition log;
// an absent section yields null / []. `@weight` stops before the arrow
// (`[^→]+?`) so a trailing `→ actual` isn't swallowed. Shapes match the Rust
// serde contract (snake `day_label`, cardio `type`) so a parsed entry can be
// sent straight back as a write payload with no remapping.

const EX_RE = /^- \[([ xX])\] (.+?) — (\d+)×([^\s@→]+)(?: @([^→]+?))?(?: → (.+))?$/;
const DAY_RE = /^###\s+(.+?)\s*$/;
const CARDIO_RE = /^- \[([ xX])\] (.+?) — (\d+)m(?: \(([^)]+)\))?(?: → (.+))?$/;

// Parse the `## Workout` section → the day's WorkoutLogEntry, or null when the
// section is absent/empty (one workout block per day; the first `### Label` wins).
export function parseWorkoutLog(content) {
  let inSection = false;
  let entry = null;
  for (const line of (content || '').split('\n')) {
    const trim = line.trim();
    if (trim === '## Workout') { inSection = true; continue; }
    if (!inSection) continue;
    if (trim.startsWith('## ')) break;
    const d = trim.match(DAY_RE);
    if (d) {
      if (!entry) entry = { day_label: d[1].trim(), exercises: [] };
      continue;
    }
    const m = line.match(EX_RE);
    if (m) {
      if (!entry) entry = { day_label: '', exercises: [] };
      entry.exercises.push({
        name: m[2].trim(),
        sets: parseInt(m[3], 10) || 0,
        reps: m[4],
        weight: m[5] ? m[5].trim() : null,
        done: m[1] !== ' ',
        actual: m[6] ? m[6].trim() : null,
      });
    }
  }
  return entry;
}

// Parse the `## Cardio` section → CardioLogEntry[] (absent → []).
export function parseCardioLog(content) {
  let inSection = false;
  const out = [];
  for (const line of (content || '').split('\n')) {
    const trim = line.trim();
    if (trim === '## Cardio') { inSection = true; continue; }
    if (!inSection) continue;
    if (trim.startsWith('## ')) break;
    const m = line.match(CARDIO_RE);
    if (m) {
      out.push({
        type: m[2].trim(),
        minutes: parseInt(m[3], 10) || 0,
        zone: m[4] ? m[4].trim() : null,
        done: m[1] !== ' ',
        actual: m[5] ? m[5].trim() : null,
      });
    }
  }
  return out;
}

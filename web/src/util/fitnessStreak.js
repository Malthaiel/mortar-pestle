// Fitness streak math (Health Column epic, sub-plan 6). Pure — no React, no IPC.
// Consumes the useHealthHistory day shape ([{ ds, workout, cardio, … }], today
// first) and a per-day rest predicate from useTodayWorkout's resolver.
//
// A day is ACTIVE if any workout exercise OR any cardio segment is `done`. A REST
// day with no completed work is a NEUTRAL skip — it neither extends nor breaks the
// streak (you can't "miss" a planned rest). Any OTHER work-less day breaks the run.
// The leading day (today) is special: an empty NON-rest today is "in progress", not
// a break, so the counter doesn't drop to 0 before you've trained today.

function hasCompletedWork(d) {
  const w = !!d?.workout?.exercises?.some((e) => e.done);
  const c = (d?.cardio || []).some((s) => s.done);
  return w || c;
}

// classify a day → 'active' | 'neutral' | 'break'
function classify(d, isRestDs) {
  if (hasCompletedWork(d)) return 'active';
  return isRestDs(d.ds) ? 'neutral' : 'break';
}

// computeFitnessStreak(days, { isRestDs }) → { current, longest, lastActiveDs }.
// `isRestDs(ds)` → true when that calendar day is a rest day under the active split
// (default: nothing is a rest day). Returns zeros + null when there's no history.
export function computeFitnessStreak(days, opts = {}) {
  const isRestDs = opts.isRestDs || (() => false);
  const sorted = (days || [])
    .filter((d) => d && d.ds)
    .slice()
    .sort((a, b) => (a.ds < b.ds ? 1 : a.ds > b.ds ? -1 : 0)); // descending, today first

  // current: walk back from today. A leading empty non-rest day (today, not done
  // yet) is treated as in-progress (neutral), never a break.
  let current = 0;
  for (let i = 0; i < sorted.length; i++) {
    let cls = classify(sorted[i], isRestDs);
    if (i === 0 && cls === 'break') cls = 'neutral';
    if (cls === 'active') current++;
    else if (cls === 'neutral') continue;
    else break;
  }

  // longest: scan the whole window; neutral days continue a run without counting,
  // a break resets it.
  let longest = 0, run = 0;
  for (const d of sorted) {
    const cls = classify(d, isRestDs);
    if (cls === 'active') { run++; if (run > longest) longest = run; }
    else if (cls === 'neutral') continue;
    else run = 0;
  }

  let lastActiveDs = null;
  for (const d of sorted) { if (hasCompletedWork(d)) { lastActiveDs = d.ds; break; } }

  return { current, longest, lastActiveDs };
}

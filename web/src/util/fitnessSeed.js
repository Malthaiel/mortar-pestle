// Default Fitness library content (Health Column, sub-plans 4–5). Seeded by
// useWorkoutSplits / useCardioPresets when the Library folder is EMPTY — the
// locked self-heal behavior (clear the library → a fresh starter set returns on
// next open). All weights are null (the user fills their own); every split ships
// inactive (the first-run UX prompts "Choose a split"). Fixed ids keep a re-seed
// from colliding with itself. Everything here is fully editable in-app.

const ex = (name, sets, reps) => ({ name, sets, reps, weight: null });

export const DEFAULT_SPLITS = [
  {
    id: 'split-seed-ppl',
    name: 'Push / Pull / Legs',
    cycle: ['Push', 'Pull', 'Legs', 'Rest'],
    active: false,
    anchorDate: null,
    anchorIndex: 0,
    days: {
      Push: [ex('Bench Press', 4, 8), ex('Overhead Press', 3, 10), ex('Incline DB Press', 3, 12), ex('Triceps Pushdown', 3, 15), ex('Lateral Raise', 3, 15)],
      Pull: [ex('Deadlift', 3, 5), ex('Pull-Up', 4, 8), ex('Barbell Row', 4, 10), ex('Face Pull', 3, 15), ex('Barbell Curl', 3, 12)],
      Legs: [ex('Back Squat', 4, 8), ex('Romanian Deadlift', 3, 10), ex('Leg Press', 3, 12), ex('Leg Curl', 3, 12), ex('Calf Raise', 4, 15)],
      Rest: [],
    },
  },
  {
    id: 'split-seed-ul',
    name: 'Upper / Lower',
    cycle: ['Upper', 'Lower', 'Rest'],
    active: false,
    anchorDate: null,
    anchorIndex: 0,
    days: {
      Upper: [ex('Bench Press', 4, 6), ex('Barbell Row', 4, 8), ex('Overhead Press', 3, 10), ex('Lat Pulldown', 3, 12), ex('Curl', 3, 12)],
      Lower: [ex('Back Squat', 4, 6), ex('Romanian Deadlift', 3, 8), ex('Leg Press', 3, 12), ex('Leg Curl', 3, 12), ex('Calf Raise', 4, 15)],
      Rest: [],
    },
  },
  {
    id: 'split-seed-fb',
    name: 'Full Body',
    cycle: ['Full Body', 'Rest'],
    active: false,
    anchorDate: null,
    anchorIndex: 0,
    days: {
      'Full Body': [ex('Back Squat', 3, 5), ex('Bench Press', 3, 5), ex('Barbell Row', 3, 8), ex('Overhead Press', 3, 8), ex('Romanian Deadlift', 3, 8)],
      Rest: [],
    },
  },
  {
    id: 'split-seed-arnold',
    name: 'Arnold Split',
    cycle: ['Chest & Back', 'Shoulders & Arms', 'Legs', 'Rest'],
    active: false,
    anchorDate: null,
    anchorIndex: 0,
    days: {
      'Chest & Back': [ex('Bench Press', 4, 8), ex('Incline DB Press', 3, 10), ex('Barbell Row', 4, 8), ex('Pull-Up', 3, 10), ex('Pullover', 3, 12)],
      'Shoulders & Arms': [ex('Overhead Press', 4, 8), ex('Lateral Raise', 4, 12), ex('Barbell Curl', 3, 10), ex('Skull Crusher', 3, 10), ex('Hammer Curl', 3, 12)],
      Legs: [ex('Back Squat', 4, 8), ex('Leg Press', 3, 12), ex('Leg Curl', 3, 12), ex('Calf Raise', 4, 15)],
      Rest: [],
    },
  },
  {
    id: 'split-seed-bro',
    name: 'Bro Split',
    cycle: ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Rest', 'Rest'],
    active: false,
    anchorDate: null,
    anchorIndex: 0,
    days: {
      Chest: [ex('Bench Press', 4, 8), ex('Incline DB Press', 3, 10), ex('Cable Fly', 3, 15), ex('Dips', 3, 12)],
      Back: [ex('Deadlift', 3, 5), ex('Pull-Up', 4, 8), ex('Barbell Row', 4, 10), ex('Lat Pulldown', 3, 12)],
      Shoulders: [ex('Overhead Press', 4, 8), ex('Lateral Raise', 4, 15), ex('Rear Delt Fly', 3, 15), ex('Shrug', 3, 12)],
      Arms: [ex('Barbell Curl', 4, 10), ex('Skull Crusher', 4, 10), ex('Hammer Curl', 3, 12), ex('Triceps Pushdown', 3, 15)],
      Legs: [ex('Back Squat', 4, 8), ex('Romanian Deadlift', 3, 10), ex('Leg Press', 3, 12), ex('Calf Raise', 4, 15)],
      Rest: [],
    },
  },
  {
    id: 'split-seed-custom',
    name: 'Custom',
    cycle: ['Day 1', 'Rest'],
    active: false,
    anchorDate: null,
    anchorIndex: 0,
    days: { 'Day 1': [], Rest: [] },
  },
];

export const DEFAULT_CARDIO = [
  {
    id: 'cardio-seed-zone2',
    name: 'Zone 2',
    sequence: [{ type: 'Zone 2', duration: 30, zone: 'Z2' }],
  },
  {
    id: 'cardio-seed-hiit',
    name: 'HIIT',
    sequence: [
      { type: 'Warmup', duration: 5, zone: 'Z1' },
      { type: 'Intervals', duration: 20, zone: 'Z4' },
      { type: 'Cooldown', duration: 5, zone: 'Z1' },
    ],
  },
  {
    id: 'cardio-seed-liss',
    name: 'LISS',
    sequence: [{ type: 'LISS', duration: 45, zone: 'Z2' }],
  },
  {
    id: 'cardio-seed-tabata',
    name: 'Tabata',
    sequence: [{ type: 'Tabata', duration: 4, zone: 'Z5' }],
  },
];

// Pure nutrition math for the Health Column ledger — no React, no Rust, no IPC.
//
// Canonical nutrient keys + units MUST match build_fdc_db.py's NUTRIENT_MAP and
// the daily-log grammar (parsers/health.rs): the key is the join across the
// USDA DB, meal totals, the day ledger, and goals. `natural_sugar` is ALWAYS
// computed (never stored). A null amount means "not reported" — never 0.

// The 8 micros surfaced by default in the ledger; the rest collapse under "more".
export const DEFAULT_MICROS = [
  'vitamin_d', 'iron', 'potassium', 'fiber', 'sodium', 'calcium',
  'natural_sugar', 'added_sugars',
];

// FDA-2016 adult Daily Values (21 CFR 101.9(c), Nutrition Facts/Supplement Facts
// final rule). Units pinned to build_fdc_db.py's canonical unit per key — a
// mcg/mg mismatch here silently corrupts the %DV. total_sugars + trans_fat have
// no established DV (omitted).
export const STANDARD_DV = {
  protein:       { dv: 50,   unit: 'g' },
  fat:           { dv: 78,   unit: 'g' },
  saturated_fat: { dv: 20,   unit: 'g' },
  carb:          { dv: 275,  unit: 'g' },
  fiber:         { dv: 28,   unit: 'g' },
  added_sugars:  { dv: 50,   unit: 'g' },
  cholesterol:   { dv: 300,  unit: 'mg' },
  sodium:        { dv: 2300, unit: 'mg' },
  potassium:     { dv: 4700, unit: 'mg' },
  calcium:       { dv: 1300, unit: 'mg' },
  iron:          { dv: 18,   unit: 'mg' },
  magnesium:     { dv: 420,  unit: 'mg' },
  phosphorus:    { dv: 1250, unit: 'mg' },
  zinc:          { dv: 11,   unit: 'mg' },
  vitamin_c:     { dv: 90,   unit: 'mg' },
  vitamin_e:     { dv: 15,   unit: 'mg' },
  thiamin:       { dv: 1.2,  unit: 'mg' },
  riboflavin:    { dv: 1.3,  unit: 'mg' },
  niacin:        { dv: 16,   unit: 'mg' },
  vitamin_b6:    { dv: 1.7,  unit: 'mg' },
  vitamin_d:     { dv: 20,   unit: 'mcg' },
  vitamin_a:     { dv: 900,  unit: 'mcg' },
  vitamin_k:     { dv: 120,  unit: 'mcg' },
  folate:        { dv: 400,  unit: 'mcg' },
  vitamin_b12:   { dv: 2.4,  unit: 'mcg' },
};

// Macros + sugars surface as dedicated fields, never in the micro tail.
const TOPLEVEL = new Set(['kcal', 'protein', 'carb', 'fat', 'total_sugars', 'added_sugars']);

const round = (x) => Math.round(x * 10) / 10;

// Computed, never stored: max(0, total − added). Null unless BOTH are reported.
export function naturalSugar(sugar) {
  if (!sugar || sugar.total == null || sugar.added == null) return null;
  return Math.max(0, sugar.total - sugar.added);
}

// Sum ingredients into a MealLogEntry-shaped totals object (minus time/name/
// supplements). ingredients: [{fdc_id, grams}]; foodMap: {fdc_id: FoodDetail}
// (per-100g, canonical keys). Reporting rules:
//   - a micro is null ("not reported") only if NO ingredient reports it;
//   - added_sugars is CONSERVATIVE: null if ANY ingredient omits it (never a
//     misleadingly-low sum).
export function sumMealTotals(ingredients, foodMap) {
  const acc = {};          // key -> { amount, unit }
  let addedSugarMissing = false;

  for (const ing of ingredients || []) {
    const food = foodMap[ing.fdc_id];
    const factor = (ing.grams || 0) / 100;
    const byKey = {};
    if (food) for (const n of food.nutrients) byKey[n.key] = n;

    if (!('added_sugars' in byKey)) addedSugarMissing = true;

    for (const key of Object.keys(byKey)) {
      const n = byKey[key];
      if (!acc[key]) acc[key] = { amount: 0, unit: n.unit };
      acc[key].amount += n.amount * factor;
    }
  }

  const totalSugar = acc.total_sugars ? round(acc.total_sugars.amount) : null;
  let addedSugar = acc.added_sugars ? round(acc.added_sugars.amount) : null;
  if (addedSugarMissing) addedSugar = null;

  const micros = [];
  for (const key of Object.keys(acc)) {
    if (TOPLEVEL.has(key)) continue;
    micros.push({ key, amount: round(acc[key].amount), unit: acc[key].unit });
  }

  return {
    kcal: round(acc.kcal?.amount ?? 0),
    protein: round(acc.protein?.amount ?? 0),
    carb: round(acc.carb?.amount ?? 0),
    fat: round(acc.fat?.amount ?? 0),
    sugar: { total: totalSugar, added: addedSugar },
    micros,
  };
}

// Macro grams from calories + percent split: P,C = kcal·%/100 ÷ 4; F ÷ 9.
// micros: a {key: target} map from the goal's custom micro targets.
export function deriveTargets(goals) {
  if (!goals || !goals.calories) return null;
  const cal = goals.calories;
  const g = (pct, kcalPerG) => Math.round((cal * (pct || 0) / 100) / kcalPerG);
  const micros = {};
  for (const m of goals.micro_targets || []) micros[m.key] = m.target;
  return {
    kcal: cal,
    protein: g(goals.protein_pct, 4),
    carb: g(goals.carb_pct, 4),
    fat: g(goals.fat_pct, 9),
    micros,
  };
}

// Sum a day's logged meals (+ their supplements' micros) into day totals.
// micros is a {key: {amount, unit}} map for O(1) ledger lookup.
export function sumDay(meals) {
  const acc = { kcal: 0, protein: 0, carb: 0, fat: 0 };
  const micros = {};
  let totalSugar = 0, addedSugar = 0, totalSeen = false, addedSeen = false;

  const addMicro = (m) => {
    if (!micros[m.key]) micros[m.key] = { amount: 0, unit: m.unit };
    micros[m.key].amount += m.amount;
  };

  for (const meal of meals || []) {
    acc.kcal += meal.kcal || 0;
    acc.protein += meal.protein || 0;
    acc.carb += meal.carb || 0;
    acc.fat += meal.fat || 0;
    if (meal.sugar?.total != null) { totalSugar += meal.sugar.total; totalSeen = true; }
    if (meal.sugar?.added != null) { addedSugar += meal.sugar.added; addedSeen = true; }
    for (const m of meal.micros || []) addMicro(m);
    for (const s of meal.supplements || []) for (const m of s.micros || []) addMicro(m);
  }

  for (const k of Object.keys(micros)) micros[k].amount = round(micros[k].amount);
  return {
    kcal: round(acc.kcal),
    protein: round(acc.protein),
    carb: round(acc.carb),
    fat: round(acc.fat),
    sugar: { total: totalSeen ? round(totalSugar) : null, added: addedSeen ? round(addedSugar) : null },
    micros,
  };
}

// Mean daily macros over the most recent `windowDays` (default 7), counting ONLY
// days with ≥1 logged meal so a fast/empty day doesn't dilute the average. Returns
// null when nothing in the window was logged (the readout strip then hides).
// `days` is the useHealthHistory shape ([{ ds, meals, … }]); ordering-independent
// (sorts ds-descending itself). Reuses in-file sumDay; averages round to integers
// (the strip shows whole kcal/grams).
export function weeklyMacroAvg(days, windowDays = 7) {
  const recent = (days || [])
    .filter((d) => d && d.ds)
    .slice()
    .sort((a, b) => (a.ds < b.ds ? 1 : a.ds > b.ds ? -1 : 0))
    .slice(0, windowDays);
  const logged = recent.filter((d) => (d.meals?.length || 0) > 0);
  if (logged.length === 0) return null;
  const tot = { kcal: 0, protein: 0, carb: 0, fat: 0 };
  for (const d of logged) {
    const s = sumDay(d.meals);
    tot.kcal += s.kcal; tot.protein += s.protein; tot.carb += s.carb; tot.fat += s.fat;
  }
  const n = logged.length;
  return {
    kcal: Math.round(tot.kcal / n),
    protein: Math.round(tot.protein / n),
    carb: Math.round(tot.carb / n),
    fat: Math.round(tot.fat / n),
    daysLogged: n,
    windowDays,
  };
}

// ── Nutrition Log grammar parse (mirrors parsers/health.rs EXACTLY) ──
// The Rust side FORMATS the daily-log bullet (single source of truth); this
// reads it back. Pure (no IPC) so it's Node-testable against Rust's bytes.
// Separators: — = U+2014, · = U+00B7. Sugar token: sugar=<total>/<added>, `na`
// → null (≠ 0). `natural_sugar` is never stored.

function splitAmountUnit(s) {
  const m = String(s).match(/^([\d.]+)(.*)$/);
  return m ? { amount: parseFloat(m[1]), unit: m[2] } : null;
}

function parseMealTail(tail) {
  const micros = [];
  let sugar = { total: null, added: null };
  for (const tok of String(tail).trim().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('sugar=')) {
      const [t, a] = tok.slice(6).split('/');
      sugar = {
        total: t === 'na' ? null : (splitAmountUnit(t)?.amount ?? null),
        added: a === 'na' ? null : (splitAmountUnit(a)?.amount ?? null),
      };
    } else {
      const eq = tok.indexOf('=');
      if (eq < 0) continue;
      const au = splitAmountUnit(tok.slice(eq + 1));
      if (au) micros.push({ key: tok.slice(0, eq), amount: au.amount, unit: au.unit });
    }
  }
  return { micros, sugar };
}

// Parse the `## Nutrition Log` section into MealLogEntry-shaped objects. Lenient:
// [] when the section is absent (mirrors parse_nutrition_log's empty case).
export function parseNutritionLog(content) {
  if (!content) return [];
  const lines = content.split('\n');
  const meals = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const trim = lines[i].trim();
    if (trim === '## Nutrition Log') { inSection = true; continue; }
    if (!inSection) continue;
    if (trim.startsWith('## ')) { inSection = false; continue; }
    const head = lines[i].match(
      /^- (?:(\d{1,2}:\d{2}) — )?(.+?) — ([\d.]+) kcal · ([\d.]+)p \/ ([\d.]+)c \/ ([\d.]+)f(?: \| (.+))?$/,
    );
    if (!head) continue;
    const meal = {
      time: head[1] || null,
      name: head[2].trim(),
      kcal: parseFloat(head[3]),
      protein: parseFloat(head[4]),
      carb: parseFloat(head[5]),
      fat: parseFloat(head[6]),
      ...parseMealTail(head[7] || ''),
      supplements: [],
    };
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith('  ') && !lines[j].trim().startsWith('- ')) {
      const sm = lines[j].match(/^ {2}\+ (.+?)(?: — (.+?))?(?: · (.+))?$/);
      if (sm) {
        meal.supplements.push({
          name: sm[1].trim(),
          dose: sm[2] ? sm[2].trim() : null,
          micros: parseMealTail(sm[3] || '').micros,
        });
      }
      j++;
    }
    meals.push(meal);
    i = j - 1;
  }
  return meals;
}

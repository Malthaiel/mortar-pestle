// teamfightComms.js — Teamfight Comms Review (Deadlock Scrim Coaching, sub-plan 13). Pure ESM
// (no React, no @host) so detect/window/score/parse round-trip through a Node harness like
// deathAudit.js / vodReport.js. Clusters the coached team's in-game comms around each teamfight
// moment (a death cluster), scores whether the comms were jumbled, and — via Claude over the
// generic coaching_classify_match bridge (no new Rust) — judges each call good/wrong/late and
// flags moments that needed a call but got none (a "missed" callout with a suggested line). The
// per-scrim jumble/missed numbers feed sub-plan 12's Comms trend.
//
// Two clocks (same as deathAudit.js): deaths are game-clock seconds (extractSpatial), comms
// segments are recording-clock ms (parseSegments). recording = game + offsetS (the match's
// `Comms Offset` field). All functions are tolerant — bad input degrades to empty, never throws.

// Whole-second time → m:ss (standalone so the Node harness needs no matchData import).
export function mmss(s) {
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0) return '0:00';
  const w = Math.floor(v);
  return `${Math.floor(w / 60)}:${String(w % 60).padStart(2, '0')}`;
}

// Cluster deaths (both teams — an enemy death seeds a fight too) into teamfight moments: a run of
// deaths each within windowS of the PREVIOUS death, with >= minDeaths total, padded padS each side
// (clamped at 0). deaths: [{team, hero, t}] (extractSpatial shape). → [{tStart, tEnd, deaths[]}].
// ponytail: chains on consecutive gap, so a slow trickle of deaths 15 s apart merges into one long
// fight; tighten windowS or anchor to cluster-start if it over-merges in real scrims (gate fork 1).
export function detectMoments(deaths, { windowS = 15, minDeaths = 2, padS = 4 } = {}) {
  const sorted = (Array.isArray(deaths) ? deaths : [])
    .filter((d) => d && Number.isFinite(Number(d.t)))
    .map((d) => ({ team: d.team, hero: d.hero, t: Number(d.t) }))
    .sort((a, b) => a.t - b.t);
  const clusters = [];
  let cur = null;
  for (const d of sorted) {
    if (cur && d.t - cur[cur.length - 1].t <= windowS) cur.push(d);
    else { if (cur && cur.length >= minDeaths) clusters.push(cur); cur = [d]; }
  }
  if (cur && cur.length >= minDeaths) clusters.push(cur);
  return clusters.map((c) => ({
    tStart: Math.max(0, c[0].t - padS),
    tEnd: c[c.length - 1].t + padS,
    deaths: c,
  }));
}

// The comms segments overlapping a moment's window, in game-clock terms. segments: parseSegments
// shape (recording ms). offsetS shifts recording→game. → ordered [{t0Ms, t1Ms, atGame, speaker, text}].
export function momentComms(moment, segments, offsetS = 0) {
  const startMs = (moment.tStart + offsetS) * 1000;
  const endMs = (moment.tEnd + offsetS) * 1000;
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => s && String(s.text ?? '').trim() && (Number(s.t0Ms) || 0) < endMs && (Number(s.t1Ms) || 0) > startMs)
    .map((s) => ({
      t0Ms: Number(s.t0Ms) || 0,
      t1Ms: Number(s.t1Ms) || 0,
      atGame: (Number(s.t0Ms) || 0) / 1000 - offsetS,
      speaker: s.speaker || 'Unknown',
      text: String(s.text).trim(),
    }))
    .sort((a, b) => a.t0Ms - b.t0Ms);
}

// Score a fight's calls for overlap/density. A call is "concurrent" when its interval overlaps
// >= 2 others (3+ people talking at once). density = calls per second of the fight span. → label
// Clear / Busy / Jumbled + the raw numbers. Thresholds are v1 defaults (confirm at gate, fork 2).
export function jumbleScore(calls, { spanS = 0 } = {}) {
  const cs = Array.isArray(calls) ? calls : [];
  let overlap = 0;
  for (const a of cs) {
    const others = cs.filter((b) => b !== a && b.t0Ms < a.t1Ms && b.t1Ms > a.t0Ms).length;
    if (others >= 2) overlap++;
  }
  const speakers = new Set(cs.map((c) => c.speaker)).size;
  const density = spanS > 0 ? cs.length / spanS : 0;
  const label = overlap >= 1 || density > 0.8 ? 'Jumbled'
    : (cs.length >= 4 || density > 0.4) ? 'Busy' : 'Clear';
  return { overlap, density: Math.round(density * 100) / 100, speakers, label };
}

// Deterministic fight objects (NO AI): detect moments, attach the coached comms in each window +
// the jumble score. `side` (0|1|null) marks which deaths are the coached team's (display + judgment
// focus). → [{ id, tStart, tEnd, deaths:[{hero, team, t, ours}], calls:[...], jumble:{...} }].
export function buildFights(deaths, segments, { side = null, offsetS = 0, windowS = 15, minDeaths = 2, padS = 4 } = {}) {
  return detectMoments(deaths, { windowS, minDeaths, padS }).map((m) => {
    const calls = momentComms(m, segments, offsetS);
    return {
      id: `tf-${Math.round(m.tStart)}`,
      tStart: m.tStart,
      tEnd: m.tEnd,
      deaths: m.deaths.map((d) => ({ hero: d.hero, team: d.team, t: d.t, ours: side != null && d.team === side })),
      calls,
      jumble: jumbleScore(calls, { spanS: Math.max(1, m.tEnd - m.tStart) }),
    };
  });
}

// ── Claude judge: prompt + tolerant parse + merge (coaching_classify_match, no new Rust) ─────────

export const TEAMFIGHT_SYSTEM_PROMPT = [
  'You are a Deadlock scrim coach reviewing a team\'s in-game voice comms fight-by-fight. For each',
  'teamfight moment you get: the deaths in it (hero + team + game time; a "*" marks the COACHED team),',
  'and the coached team\'s ordered callouts (index, speaker, [m:ss], text). Judge the COMMS — the',
  'quality of what was (or was not) said — NOT the mechanical play.',
  '',
  'For each fight, rate the callouts that deserve comment and flag calls that were missing:',
  '- verdict "good": a useful, timely call (target, rotation, cooldown/ult, retreat, an enemy spotted).',
  '- verdict "wrong": a call that gave bad information or the wrong decision (e.g. "go" into a lost fight).',
  '- verdict "late": the right call, but after the moment it would have mattered.',
  '- missed: a moment in this fight that clearly needed a call and got none — say what was needed',
  '  ("what") and the short line they should have said ("shouldSay", e.g. "watch left, they\'re rotating").',
  '',
  'Return ONLY a JSON object (no markdown, no code fences, no commentary):',
  '{ "fights": [ { "id": "<exact fight id>",',
  '    "calls": [ { "i": <call index>, "verdict": "good"|"wrong"|"late", "note": "<short why>" } ],',
  '    "missed": [ { "what": "<the moment>", "shouldSay": "<the call>" } ] } ] }',
  '',
  'Rules: use the EXACT fight ids and call indices given — never invent a fight, call, or index. Omit',
  'calls you have no comment on (they render neutral). Ground every verdict only in the given deaths +',
  'callouts. Echo every fight id, even a clean one (list its good calls, empty "missed"). Keep notes short.',
].join('\n');

// User prompt: each fight's deaths + indexed callouts, compact.
export function buildTeamfightPrompt(fights, { coachedTeam = '', roster = [] } = {}) {
  const lines = [`Coached team: ${coachedTeam || '(unnamed)'}.`];
  if (roster && roster.length) lines.push(`Roster (speaker names): ${roster.join(', ')}.`);
  lines.push('', `Fights (${fights.length} — judge every one):`);
  for (const f of fights) {
    lines.push('', `Fight ${f.id} (${mmss(f.tStart)}–${mmss(f.tEnd)}):`);
    lines.push(`  deaths: ${f.deaths.map((d) => `${d.hero}${d.ours ? '*' : ''}@${mmss(d.t)}`).join(', ') || '(none)'}`);
    if (f.calls.length) f.calls.forEach((c, i) => lines.push(`  [${i}] ${c.speaker} ${mmss(c.atGame)}: ${c.text}`));
    else lines.push('  (no callouts)');
  }
  lines.push('', '"*" = a coached-team death.');
  return lines.join('\n');
}

// Merge Claude's verdicts onto the deterministic fights: attach verdict/note to the matching call
// index, collect the missed list. Unknown ids/indices/verdicts are dropped (never invents). Fights
// keep their order + all their calls; a call with no verdict stays neutral (verdict null).
export function coerceVerdicts(obj, fights) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const byId = new Map((Array.isArray(o.fights) ? o.fights : []).map((f) => [String(f && f.id), f]));
  const VERDICTS = new Set(['good', 'wrong', 'late']);
  return fights.map((f) => {
    const j = byId.get(f.id) || {};
    const verdictByIdx = new Map();
    for (const c of (Array.isArray(j.calls) ? j.calls : [])) {
      const i = Number(c && c.i);
      const v = String(c && c.verdict || '').toLowerCase();
      if (Number.isInteger(i) && i >= 0 && i < f.calls.length && VERDICTS.has(v)) {
        verdictByIdx.set(i, { verdict: v, note: String(c.note || '').trim() });
      }
    }
    return {
      ...f,
      calls: f.calls.map((c, i) => ({ ...c, verdict: verdictByIdx.get(i)?.verdict || null, note: verdictByIdx.get(i)?.note || '' })),
      missed: (Array.isArray(j.missed) ? j.missed : [])
        .map((mm) => ({ what: String(mm && mm.what || '').trim(), shouldSay: String(mm && mm.shouldSay || '').trim() }))
        .filter((mm) => mm.what || mm.shouldSay),
    };
  });
}

// Tolerant parse of Claude's text → merged fights. Strips a fence, slices the outermost {…},
// JSON.parse, coerce. Mirrors vodReport.parseReport.
export function parseVerdicts(text, fights) {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) throw new Error('no JSON object in model output');
  return coerceVerdicts(JSON.parse(t.slice(a, b + 1)), fights);
}

// Per-scrim comms numbers for sub-plan 12's Comms trend (fork 4): raw counts + share of fights
// labelled Jumbled + missed callouts per fight. Fed by updateTeamProgress from the cached sidecar.
export function summarize(fights) {
  const fs = Array.isArray(fights) ? fights : [];
  const n = fs.length;
  const jumbled = fs.filter((f) => f.jumble && f.jumble.label === 'Jumbled').length;
  const missed = fs.reduce((a, f) => a + ((f.missed || []).length), 0);
  return {
    fights: n,
    jumbled,
    missed,
    jumbledShare: n ? Math.round((jumbled / n) * 100) / 100 : null,
    missedPerFight: n ? Math.round((missed / n) * 100) / 100 : null,
  };
}

// Run the headless judge (DI: `invoke` passed by the caller, like classifyMoments/generateReport).
// Reprompts once on a parse failure, then lets a second failure throw. Opus via the alias Rust maps
// to claude-opus-4-8. Returns [] for no fights without calling the model.
export async function judgeTeamfights(invoke, { fights, coachedTeam = '', roster = [] }, agents = {}) {
  if (!Array.isArray(fights) || !fights.length) return [];
  const user = buildTeamfightPrompt(fights, { coachedTeam, roster });
  const base = {
    systemPrompt: TEAMFIGHT_SYSTEM_PROMPT,
    backend: agents.authBackend || 'api-key',
    model: agents.model || 'opus',
    cliPath: agents.claudeCliPath || '',
  };
  const call = (userPrompt) => invoke('coaching_classify_match', { ...base, userPrompt });
  try {
    return parseVerdicts(await call(user), fights);
  } catch (err) {
    const retry = `${user}\n\nYour previous response failed to parse (${err.message}). Respond with ONLY the JSON object, nothing else.`;
    return parseVerdicts(await call(retry), fights);
  }
}

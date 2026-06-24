// Auto Classification (Deadlock Scrim Coaching, sub-plan 5).
// Pure ESM (no React, no @host) so it round-trips through a Node harness exactly
// like matchData.js / noteCompile.js / scrimSchema.js. The AI engine is split:
//   SF1 (here)  — buildMomentsDigest: a deterministic "notable moments" digest from
//                 raw deadlock-api metadata for a TARGET side (the thing Claude judges).
//   SF2         — the classify prompt + tolerant parse (coaching_classify_match in Rust).
//   SF3/SF4     — reconcile + render + the .autoclass sidecar review state.
//
// The digest is what makes auto-classification tractable: instead of dumping the
// ~1.2 MB match JSON at the model, we distill the handful of moments worth judging
// (deaths, lost/taken objectives, isolated enemy picks, thrown leads) with compact
// numeric context, and let Claude decide blunder-vs-variance per moment.

import { extractObjectives, extractSeries, sideName, heroName, clock } from './matchData.js';
import { CLASSIFICATIONS, secFromClock, formatTimedBullet } from './noteCompile.js';

// Deadlock side label → side id (0 = Amber, 1 = Sapphire). The API metadata carries
// no mapping from a real team NAME to a side, so the coached side is a user input
// (persisted as `- Coached Side:` on the match; the picker UI is SF4). null = unknown.
export function sideFromLabel(label) {
  const s = String(label || '').trim().toLowerCase();
  if (s === 'amber') return 0;
  if (s === 'sapphire') return 1;
  return null;
}

// Resolve coached/enemy sides from the per-match Amber/Sapphire team-name fields
// (sub-plan 5 redesign): match a side's team name to the coached team (case-insensitive).
// Falls back to the legacy `Coached Side` label when the name fields don't resolve.
// → { coachedSide: 0|1|null, enemySide: 0|1|null }.
export function sideFromTeamFields(fields, coachedTeam) {
  const f = fields || {};
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const ct = norm(coachedTeam);
  let coachedSide = null;
  if (ct && norm(f['Amber']) === ct) coachedSide = 0;
  else if (ct && norm(f['Sapphire']) === ct) coachedSide = 1;
  else coachedSide = sideFromLabel(f['Coached Side']);
  return { coachedSide, enemySide: coachedSide == null ? null : 1 - coachedSide };
}

// Two deaths within this window count as the same fight (teamfight vs isolated pick).
const TEAMFIGHT_WINDOW_S = 15;
// A 2-minute soul-lead drop below this (souls) is too small to flag as a thrown lead.
const LEAD_SWING_MIN = 3000;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

// Nearest-frame net_worth for a player's sorted series points at time t.
function nearestNetWorth(pts, t) {
  if (!pts || !pts.length) return 0;
  let best = pts[0], bestD = Math.abs(pts[0].t - t);
  for (const p of pts) { const d = Math.abs(p.t - t); if (d < bestD) { bestD = d; best = p; } }
  return best.net_worth || 0;
}
const teamSoulAt = (series, team, t) =>
  series.filter((s) => s.team === team).reduce((a, s) => a + nearestNetWorth(s.pts, t), 0);
// + = target side ahead, − = behind.
const soulLeadAt = (series, side, t) => teamSoulAt(series, side, t) - teamSoulAt(series, 1 - side, t);

// Deterministic notable-moments digest for `side` (0|1). Reuses matchData.js extractors.
// Tolerant: missing fields degrade to 0/empty, never throw. Same raw JSON + same side
// → byte-identical moments (momentIds are stable for cross-run review reconciliation).
export function buildMomentsDigest(raw, side) {
  const mi = (raw && raw.match_info) || {};
  const players = Array.isArray(mi.players) ? mi.players : [];
  const series = extractSeries(raw);
  const { objectives } = extractObjectives(raw);
  const durationS = Number(mi.duration_s) || 0;
  const enemy = 1 - side;

  const roster = players
    .filter((p) => p.team === side)
    .map((p) => ({ slot: p.player_slot, hero: heroName(p.hero_id) }));

  // slot → { hero, team } for attributing kills via death_details.killer_player_slot.
  const bySlot = new Map(players.map((p) => [p.player_slot, { hero: heroName(p.hero_id), team: p.team }]));

  // All deaths (both teams), used for teamfight clustering + kill attribution. Reference
  // identity is kept (these exact objects are filtered below) so `o !== dth` excludes only
  // self. killerSlot resolves via bySlot when a player landed the kill (else creeps/self).
  const allDeaths = [];
  for (const p of players) {
    for (const d of (Array.isArray(p.death_details) ? p.death_details : [])) {
      allDeaths.push({
        team: p.team, slot: p.player_slot, hero: heroName(p.hero_id),
        t: Number(d.game_time_s) || 0,
        killerSlot: d.killer_player_slot,
        ttk: Math.round(Number(d.time_to_kill_s) || 0),
      });
    }
  }

  const moments = [];

  // 1. Target-side deaths — the richest per-player signal.
  for (const dth of allDeaths.filter((d) => d.team === side)) {
    const within = allDeaths.filter((o) => Math.abs(o.t - dth.t) <= TEAMFIGHT_WINDOW_S);
    const alliesDeadNearby = within.filter((o) => o.team === side && o !== dth).length;
    const enemiesDeadNearby = within.filter((o) => o.team === enemy).length;
    const ser = series.find((s) => s.slot === dth.slot);
    moments.push({
      momentId: `${side}-death-${Math.round(dth.t)}-${slug(dth.hero)}`,
      type: 'death',
      t0Ms: Math.round(dth.t * 1000),
      subject: dth.hero,
      context: {
        at: clock(dth.t),
        netWorthAtDeath: ser ? Math.round(nearestNetWorth(ser.pts, dth.t)) : 0,
        soulLead: Math.round(soulLeadAt(series, side, dth.t)),
        killedBy: bySlot.get(dth.killerSlot)?.hero || null,
        timeToKillS: dth.ttk,
        soloPick: alliesDeadNearby === 0,
        alliesDeadNearby,
        enemiesDeadNearby,
      },
    });
  }

  // 2. Objectives the target side lost / took.
  for (const o of objectives) {
    if (o.destroyed == null) continue;
    const lostByTarget = o.team === side;   // structure OWNED by target side = target lost it
    const tookFromEnemy = o.team === enemy; // target destroyed an enemy structure
    if (!lostByTarget && !tookFromEnemy) continue;
    moments.push({
      momentId: `${side}-${lostByTarget ? 'objloss' : 'objtake'}-${Math.round(o.destroyed)}-${slug(o.name)}`,
      type: lostByTarget ? 'objLoss' : 'objTake',
      t0Ms: Math.round(o.destroyed * 1000),
      subject: o.name,
      context: { at: clock(o.destroyed), structure: o.name, soulLead: Math.round(soulLeadAt(series, side, o.destroyed)) },
    });
  }

  // 3. Isolated enemy deaths the target side landed = clean pickoffs (Best/Brilliant
  //    candidates). killer_player_slot attributes the kill; only keep picks the target
  //    side actually made (an enemy dying isolated to creeps/self isn't a coached play).
  for (const dth of allDeaths.filter((d) => d.team === enemy)) {
    const within = allDeaths.filter((o) => Math.abs(o.t - dth.t) <= TEAMFIGHT_WINDOW_S);
    if (within.filter((o) => o.team === enemy && o !== dth).length > 0) continue; // not isolated
    const killer = bySlot.get(dth.killerSlot);
    if (!killer || killer.team !== side) continue; // not a target-side pick
    moments.push({
      momentId: `${side}-pick-${Math.round(dth.t)}-${slug(dth.hero)}`,
      type: 'enemyPick',
      t0Ms: Math.round(dth.t * 1000),
      subject: dth.hero,
      context: { at: clock(dth.t), enemyHero: dth.hero, pickBy: killer.hero, soulLead: Math.round(soulLeadAt(series, side, dth.t)) },
    });
  }

  // 4. Biggest 2-minute soul-lead drop against the target side (a "thrown lead").
  let topSwing = null;
  for (let t = 0; t + 120 <= durationS; t += 30) {
    const from = soulLeadAt(series, side, t), to = soulLeadAt(series, side, t + 120);
    const drop = from - to; // positive = target lost ground
    if (drop >= LEAD_SWING_MIN && (!topSwing || drop > topSwing.drop)) {
      topSwing = { tStart: t, tEnd: t + 120, drop: Math.round(drop), from: Math.round(from), to: Math.round(to) };
    }
  }
  if (topSwing) {
    moments.push({
      momentId: `${side}-swing-${topSwing.tStart}`,
      type: 'leadSwing',
      t0Ms: topSwing.tStart * 1000,
      subject: 'team',
      context: { window: `${clock(topSwing.tStart)}–${clock(topSwing.tEnd)}`, soulSwing: topSwing.drop, leadFrom: topSwing.from, leadTo: topSwing.to },
    });
  }

  moments.sort((a, b) => (a.t0Ms - b.t0Ms) || a.momentId.localeCompare(b.momentId));
  return {
    side,
    sideName: sideName(side),
    enemySideName: sideName(enemy),
    durationS,
    roster,
    momentCount: moments.length,
    moments,
  };
}

// ── SF2: classify prompt + tolerant parse + the headless engine call ─────────
// The engine is the Claude integration the app already ships (settings.agents). The
// digest above is distilled to a prompt; coaching_classify_match (Rust, headless, no
// tools) returns raw text; parseClassifications validates it against the taxonomy. The
// prompt + parse are pure (Node-testable); `invoke` is injected so this module never
// imports a Tauri/browser global (buildMomentsDigest stays harness-runnable).

const LABELS_BY_LC = new Map(CLASSIFICATIONS.map((c) => [c.toLowerCase(), c]));

// Analyst role + the exact 11-label taxonomy (shared with the manual compiler) + a
// strict JSON-array contract. The labels are the chess.com Game Review set.
export const CLASSIFY_SYSTEM_PROMPT = [
  "You are a Deadlock match analyst grading ONE team's play for their coach, using the",
  'chess.com "Game Review" classification system. The labels (best to worst, loosely):',
  `${CLASSIFICATIONS.join(', ')}.`,
  '',
  'You receive a JSON "moments" digest for one team in one match. Each moment has a',
  'momentId, a type (death | objLoss | objTake | enemyPick | leadSwing), a timestamp,',
  'a subject, and numeric context: souls, soulLead (+ = the graded team is ahead, − = behind),',
  'killedBy / pickBy (hero attribution), soloPick + allies/enemies dead nearby (teamfight vs',
  'isolated), timeToKillS, structure, soulSwing.',
  '',
  "You MAY also receive the coach's own notes: each has a noteId, an optional in-game time",
  '("at"), an optional label, and free text — the coach\'s manual observations to merge in.',
  '',
  'Classify EVERY moment with one label, a confidence 0–1, and a one-sentence rationale',
  'grounded ONLY in the given context. Calibration: most moments are routine — reserve',
  'Blunder/Brilliant for clear cases. Heuristics (not rules): a death while well ahead with',
  'no allies dead ≈ Blunder/Mistake; trading in a teamfight ≈ Good/Book/Forced; a clean solo',
  'pick onto a key enemy ≈ Best/Brilliant; losing an objective while ahead ≈ Mistake; a large',
  'thrown soul lead (leadSwing) ≈ Blunder/Mistake on the team.',
  '',
  'Also: for each coach note, decide if it describes the same event as a moment (match on',
  'time proximity + subject/hero/structure). If so FOLD it in — combine your rationale with',
  'the coach\'s wording into one sentence, list that noteId in "foldedNoteIds", and set',
  '"conflict": true when the coach\'s label differs from yours. A coach note that matches NO',
  "moment: emit it as its own element with its noteId, the coach's label (or your best label,",
  "or null), and the coach's text as rationale. NEVER drop a coach note — echo every noteId",
  'exactly once (folded or standalone).',
  '',
  'Respond with ONLY a JSON array — no prose, no markdown fences. A moment element:',
  '{"momentId": "<exact id>", "classification": "<one exact label>", "confidence": <0..1>,',
  '"rationale": "<one sentence>", "foldedNoteIds": ["<id>"], "conflict": false}.',
  'A standalone-note element: {"noteId": "<exact id>", "classification": "<one label or null>",',
  '"rationale": "<text>"}. Use the exact ids; do not invent or drop moments.',
].join('\n');

// User message: compact header + moments as compact JSON. An optional comms slice
// (sub-plan 4 transcript) is appended best-effort as extra context, capped.
export function buildClassifyPrompt(digest, { commsSlice = '', userNotes = [] } = {}) {
  const lines = [
    `Team graded: ${digest.sideName} (vs ${digest.enemySideName}). Match length: ${Math.round(digest.durationS / 60)}m.`,
    `Roster: ${digest.roster.map((r) => r.hero).join(', ')}.`,
  ];
  if (commsSlice && commsSlice.trim()) {
    lines.push('', 'Team comms (context only, may be noisy):', commsSlice.trim().slice(0, 4000));
  }
  lines.push('', `Moments (${digest.moments.length} — classify every one):`, JSON.stringify(digest.moments));
  if (userNotes && userNotes.length) {
    lines.push('', `Coach notes (${userNotes.length} — fold each into the nearest related moment, or echo standalone; never drop one):`,
      JSON.stringify(userNotes.map((n) => ({ noteId: n.noteId, at: n.at || null, label: n.label || null, text: n.text }))));
  }
  return lines.join('\n');
}

// Tolerant parse → validated suggestions. Strips a markdown fence, slices the outermost
// [...], JSON.parses, keeps only taxonomy labels, clamps confidence. Throws on
// unparseable output so the caller can reprompt once. Never fabricates a label.
export function parseClassifications(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  const lo = s.indexOf('['), hi = s.lastIndexOf(']');
  if (lo === -1 || hi === -1 || hi < lo) throw new Error('no JSON array in model output');
  const arr = JSON.parse(s.slice(lo, hi + 1));
  if (!Array.isArray(arr)) throw new Error('parsed value is not an array');
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const label = LABELS_BY_LC.get(String(e.classification || '').trim().toLowerCase());
    if (!label) continue; // drop unknown labels — never invent one
    const momentId = String(e.momentId || '').trim();
    if (!momentId) continue;
    let conf = Number(e.confidence);
    if (!Number.isFinite(conf)) conf = 0.5;
    out.push({ momentId, classification: label, confidence: Math.max(0, Math.min(1, conf)), rationale: String(e.rationale || '').trim() });
  }
  return out;
}

// Build a standalone "note echo" item — a coach note that matched no moment, or one the
// model dropped and we back-fill. source 'note'; synthetic momentId derived from the noteId.
function noteItem(note, label, rationale) {
  return {
    momentId: `note-${note.noteId}`, source: 'note', type: 'note',
    classification: label, confidence: 1, rationale: rationale || note.text || '',
    at: note.at || null, atSec: note.atSec ?? secFromClock(note.at), subject: null,
    noteId: note.noteId, noteText: note.text, noteClassification: note.label || null, conflict: false,
  };
}

// Tolerant parse of the MERGE response → combined items. Moment elements enrich from the
// digest (at/subject/type); note elements (noteId, no momentId) become standalone items.
// Conflict is recomputed client-side (don't trust the model). NON-LOSSY GUARANTEE: any
// coach note the model failed to echo is appended verbatim, so the "Notes is the one list"
// replace-on-save can never silently drop a note.
export function parseMergedClassifications(text, digest, userNotes = []) {
  let s = String(text || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  const lo = s.indexOf('['), hi = s.lastIndexOf(']');
  if (lo === -1 || hi === -1 || hi < lo) throw new Error('no JSON array in model output');
  const arr = JSON.parse(s.slice(lo, hi + 1));
  if (!Array.isArray(arr)) throw new Error('parsed value is not an array');
  const byMoment = new Map(digest.moments.map((m) => [m.momentId, m]));
  const byNote = new Map((userNotes || []).map((n) => [n.noteId, n]));
  const consumed = new Set();
  const items = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const momentId = String(e.momentId || '').trim();
    const noteId = String(e.noteId || '').trim();
    if (momentId && byMoment.has(momentId)) {
      const label = LABELS_BY_LC.get(String(e.classification || '').trim().toLowerCase());
      if (!label) continue; // drop unknown labels — never invent
      const m = byMoment.get(momentId);
      const folded = (Array.isArray(e.foldedNoteIds) ? e.foldedNoteIds : []).map((x) => String(x).trim()).filter((x) => byNote.has(x));
      folded.forEach((x) => consumed.add(x));
      const note = folded.length ? byNote.get(folded[0]) : null;
      const noteClassification = note?.label || null;
      let conf = Number(e.confidence); if (!Number.isFinite(conf)) conf = 0.5;
      items.push({
        momentId, source: folded.length ? 'merged' : 'ai', type: m.type,
        classification: label, confidence: Math.max(0, Math.min(1, conf)), rationale: String(e.rationale || '').trim(),
        at: m.context?.at || null, atSec: secFromClock(m.context?.at), subject: m.subject,
        noteId: folded[0] || null, noteText: note?.text || null, noteClassification,
        conflict: !!(noteClassification && noteClassification !== label),
      });
    } else if (noteId && byNote.has(noteId)) {
      consumed.add(noteId);
      const note = byNote.get(noteId);
      const label = LABELS_BY_LC.get(String(e.classification || '').trim().toLowerCase()) || note.label || null;
      items.push(noteItem(note, label, String(e.rationale || '').trim()));
    }
  }
  // non-lossy back-fill: echo every coach note the model dropped
  for (const n of (userNotes || [])) if (!consumed.has(n.noteId)) items.push(noteItem(n, n.label || null, n.text));
  return items;
}

// Run the headless classify (DI: `invoke` passed by the caller). Reprompts once on a
// parse failure, then drops any suggestion whose momentId isn't in the digest.
export async function classifyMoments(invoke, digest, agents = {}, opts = {}) {
  const user = buildClassifyPrompt(digest, opts);
  const base = {
    systemPrompt: CLASSIFY_SYSTEM_PROMPT,
    backend: agents.authBackend || 'api-key',
    model: agents.model || 'opus',
    cliPath: agents.claudeCliPath || '',
  };
  const call = (userPrompt) => invoke('coaching_classify_match', { ...base, userPrompt });
  const notes = opts.userNotes || [];
  try {
    return parseMergedClassifications(await call(user), digest, notes);
  } catch (err) {
    const retry = `${user}\n\nYour previous response failed to parse (${err.message}). Respond with ONLY the JSON array, nothing else.`;
    return parseMergedClassifications(await call(retry), digest, notes); // throws again if still bad
  }
}

// ── SF3: reconcile review state + render the AI section + the .md setter ─────
// The .autoclass sidecar is the durable source of truth for review state (per team);
// the `### Auto Classification (<team>)` opaque section is its regenerated Obsidian
// mirror. reconcile merges a fresh classify run with the prior review decisions so a
// re-run never destroys an accept/reject/re-tag (matchId is fixed ⇒ momentIds are stable).

export function reconcile(fresh, prior) {
  const priorById = new Map((prior?.suggestions || []).map((s) => [s.momentId, s]));
  return fresh.map((f) => {
    const p = priorById.get(f.momentId);
    // Sticky review decision + user edits; refresh the AI's label/confidence/rationale from fresh.
    if (p && p.review && p.review !== 'pending') {
      return { ...f, review: p.review, dropped: !!p.dropped, userLabel: p.userLabel || null, acceptedText: p.acceptedText ?? null };
    }
    return { ...f, review: 'pending', dropped: false, userLabel: null, acceptedText: null };
  });
}

// Obsidian-legible mirror written into `### Auto Classification (<team>)`. AI-badged
// marker (hidden in the interactive view) + suggestions sorted by confidence. The
// interactive AutoClassificationView renders from the sidecar, not this body.
export function renderAutoClassification(team) {
  const sugg = [...(team?.suggestions || [])].sort((a, b) => {
    const sa = secFromClock(a.at), sb = secFromClock(b.at);
    if (sa == null && sb == null) return 0;
    if (sa == null) return 1;
    if (sb == null) return -1;
    return sa - sb;
  });
  const lines = ['_(AI-suggested · Run-Process-owned, regenerated)_'];
  lines.push(`Model: ${team?.model || 'opus'} · ${sugg.length} suggestion${sugg.length === 1 ? '' : 's'}`, '');
  if (!sugg.length) { lines.push('_(No moments to classify.)_'); return lines.join('\n'); }
  for (const s of sugg) {
    const label = s.review === 'retagged' && s.userLabel ? `${s.userLabel} (AI said ${s.classification})` : s.classification;
    const status = s.review && s.review !== 'pending' ? ` [${s.review}]` : '';
    const where = [s.at, s.subject].filter(Boolean).join(' ');
    lines.push(`- ${label} (${Number(s.confidence).toFixed(2)})${where ? ` · ${where}` : ''}${status} — ${s.rationale}`);
  }
  return lines.join('\n');
}

// A kept review item → a Notes bullet: "[m:ss] Label: subject — text". userLabel (a retag)
// wins over the AI label; acceptedText (the coach's inline edit) is the bullet text verbatim.
// Used by the review modal's Save to rebuild the team's Notes list.
export function mergedItemToBullet(item) {
  const label = item.userLabel || item.classification || null;
  const text = item.acceptedText != null
    ? item.acceptedText
    : `${item.subject ? item.subject + ' — ' : ''}${item.rationale || ''}`;
  return formatTimedBullet({ atSec: item.atSec, classification: label, text });
}

// Set the `### Auto Classification (<teamName>)` opaque body on match n (replace if
// present, append if absent). Mirrors setCoachingSummaryBody, but the heading carries
// the team so coached + enemy sections coexist. Disk-owned → written via serializeScrim.
export function setAutoClassificationBody(scrim, n, teamName, body) {
  const heading = `Auto Classification (${teamName})`;
  return {
    ...scrim,
    matches: (scrim.matches || []).map((mm) => {
      if (mm.n !== n) return mm;
      const subs = mm.subsections || [];
      const has = subs.some((s) => s.kind === 'opaque' && s.heading === heading);
      return {
        ...mm,
        subsections: has
          ? subs.map((s) => (s.kind === 'opaque' && s.heading === heading ? { ...s, body } : s))
          : [...subs, { kind: 'opaque', heading, body }],
      };
    }),
  };
}

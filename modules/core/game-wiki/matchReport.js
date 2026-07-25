// Process 1 — the per-match FIRST report (M3 of the VOD Report Final Improvements plan). The scrim
// VOD report reports ONLY what the coach said; this one is the opposite by design — the Analyst's
// own reads ARE the product, written from the match-data digest + the in-game comms transcript
// (+ the judged teamfight-comms block when present), before any VOD review happens. What keeps that
// honest is provenance: every claim opens with a literal [data] / [grounded] / [analyst] tag, so a
// machine opinion can never be mistaken for a scoreboard fact. Process 2 (the coach-voiced final,
// .matchfinal — M4) replaces this report in every view and reconciles its [analyst] claims
// confirmed/overridden; this sidecar stays on disk as the analyst's record.
//
// Mirrors vodReport.js deliberately (same prompt→parse→coerce→generate shape, same parseOrRetry,
// same coaching_classify_match invoke) — a reader who knows one knows this one. Differences: the
// FULL report shape (so the final can replace it 1:1), but qa and followUps are ALWAYS [] here
// (nobody asked anything — there is no review session yet; both belong to Process 2), and
// actionItems are the analyst's own suggestions, every one [analyst]-tagged.
import { parseOrRetry } from './aiRetry.js';

export const MATCH_REPORT_SCHEMA_VERSION = 1;

export const TAGS = ['data', 'grounded', 'analyst'];

// Claims carry their provenance as a literal prefix token in the string ("[data] Infernus hit 20k
// souls at 18:40"). A prefix token beats a parallel structured field: the model writes it inline
// where it is thinking about the claim, it survives export and copy-paste as plain text, and one
// regex recovers it for the view. Unknown or absent tag → tag '' and the text untouched.
const TAG_RE = /^\s*\[(data|grounded|analyst)\]\s*/i;

export function splitTag(text) {
  const s = String(text ?? '');
  const m = s.match(TAG_RE);
  return m ? { tag: m[1].toLowerCase(), text: s.slice(m[0].length) } : { tag: '', text: s };
}

// M23 twin of VodReportView.linkTimeTokens: turn the literal provenance tags inside a section's
// markdown into #tag- links so the view's existing `a` override renders them as chips. Reusing the
// link channel means markdown, tables and lists keep working — no second renderer. Fence-aware, and
// `(?!\()` leaves a real markdown link like [data](url) alone.
export function linkTagTokens(md) {
  return String(md ?? '')
    .split(/(```[\s\S]*?```|`[^`]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\[(data|grounded|analyst)\](?!\()/g, '[$1](#tag-$1)')))
    .join('');
}

// Every tagged claim in the report, flattened — feeds M24's reconciliation (the scrim report judges
// each [analyst] read) and M25's verify pass (which checks [data] claims against the digest).
export function collectClaims(report) {
  const out = [];
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const { tag, text } = splitTag(v);
      if (tag) out.push({ ref: path, tag, text });
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k); }
  };
  walk(report && typeof report === 'object' ? report : {}, '');
  return out;
}

// M5: the system prompt is built per run. `dataFree` (no Match ID / empty digest) REPLACES the
// data-grounded schema comment lines and the data-grounding rule — not appends to them — because the
// schema comments otherwise outweigh any addendum and the model fills data-only fields with filler
// ("no individual curve discussed" ×5, the audit's finding 2). Data-free = empty fields, never filler.
export function buildMatchReportSystemPrompt({ dataFree = false } = {}) {
  return [
  'You are an elite Deadlock analyst writing a coaching report on ONE match. You are given a deterministic',
  'match-data digest (scoreboard, souls curves, item builds, deaths, objectives, damage focus), optionally the',
  'diarized in-game comms transcript (speaker-labeled, timestamped [m:ss]), optionally a judged in-game comms',
  'block, optionally the coach\'s tagged in-game notes, and an ANALYST BRAIN (charter, canonical lexicon,',
  'patch digest, taught concepts, distilled corrections).',
  '',
  'Unlike a VOD-review report, YOUR OWN READS ARE THE JOB. Nobody reviewed this match on camera — there is no',
  'coach transcript to organize. Judge the match: who won their lane and why, where the game turned, which',
  'builds were wrong, which deaths were avoidable. Say the thing you actually believe.',
  '',
  'PROVENANCE — the one hard rule. Every claim you write opens with a literal tag naming where it came from:',
  '- [data]     — a deterministic fact straight from the match digest. Nothing but digest values.',
  '                "[data] Infernus finished 20.4k souls, 3.1k behind his lane counterpart."',
  '- [grounded] — a claim checked against the patch digest, taught concepts, or distilled corrections in the',
  '                brain. Name the source inside the claim.',
  '                "[grounded] Metal Skin\'s reflect was cut in the 07-02 patch, so that buy is worse than it reads."',
  '- [analyst]  — your own judgement, read or recommendation. Correct or not, it is YOURS.',
  '                "[analyst] The lane was lost on the second wave, not in the first fight."',
  'Every string field in the report starts with exactly one of those three tags. A claim you cannot tag is a',
  'claim you cannot support — cut it. NEVER tag a judgement [data] to make it look harder than it is; that',
  'inversion is the single failure this report format exists to prevent.',
  '',
  'Grounding rules:',
  '- Canonical names ONLY: every hero, item, and ability name matches the lexicon spelling exactly.',
  ...(dataFree ? [
    '- NO MATCH DATA THIS RUN — the digest is absent. Nothing can earn a [data] tag: a claim only the',
    '  scoreboard could prove has no place in this report. Leave every data-only field empty ("" / []):',
    '  laneVerdict, soulsCurveRead, deathAnalysis, objectiveWindows, swings — unless the comms transcript',
    '  itself voiced that read. NEVER write filler like "no individual curve discussed" — an empty field',
    '  renders as "Not analyzed." and costs nothing. Filler costs trust.',
  ] : [
    '- Only claim what the data supports. ANY field the digest cannot support is left "" / [] rather than',
    '  guessed — laneVerdict without a lane curve, soulsCurveRead without souls data, itemCritique without a',
    '  build, deathAnalysis without deaths, hero/lane the digest never names. An empty field renders as',
    '  "Not analyzed." and costs nothing. Filler costs trust.',
  ]),
  '- Stamp sources: times from the DIGEST are GAME clock (match time), written m:ss or h:mm:ss with NO letter',
  '  after them — there is no recording behind them. Times from the in-game comms transcript are recording',
  '  stamps: cite them as literal [m:ss] tokens copied VERBATIM from the transcript with a "c" glued to the',
  '  time, no space — [8:12c]. That letter is what makes a stamp clickable in the app (it opens the in-game',
  '  recording at that moment); a bare stamp stays plain text. There is no VOD review in this process, so never',
  '  write an "r" stamp, and never invent a moment neither source contains.',
  '- The short time fields hold a BARE time with NO brackets — deathAnalysis "t", objectiveWindows "t", swings',
  '  "t", callouts "t", an action item\'s "timestamps" entries — and take the same "c" letter when the moment',
  '  came from the comms transcript: write 8:12c there, never [8:12c]. A "t" read off the digest is game clock',
  '  and keeps no letter.',
  '- The in-game comms transcript and the judged comms block, when present, are the ONLY evidence for',
  '  commsGrade. With neither, leave commsGrade.overall "" — do not grade comms you were never shown.',
  '- The coach\'s tagged in-game notes, when present, outrank your read of the same moment: the coach was',
  '  watching live. Where you disagree, say so as [analyst] and name the note.',
  '',
  'Return ONLY a single JSON object (no markdown, no code fences, no commentary) with EXACTLY these keys:',
  '{',
  '  "schemaVersion": 1,',
  '  "playerCards": [                   // one per COACHED-team player (opponents only when they explain something)',
  '                                     // OMIT a player entirely when every field would be empty — a name-only',
  '                                     // shell is not a card, and the roster is not a checklist to fill. No',
  '                                     // player evidenced at all means "playerCards": [].',
  '    { "player": string,              // player name if known, else the hero name',
  '      "hero": string,                // canonical hero name from the digest ("" when no digest names it — never guess one)',
  '      "lane": string,                // assigned lane from the digest ("" when no digest names it — never guess one)',
  ...(dataFree ? [
    '      "laneVerdict": string,         // "" this run — the souls curve does not exist; fill ONLY if comms voiced it',
    '      "soulsCurveRead": string,      // "" this run — no souls data exists',
    '      "itemCritique": string,        // "" unless comms or the patch digest evidence a build read',
    '      "coaching": string,            // GFM markdown; what THIS player should change ("" if nothing stands out)',
    '      "deathAnalysis": [ { "t": string, "what": string, "why": string, "lesson": string } ],  // [] this run unless a death was talked through in comms (t = comms [m:ss])',
    '      "drills": [string] },          // concrete practice items for this player',
    '  ],',
    '  "macro": {',
    '    "tempoRead": string,             // only what the comms evidenced — no data story exists this run',
    '    "objectiveWindows": [ { "t": string, "event": string, "verdict": string, "why": string } ],  // [] unless comms called the window',
    '    "laneMap": string,               // "" unless comms voiced the lane picture',
    '    "swings": [ { "t": string, "direction": string, "cause": string } ]  // [] unless comms marked the swing',
    '  },',
  ] : [
    '      "laneVerdict": string,         // won/lost/even + why, off the lane souls curve ("" when the data cannot say)',
    '      "soulsCurveRead": string,      // their economic arc: farm pace, spikes, droughts, vs counterpart',
    '      "itemCritique": string,        // build-order judgement vs the game state and patch digest',
    '      "coaching": string,            // GFM markdown; what THIS player should change ("" if nothing stands out)',
    '      "deathAnalysis": [ { "t": string, "what": string, "why": string, "lesson": string } ],  // t = GAME clock',
    '      "drills": [string] },          // concrete practice items for this player',
    '  ],',
    '  "macro": {',
    '    "tempoRead": string,             // the match\'s tempo story, grounded in swings + objectives',
    '    "objectiveWindows": [ { "t": string, "event": string, "verdict": string, "why": string } ],',
    '    "laneMap": string,               // which lanes won/lost and how that shaped the map',
    '    "swings": [ { "t": string, "direction": string, "cause": string } ]',
    '  },',
  ]),
  '  "commsGrade": {                    // "" / [] throughout when no in-game comms block was attached',
  '    "overall": string,               // letter grade + one-line justification',
  '    "callouts": [ { "t": string, "who": string, "call": string, "verdict": string, "evidence": string } ],',
  '    "missed": [string]               // moments the data says demanded a call that never came',
  '  },',
  '  "sections": [                      // one entry per substantial topic this match raises',
  '    { "id": string,                  // short stable kebab-case slug of the heading',
  '      "heading": string,             // name the section after the topic ("Losing the Mid Lane", "The 24:00 Fight")',
  '      "md": string }                 // full GFM markdown body; bullets, numbered steps and tables all allowed',
  '  ],',
  '  "actionItems": [                   // YOUR OWN suggestions — concrete things to change; DEDUPE near-identical asks',
  '    { "id": string,                  // short stable kebab-case slug of the item',
  '      "text": string,                // the action, imperative, [analyst]-tagged like every other claim',
  '      "count": number,               // how many distinct moments raised it (>=1)',
  '      "timestamps": [string],        // transcript [m:ss] stamps where it shows; [] without a transcript',
  '      "player": string|null,         // the player it targets, or null if team-wide',
  '      "metric": string|null,         // leave null (measurable-goal mapping is a later phase)',
  '      "status": "pending" }          // always "pending" — the app owns done/pending',
  '  ],',
  '  "qa": [],                          // ALWAYS the empty array — no review session happened; Q&A belongs to Process 2',
  '  "keepDoing": [string],             // what this team did well, by name',
  '  "debates": [string],               // genuinely two-sided calls you cannot settle from the data alone',
  '  "followUps": [],                   // ALWAYS the empty array — prior-homework judging belongs to Process 2',
  '  "meta": {',
  '    "warnings": [string],            // anything you could not verify or had to assume',
  '    "speakerMap": {}                 // resolved comms labels, see Speaker identity below:',
  '                                     // { "Speaker 3": { "name": "Celeste", "confidence": "high"|"low", "evidence": "[12:04] addressed by name" } }',
  '  }',
  '}',
  '',
  'Writing rules — the same house style as the scrim report:',
  '- Section order tells the story: what decided the match first, then the lessons in it, then what to practice.',
  '- House style for a section point: a **bolded lead that is a self-contained takeaway** ending with a colon,',
  '  readable on its own, with the proof/numbers/example after it. A bare topic label ("**Shred.**") is a failure.',
  '- Prose economy: state the reasoning ONCE, in the fewest words that still teach it. Density, not fewer points.',
  '- Say-it-once: every insight has exactly ONE home. Anywhere else it is a one-line pointer ("see the <heading>',
  '  section") — a player card never re-argues a section it points at.',
  '- Every number pair names its side ("31-16 in North\'s favor"), and never narrate your own reasoning',
  '  ("...actually", "wait —") — state the settled claim.',
  '- Empty is better than filler. An array with nothing real in it is [].',
  '',
  'Attribution fidelity — a point keeps the voice that raised it:',
  '- When authorship changes the meaning, name WHO: a player who called a play, proposed an idea,',
  '  diagnosed their own mistake, or argued against a teammate is named ("the Celeste player called the',
  '  rotation early"). Absorbing a player\'s in-game read into your own [analyst] voice is a',
  '  misattribution, not a simplification.',
  '- Scope it: your own analysis stays unattributed. Do NOT grow an "X said" prefix on every line —',
  '  attribute calls, proposals, self-diagnoses, purchases/actions and disagreements only.',
  '- Actions belong to their actor. An item ONE player bought never lands on another player\'s card, and',
  '  a death, rotation or call is credited to the player who made it.',
  '- Name the concrete person, never a vague stand-in ("someone", "a player", "an outside observer").',
  '',
  'Speaker identity — resolve comms labels before writing:',
  '- The comms transcript may label talkers "Speaker N". Resolve each to a real name using the roster in',
  '  the team context plus the transcript itself: self-reference ("my Infernus died there"), being',
  '  addressed by name, POV ownership of a play, or the digest (who died, who was where, when they spoke).',
  '- Map ONLY on two independent clues. A confidently wrong name is worse than no name; one weak clue is',
  '  not a mapping.',
  '- NO user-facing field may contain "Speaker N" — not playerCards[].player, commsGrade callouts, section',
  '  prose, keepDoing, debates or action items. Unresolved → a role descriptor instead ("the Celeste',
  '  player", "the mid-laner"), never the raw label.',
  '- Record every mapping you made in meta.speakerMap with its confidence and the evidence that proves',
  '  it. Resolved nothing → leave it {}.',
  ].join('\n');
}

// The default (data-bearing) prompt — the shape selftests and any static reader see.
export const MATCH_REPORT_SYSTEM_PROMPT = buildMatchReportSystemPrompt();

// User prompt: digest + optional in-game comms transcript + optional comms judgments + optional
// coach notes + brain. The transcript block arrives raw (buildTranscriptBlock output); the header
// is added here so every input section is labeled in one place.
export function buildMatchReportPrompt({ digest = '', coachedTeam = '', commsBlock = '', tfCommsBlock = '', coachNotesBlock = '', brainContext = '' }) {
  const lines = [`Coached team: ${coachedTeam || '(unnamed)'}.`];
  if (String(brainContext).trim()) lines.push('', '=== ANALYST BRAIN ===', String(brainContext).trim());
  if (String(commsBlock).trim()) lines.push('', '=== IN-GAME COMMS TRANSCRIPT ===', String(commsBlock).trim());
  if (String(tfCommsBlock).trim()) lines.push('', String(tfCommsBlock).trim());
  if (String(coachNotesBlock).trim()) {
    lines.push('', 'Coach\'s tagged in-game notes (chess.com-style classifications):', String(coachNotesBlock).trim());
  }
  if (!String(commsBlock).trim() && !String(tfCommsBlock).trim()) {
    lines.push('', '=== NO IN-GAME COMMS ATTACHED ===',
      'No comms transcript or comms review exists for this match. Leave commsGrade.overall "" and its arrays empty — grading comms you were never shown is exactly the invented claim this report format forbids.');
  }
  lines.push('', '=== MATCH DATA DIGEST ===', String(digest).trim() || '(no digest)');
  return lines.join('\n');
}

// Same contract as vodReport.coerceReport: guarantee every key exists so the view never branches on
// undefined, and never throw on a malformed model payload.
export function coerceMatchReport(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => String(v ?? '');
  return {
    schemaVersion: Number(o.schemaVersion) > 0 ? Math.floor(Number(o.schemaVersion)) : MATCH_REPORT_SCHEMA_VERSION,
    playerCards: arr(o.playerCards).map((c) => ({
      player: str(c?.player), hero: str(c?.hero), lane: str(c?.lane),
      laneVerdict: str(c?.laneVerdict), soulsCurveRead: str(c?.soulsCurveRead), itemCritique: str(c?.itemCritique),
      coaching: str(c?.coaching),
      deathAnalysis: arr(c?.deathAnalysis).map((d) => ({ t: str(d?.t), what: str(d?.what), why: str(d?.why), lesson: str(d?.lesson) })),
      drills: arr(c?.drills).map(String),
    })).filter((c) => c.player || c.hero),
    macro: {
      tempoRead: str(o.macro?.tempoRead),
      objectiveWindows: arr(o.macro?.objectiveWindows).map((w) => ({ t: str(w?.t), event: str(w?.event), verdict: str(w?.verdict), why: str(w?.why) })),
      laneMap: str(o.macro?.laneMap),
      swings: arr(o.macro?.swings).map((s) => ({ t: str(s?.t), direction: str(s?.direction), cause: str(s?.cause) })),
    },
    commsGrade: {
      overall: str(o.commsGrade?.overall),
      callouts: arr(o.commsGrade?.callouts).map((c) => ({ t: str(c?.t), who: str(c?.who), call: str(c?.call), verdict: str(c?.verdict), evidence: str(c?.evidence) })),
      missed: arr(o.commsGrade?.missed).map(String),
    },
    sections: arr(o.sections).map((s) => ({
      id: String(s?.id || slug(s?.heading)),
      heading: str(s?.heading),
      md: str(s?.md),
    })).filter((s) => s.heading || s.md),
    // Full-shape keys (M3) so a .matchfinal rendered through this coercer keeps them; stable ids
    // feed reconciliation — same id fallback as vodReport.slugId (never re-key on regenerate).
    actionItems: arr(o.actionItems).map((it) => ({
      id: String(it?.id || slug(it?.text)),
      text: str(it?.text),
      count: Number(it?.count) > 0 ? Math.floor(Number(it.count)) : 1,
      timestamps: arr(it?.timestamps).map(String),
      player: it?.player ? String(it.player) : null,
      metric: it?.metric ? String(it.metric) : null,
      status: it?.status === 'done' ? 'done' : 'pending',
    })),
    qa: arr(o.qa).map((x) => ({ q: str(x?.q), a: str(x?.a), askedBy: x?.askedBy ? String(x.askedBy) : null, t: x?.t ? String(x.t) : null })),
    keepDoing: arr(o.keepDoing).map(String),
    debates: arr(o.debates).map(String),
    followUps: arr(o.followUps).map((f) => ({
      priorItem: str(f?.priorItem),
      verdict: ['resolved', 'persisting', 'unclear'].includes(f?.verdict) ? f.verdict : 'unclear',
      evidence: str(f?.evidence),
    })),
    meta: {
      warnings: arr(o.meta?.warnings).map(String),
      // M10: resolved "Speaker N" → roster name with the evidence behind each mapping. Same shape as
      // coerceReport's so one reader serves both reports; absent / non-object → {}.
      speakerMap: o.meta?.speakerMap && typeof o.meta.speakerMap === 'object' && !Array.isArray(o.meta.speakerMap)
        ? Object.fromEntries(Object.entries(o.meta.speakerMap).map(([k, v]) => [String(k), {
          name: str(v?.name), confidence: v?.confidence === 'high' ? 'high' : 'low', evidence: str(v?.evidence),
        }]))
        : {},
      // M24 writes reconciliation verdicts back here after a scrim report judges this match's
      // [analyst] claims; until then the view banners the report as not-yet-coach-reviewed.
      reviewed: str(o.meta?.reviewed),
      reconciliation: arr(o.meta?.reconciliation).map((r) => ({
        claim: str(r?.claim),
        verdict: ['confirmed', 'overridden', 'unaddressed'].includes(r?.verdict) ? r.verdict : 'unaddressed',
        note: str(r?.note),
      })),
    },
  };
}

function slug(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

// Tolerant parse mirroring vodReport.parseReport: strip a fence, slice the outermost {…}, coerce.
export function parseMatchReport(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) throw new Error('no JSON object in model output');
  return coerceMatchReport(JSON.parse(t.slice(a, b + 1)));
}

// Process 1 invariant (M3): a FIRST report never carries Q&A or follow-ups — no review session
// happened, and both belong to Process 2. Enforced in code, not just the prompt.
export function enforceFirstReport(report) {
  report.qa = [];
  report.followUps = [];
  return report;
}

// DI'd invoke (like generateReport) → generate + parse. Reprompts once, then lets the second failure
// throw: a failed draft is a failed report, and the caller owns the error toast.
export async function generateMatchReport(invoke, { digest, coachedTeam = '', commsBlock = '', tfCommsBlock = '', coachNotesBlock = '', brainContext = '', onRaw = null }, agents = {}) {
  const user = buildMatchReportPrompt({ digest, coachedTeam, commsBlock, tfCommsBlock, coachNotesBlock, brainContext });
  // M5: an empty digest flips the schema itself to the data-free variant (see the builder's comment).
  const call = (userPrompt) => invoke('coaching_classify_match', {
    systemPrompt: buildMatchReportSystemPrompt({ dataFree: !String(digest ?? '').trim() }),
    userPrompt,
    backend: agents.authBackend || 'api-key',
    model: agents.model || 'opus',
    cliPath: agents.claudeCliPath || '',
  });
  const report = await parseOrRetry(call, user, parseMatchReport, 'Respond with ONLY the JSON object, nothing else.', onRaw);
  report.schemaVersion = MATCH_REPORT_SCHEMA_VERSION; // stamp regardless of what the model echoed
  return enforceFirstReport(report);
}

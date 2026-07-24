// vodReport.js — VOD Review Report (Deadlock Scrim Coaching, sub-plan 11). Pure ESM (no React,
// no @host) so the prompt/parse/reconcile logic round-trips through a Node harness like
// autoClassify.js / deathAudit.js. Turns a diarized VOD-review transcript (the post-match session
// where the coach + players talk through the game) into an actionable coaching report via Claude,
// reusing the generic coaching_classify_match(systemPrompt, userPrompt, backend, model, cliPath)
// bridge (no new Rust). Opus by default. Section length is UNCAPPED (the 2026-07-19 caps were
// reverted 2026-07-20 — see VOD_REPORT_SYSTEM_PROMPT); the real ceiling is the 32k max_tokens in
// coaching.rs classify_via_api, and the draft call gets the full 20-min wall to reach it.
//
// Report JSON shape (what Claude returns, what VodReportView renders, what the .vodreport sidecar
// stores):
//   { sections:[{id, heading, md}],   (tldr: retired 2026-07-19 — coerced for old sidecars, never generated/shown)
//     actionItems:[{id, text, count, timestamps[], player?, metric?, status}],
//     qa:[{q, a, askedBy, t}], keepDoing[], debates[], followUps:[{priorItem, verdict, evidence}] }
//   status ∈ 'pending' | 'done' — the checkbox state, reconciled across regenerates by stable id.
//   sections = dynamic per-scrim topic pages (taught lessons/frameworks) in GFM markdown; time
//   references inside md are literal [m:ss] tokens the view swaps for jump chips.

// Whole-second time → m:ss, or h:mm:ss once past the hour (standalone so the Node harness needs no
// matchData import). The hour part is REQUIRED: these stamps are read next to the same VOD uploaded
// to YouTube, and YouTube renders 4045s as "1:07:25" — a bare "67:25" makes the notes and the video
// disagree on every moment past 1:00:00 (a 71-minute review put 32 such stamps in one report).
import { parseOrRetry } from './aiRetry.js';

export function mmss(s) {
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0) return '0:00';
  const w = Math.floor(v);
  const h = Math.floor(w / 3600);
  const m = Math.floor(w / 60) % 60;
  const ss = String(w % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// M18 — a stamp token may carry a one-letter SOURCE glued to the time: "r" = the VOD-review
// recording, "c" = the in-game comms recording, no letter = game clock. Untagged is deliberately
// INERT (renders as muted, unclickable game clock) rather than guessed from which process wrote the
// report: a chip that is missing is a smaller failure than a chip that jumps to the wrong moment, so
// the model has to opt a stamp IN to being a link. A range token (M19) carries its letter on the end.
export const STAMP_SOURCE = { r: 'review', c: 'comms', '': 'clock' };
const STAMP_BODY = '\\[\\d+:\\d{2}(?::\\d{2})?(?:–\\d+:\\d{2}(?::\\d{2})?)?[rc]?\\]';
export const STAMP_SPLIT_RE = new RegExp(`(${STAMP_BODY})`, 'g'); // split() keeps the token as its own part
const STAMP_ONE_RE = /^\[(\d+:\d{2}(?::\d{2})?(?:–\d+:\d{2}(?::\d{2})?)?)([rc]?)\]$/;

// "[27:49r]" -> { t: "27:49", letter: "r", source: "review" }. null when it is not a stamp token.
export function parseStamp(token) {
  const m = String(token ?? '').match(STAMP_ONE_RE);
  return m ? { t: m[1], letter: m[2], source: STAMP_SOURCE[m[2]] } : null;
}

// The segment a stamp points at: exact whole-second start, else the first segment at/after it, else
// the last row (-1 only when there are no segments at all). Shared by every jump target — the scrim
// report's own Segments tab and the per-match Comms/Review Segments pages — so a chip and the row it
// lands on can never disagree. A range token ([first–last]) lands on its START.
export function segIndexForStamp(segments, t) {
  const segs = Array.isArray(segments) ? segments : [];
  if (!segs.length) return -1;
  const tSec = String(t ?? '').split('–')[0].split(':').map(Number)
    .reduce((acc, n) => acc * 60 + (Number.isFinite(n) ? n : 0), 0);
  let i = segs.findIndex((s) => Math.floor((Number(s.t0Ms) || 0) / 1000) === tSec);
  if (i === -1) i = segs.findIndex((s) => (Number(s.t0Ms) || 0) >= tSec * 1000);
  return i === -1 ? segs.length - 1 : i;
}

// M15: collapse a whitespace-separated run of ≥3 bracketed [m:ss] stamps whose consecutive gaps are
// all ≤45s into one [first–last] range (en-dash). Runs of <3, or broken by a >45s (or backward) gap,
// keep their individual chips; only stamps separated by whitespace alone fold (a chain on one point),
// never two references with prose between them. Idempotent — a range token holds an en-dash so it no
// longer matches the single-stamp run regex. The view (linkTimeTokens + M14 stamped + jumpToSegment)
// reads the range token and jumps to its start.
export function collapseStampRuns(text) {
  const s = String(text ?? '');
  if (!s) return s;
  const toSec = (t) => t.split(':').map(Number).reduce((a, n) => a * 60 + (Number.isFinite(n) ? n : 0), 0);
  return s.replace(/\[\d+:\d{2}(?::\d{2})?[rc]?\](?:\s+\[\d+:\d{2}(?::\d{2})?[rc]?\])+/g, (run) => {
    const stamps = run.match(/\[\d+:\d{2}(?::\d{2})?[rc]?\]/g).map(parseStamp);
    const groups = [[stamps[0]]];
    for (let i = 1; i < stamps.length; i++) {
      const gap = toSec(stamps[i].t) - toSec(stamps[i - 1].t);
      // M18: never fold across SOURCES. Two recordings' stamps look alike but a range spanning them
      // would claim a stretch of one recording that the other half never happened in.
      const sameSource = stamps[i].letter === stamps[i - 1].letter;
      if (sameSource && gap >= 0 && gap <= 45) groups[groups.length - 1].push(stamps[i]);
      else groups.push([stamps[i]]);
    }
    return groups.map((g) => (g.length >= 3
      ? `[${g[0].t}–${g[g.length - 1].t}${g[0].letter}]`
      : g.map((x) => `[${x.t}${x.letter}]`).join(' '))).join(' ');
  });
}

// Deterministic stamp validation (ported from vodReportGate.mjs so it runs in-pipeline, not just in
// the standalone gate). `segments` comes in two shapes:
//   • an ARRAY — the scrim report's one recording: every m:ss / h:mm:ss token in the report must land
//     inside one of these segments (±5s), source letters ignored.
//   • { review, comms } — a match report (M18): each stamp is checked against its OWN recording, read
//     from the source letter glued to the time ("27:49r"). A bare time is a game clock — no recording
//     behind it — and is skipped, as is a tagged stamp whose recording was not supplied; both follow
//     the array form's long-standing "nothing to check against → no-op" contract.
// Returns the offending stamps as mmss text, deduped ([] when clean). `matchSummaries` is excluded —
// its game-clock times aren't VOD stamps (owned by the deterministic match digest; added with M24),
// so validating them here is a false positive.
export function validateStamps(report, segments = []) {
  const clean = (a) => (Array.isArray(a) ? a : []).filter((s) => s && Number.isFinite(Number(s.t0Ms)));
  const TOL = 5000; // segments are ~2.5s apart; ±5s covers rounding
  const checker = (segs) => {
    if (!segs.length) return null;
    const spanEnd = Math.max(...segs.map((s) => Number(s.t1Ms) || 0));
    return (sec) => {
      const ms = sec * 1000;
      if (ms < 0 || ms > spanEnd + TOL) return false;
      return segs.some((s) => ms >= Number(s.t0Ms) - TOL && ms <= Number(s.t1Ms) + TOL);
    };
  };
  const { matchSummaries, ...rest } = report || {};
  void matchSummaries;
  // A range token (M19) carries its letter once, on the END: "[27:49–28:20r]". Split it into two
  // tagged stamps first so the START is validated against the right recording instead of reading as
  // an untagged game clock.
  const text = JSON.stringify(rest)
    .replace(/\[(\d+:\d{2}(?::\d{2})?)–(\d+:\d{2}(?::\d{2})?)([rc]?)\]/g, (_m, a, b, l) => `[${a}${l}] [${b}${l}]`);
  // Trailing `(?!\d)` rather than `\b`: M18 glues a source letter onto the time ("27:49r"), and a
  // word boundary between a digit and a letter does not exist — `\b` here would have silently
  // stopped validating every tagged stamp, which is exactly the set worth validating.
  const RE = /\b(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)(?!\d)([rc]?)/g;
  const secs = (m) => (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  if (Array.isArray(segments)) {
    const inSeg = checker(clean(segments));
    if (!inSeg) return [];
    return [...new Set([...text.matchAll(RE)].map(secs))].filter((s) => !inSeg(s)).map(mmss);
  }
  const inSource = { review: checker(clean(segments?.review)), comms: checker(clean(segments?.comms)) };
  const bad = new Set();
  for (const m of text.matchAll(RE)) {
    const inSeg = inSource[STAMP_SOURCE[m[4]]]; // no letter → 'clock' → undefined → skipped
    if (inSeg && !inSeg(secs(m))) bad.add(secs(m));
  }
  return [...bad].map(mmss);
}

// Deterministic stable id from an item's text: lets reconcile match carried-forward items even if
// Claude forgets to echo the prior id (same wording → same id). Lowercased, non-alnum → '-', capped.
export function slugId(text) {
  return String(text ?? '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

// Build the speaker-labeled, m:ss-stamped transcript block Claude reads, from the .vodcomms sidecar
// segments ({t0Ms, t1Ms, text, speaker}). Empty-text segments dropped.
export function buildTranscriptBlock(segments = []) {
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => s && String(s.text ?? '').trim())
    .map((s) => `[${mmss((Number(s.t0Ms) || 0) / 1000)}] ${s.speaker || 'Unknown'}: ${String(s.text).trim()}`)
    .join('\n');
}

// Schema v2 (Analyst pipeline, Move 10): superset of v1 — playerCards / macro / commsGrade / meta
// join the v1 keys. Old sidecars coerce cleanly (absent keys default); fresh reports are stamped.
export const REPORT_SCHEMA_VERSION = 2;

export const VOD_REPORT_SYSTEM_PROMPT = [
  'You are an elite Deadlock analyst-coach — the standard is that this report replaces a paid human coach.',
  'You are given a post-match VOD-review transcript (speaker-labeled, timestamped [m:ss]), a deterministic',
  'match-data digest per game (scoreboards, souls curves, item builds, deaths, objectives, damage focus),',
  'the coach\'s tagged in-game notes, and an ANALYST BRAIN (charter, canonical lexicon, patch digest, taught',
  'concepts, distilled corrections). The coach is the person whose lines answer questions and direct the',
  'review; the others are the coached team\'s players.',
  '',
  'Hard rules:',
  '- Canonical names ONLY: every hero, item, and ability name must match the lexicon spelling exactly.',
  '- Every point cites evidence — a [m:ss] transcript timestamp (something the coach said or showed) or a',
  '  deterministic match-digest fact. Brain / patch-digest content is NOT citable evidence for a point. No',
  '  point floats free — a point with no transcript stamp and no match-digest fact behind it does not belong.',
  '- Cross-reference talk against data: when a player asserts something ("we were even in souls"), check it',
  '  against the digest curves and say whether the data agrees.',
  '- Comms grading = transcript claims checked against digest events, callout by callout.',
  '- Layered depth: sections carry the taught material and the game review; playerCards / macro / commsGrade',
  '  carry the per-player and per-moment analysis.',
  '- Report ONLY the review that actually happened. Every point comes from what the coach said or showed in',
  '  the transcript, or from a deterministic match-digest fact. Never invent content, and never add your own',
  '  analysis, opinion, or coaching point the coach did not voice — even if it is correct. You organize and',
  '  sharpen the coach\'s review; you do not augment it with your own conclusions.',
  '- The ANALYST BRAIN is for GROUNDING ONLY, never a source of report content. Use the lexicon for canonical',
  '  spelling; use the patch digest / taught concepts / corrections ONLY to check or correct a claim the coach',
  '  actually made (e.g. fix a misremembered number). NEVER surface a brain or patch-digest fact as its own',
  '  point. A point that exists only because the patch notes say so — no [m:ss] stamp, nobody raised it in the',
  '  VOD (e.g. "Patch context reinforces the call: Flame Dash was nerfed") — is exactly the failure to avoid.',
  '',
  'Return ONLY a single JSON object (no markdown, no code fences, no commentary) with EXACTLY these keys:',
  '{',
  '  "schemaVersion": 2,',
  '  "playerCards": [                   // one per COACHED-team player (opponents only if discussed)',
  '    { "player": string,              // player name (transcript speaker) or hero name if unnamed',
  '      "hero": string,                // canonical hero name from the digest',
  '      "lane": string,                // assigned lane from the digest',
  '      "laneVerdict": string,         // won/lost/even + why, grounded in the lane souls curve',
  '      "soulsCurveRead": string,      // their economic arc: farm pace, spikes, droughts, vs counterpart',
  '      "itemCritique": string,        // build-order judgement vs the game state and patch digest',
  '      "coaching": string,            // GFM markdown; frameworks/loops taught specifically to THIS player ("" if none)',
  '      "deathAnalysis": [ { "t": string, "what": string, "why": string, "lesson": string } ],',
  '      "drills": [string] },          // concrete practice items for this player',
  '  ],',
  '  "macro": {',
  '    "tempoRead": string,             // the match\'s tempo story, grounded in swings + objectives',
  '    "objectiveWindows": [ { "t": string, "event": string, "verdict": string, "why": string } ],',
  '    "laneMap": string,               // which lanes won/lost and how that shaped the map',
  '    "swings": [ { "t": string, "direction": string, "cause": string } ]',
  '  },',
  '  "commsGrade": {',
  '    "overall": string,               // letter grade + one-line justification',
  '    "callouts": [ { "t": string, "who": string, "call": string, "verdict": string, "evidence": string } ],',
  '    "missed": [string]               // moments the data says demanded a call that never came',
  '  },',
  '  "sections": [                      // one entry per substantial topic taught or discussed at length',
  '    { "id": string,                  // short stable kebab-case slug of the heading',
  '      "heading": string,             // name the section after the topic itself ("Tempo", "Gaining a Lead", ...)',
  '      "md": string }                 // full GFM markdown body: bullets, numbered steps, tables all allowed;',
  '                                     // cite moments as literal [time] tokens copied from the transcript',
  '  ],',
  '  "actionItems": [                   // concrete things to change; DEDUPE near-identical asks',
  '    { "id": string,                  // short stable kebab-case slug of the item; REUSE a prior id if given one',
  '      "text": string,                // the action, imperative ("rotate mid after first tower")',
  '      "count": number,               // how many distinct moments raised it (>=1)',
  '      "timestamps": [string],        // every transcript time where it came up',
  '      "player": string|null,         // the player it targets, or null if team-wide',
  '      "metric": string|null,         // leave null (measurable-goal mapping is a later phase)',
  '      "status": "pending" }          // always "pending" — the app owns done/pending',
  '  ],',
  '  "qa": [ { "q": string, "a": string, "askedBy": string, "t": string } ],  // player question -> coach answer, t = transcript time',
  '  "keepDoing": [string],             // things praised / working well',
  '  "debates": [string],               // points raised but left unresolved',
  '  "followUps": [ { "priorItem": string, "verdict": "resolved"|"persisting"|"unclear", "evidence": string } ],',
  '  "reconciliation": [ { "claim": string, "verdict": "confirmed"|"overridden", "note": string, "stamp": string } ],',
  '                                     // ONLY when a FIRST REPORT (ANALYST) block was given — see the reconciliation rule; else []',
  '  "carry": [ { "kind": "habit"|"plan"|"debate", "text": string, "player": string|null, "stamp": string } ],',
  '                                     // carry-forward index — see the CARRY-FORWARD rule; else []',
  '  "meta": {',
  '    "warnings": [string],            // anything you could not verify or had to assume',
  '    "speakerMap": {}                 // resolved transcript labels, see Speaker identity below:',
  '                                     // { "Speaker 3": { "name": "Celeste", "confidence": "high"|"low", "evidence": "[12:04] addressed by name" } }',
  '  }',
  '}',
  '',
  'Rules: every timestamp is a time string copied VERBATIM from the transcript, hour part included past',
  '1:00:00 (m:ss under the hour, h:mm:ss over it) — never reformat or recompute one. Never invent content not',
  'in the transcript or notes. Merge duplicate action items and bump their count instead of repeating. If a',
  'section has nothing, use an empty array. Keep it tight — this is a coach\'s cheat sheet, not a summary essay.',
  '',
  'Stamp sources: every [m:ss] token carries a one-letter source glued to the time, no space — "r" when the',
  'moment is in the VOD-REVIEW transcript (the coach talking over the game), "c" when it is in the IN-GAME',
  'COMMS transcript (the players talking during the match). A GAME-CLOCK time — match time from the digest,',
  '"the mid boss at 12:00" — carries NO letter, because there is no recording behind it. Examples: [27:49r],',
  '[8:12c], [12:00]. That letter is what makes a stamp clickable: an "r" stamp opens the review recording at',
  'that moment, a "c" stamp opens the in-game recording, and a bare stamp stays plain text. A wrong letter',
  'lands the coach in the wrong recording, so when you are not certain which transcript a moment came from,',
  'leave the letter off. Ranges keep one letter at the end: [27:49–28:20r].',
  'The short time fields hold a BARE time with NO brackets — deathAnalysis "t", objectiveWindows "t",',
  'swings "t", callouts "t", an action item\'s "timestamps" entries, and a qa "t" — and they take the',
  'same letter: write 8:12c or 27:49r there, never [8:12c]. The letter makes those times clickable too;',
  'a bare one stays plain text. A swings or objectiveWindows "t" read off the digest is game clock, so',
  'it keeps no letter.',
  '',
  'Say-it-once: every insight has exactly ONE home (a section, a player-card field, or an action item).',
  'Anywhere else it is a one-line pointer ("see the <heading> section"), never re-explained. The "qa" field is',
  'the ONE deliberate exception and is EXEMPT from consolidation: capture EVERY genuine player question the',
  'coach actually answered as its own qa entry — even when that question\'s content also lives in a section or',
  'action item. A question is not "already covered" by its section; the question deserves its own answer. Do',
  'NOT thin qa down to a token few (a real review has as many qa entries as questions were asked and answered);',
  'placing the fuller explanation in a section is correct, but the qa entry still gets made, restating the',
  'conclusion in brief. Only skip a question that is throwaway trivia the coach brushed off.',
  '',
  'Say-it-once, player cards specifically: when a section owns a topic (a build, an item plan, a draft read),',
  'that player\'s "itemCritique" / "coaching" states the VERDICT in at most two sentences plus a pointer ("see',
  'the <heading> section"). It never re-lists the build steps, re-argues the case, or reproduces the section\'s',
  'table. Re-explaining an owning section inside a player card is the failure this rule exists to stop.',
  '',
  'PROCEDURE for qa — do this as a deliberate sweep, not from memory: read the transcript end-to-end and, for',
  'every question a player asked aloud that the coach or a teammate then answered, emit one qa entry. This',
  'INCLUDES macro/strategic questions whose fuller answer became a section — "why did we have kills but no soul',
  'lead", "is no one doing jungle", "what does <hero> even do this game", "what should we dispel". The section',
  'holds the explanation; the qa entry restates the answer in one sentence. Never judge such a question "already',
  'covered" and drop it. A 30-45 minute review typically holds 6-12 answered questions — a qa array of only 2-5',
  'means you consolidated answered questions into sections and MUST go back and extract each into qa.',
  '',
  'Quote sparingly. Paraphrase is the default: the reader has the [m:ss] stamp and can hear the original for',
  'themselves. Use the coach\'s exact words ONLY when the wording IS the point and no paraphrase carries it — a',
  'coined phrase, a rule stated as a memorable line, a verdict whose exact phrasing matters. If a paraphrase',
  'loses nothing, paraphrase. NEVER: quote a short fragment as an evidence anchor ("we destroyed them in lane",',
  '"this is good to be stacked up on") — the stamp IS the evidence; open or decorate a point with a quote;',
  'restate in a quote what the surrounding sentence already said; paste a long run of table-talk in place of',
  'written analysis; or quote the same line in two places. A whole report carries a handful of quotes, not one',
  'per point. Paraphrase-ONLY fields, zero direct quotes: "macro", "commsGrade", "keepDoing", "debates",',
  '"followUps", and the playerCards one-line fields "laneVerdict" and "soulsCurveRead". The "qa" field is the',
  'one exemption — a coach\'s answer there stays as spoken. This exemption is ONLY about quoting; it never means',
  '"emit fewer qa entries". Populate qa fully per the Say-it-once rule above — the anti-quote guidance must not',
  'thin the Q&A section.',
  '',
  'Quoting less changes WORDING ONLY — never coverage. It strips quotation marks, not content. Every section,',
  'point, player card, Q&A pair, objective window, callout, follow-up, action item and timestamp that belonged',
  'in the report still belongs in it, written out in your own words. An entry whose source material was a quote',
  'gets PARAPHRASED, never dropped: a paraphrase-only field means "rewrite every entry here", NOT "keep only the',
  'entries that survive without a quote" — dropping an objective window, a callout or a Q&A pair because its',
  'evidence was something the coach said is the exact failure this rule must not cause. Removing quotes should',
  'make a section gain explanation, never lose points. Judge the finished report by whether it covers the same',
  'ground as one written with quotes, in fewer borrowed words.',
  '',
  'Attribution fidelity — a point keeps the voice that raised it:',
  '- When authorship changes the meaning, name WHO: a player who proposed an idea, diagnosed their own',
  '  mistake, disagreed, or asked for something is named ("the Celeste player suggested holding the ult").',
  '  Silently absorbing a player\'s insight into the coach\'s voice is a misattribution, not a simplification.',
  '- Scope it: routine coach analysis stays unattributed. Do NOT grow an "X said" prefix on every line —',
  '  attribute proposals, self-diagnoses, purchases/actions, disagreements and questions only.',
  '- Actions belong to their actor. An item ONE player bought never lands on another player\'s card, and a',
  '  death, rotation or call is credited to the player who made it.',
  '- A question two players asked together names both askers in "askedBy".',
  '- Name the concrete person, never a vague stand-in ("an outside observer", "someone", "a viewer").',
  '',
  'Speaker identity — resolve labels before writing:',
  '- The transcript may label talkers "Speaker N". Resolve each to a real name using the roster in the team',
  '  context plus the transcript itself: self-reference ("my Infernus died there"), being addressed by name,',
  '  POV ownership of a play, or the coach naming them.',
  '- Map ONLY on two independent clues. A confidently wrong name is worse than no name; one weak clue is not',
  '  a mapping.',
  '- NO user-facing field may contain "Speaker N" — not playerCards[].player, qa[].askedBy, commsGrade',
  '  callouts, section prose, keepDoing, debates or action items. Unresolved → a role descriptor instead',
  '  ("the Celeste player", "the mid-laner"), never the raw label.',
  '- Record every mapping you made in meta.speakerMap with its confidence and the evidence that proves it.',
  '  Resolved nothing → leave it {}.',
  '',
  'Debate & nuance fidelity:',
  '- When a topic had sides, keep the sides straight: each argument stays attributed to whoever argued it.',
  '  Never merge two positions into one voice, and never cross-wire an argument onto the person who opposed it.',
  '- Preserve accepted alternatives: when the coach allows a secondary line ("that order also works if you are',
  '  behind"), the alternative survives into the report — not just the primary.',
  '- Keep credibility citations attached to their claim ("what <player/team> runs").',
  '- When a speaker CHANGED position during the review, record the shift (before → after), not only the',
  '  end state.',
  '- Keep conditionals and magnitude words that change the lesson: "many times", "contestable — cooldowns were',
  '  up", "only when ahead". Dropping the qualifier turns a conditional lesson into a false absolute.',
  '',
  'Causal chains stay joined: when the review links moments into a chain (a technique miss → the enemy escapes',
  '→ the ability whiffs → the fight is lost), state the FULL chain once in the section that owns its lesson, and',
  'leave a one-line pointer from every other topic it touches ("same sequence as the <heading> section"). Halves',
  'of one causal story sitting in two sections with neither naming the other is the failure.',
  '',
  'PROCEDURE for praise — a deliberate end-to-end sweep, exactly like the qa sweep: read the transcript through',
  'and capture EVERY voiced positive. Team-wide praise goes in "keepDoing"; praise of ONE player — including a',
  'single good buy or one good play — goes in that player\'s card. A review that praised people and a report with',
  'an empty keepDoing means the sweep was skipped.',
  '',
  'Habits with history: when the review states a RECURRING pattern and its age ("he has never bought that since',
  'the rework", "he does this every game"), capture it AS a habit WITH the stated age — in the player card\'s',
  '"coaching", or in "followUps" as a persisting pattern. Never flatten a long-running habit into a this-game note.',
  '',
  'Prose hygiene:',
  '- Never narrate your own reasoning, corrections, or uncertainty ("...actually", "wait —", "kills were 16 to',
  '  North\'s... actually 16-vs-31"). State the settled fact only.',
  '- Every number pair names its side: "31–16 in North\'s favor", never a bare ambiguous "16 to 31".',
  '',
  'Comms Grade grades IN-GAME comms — the callouts made during the matches, not how the review session talked:',
  '- When "IN-GAME COMMS JUDGMENTS" blocks are attached, ground commsGrade in them FIRST: cite judged fights and',
  '  missed calls by their game time, and fold in whatever the review said about comms on top.',
  '- With no judgment block attached, grade only what the review session itself evidenced and open',
  '  commsGrade.overall with "(review-talk evidence only)".',
  '',
  'Section rules:',
  '- Order "sections" as a story: what decided the game (macro, economy, the game review) first, then the taught',
  '  lessons and frameworks, then forward-looking plans (next draft, handoffs, what to practice) last.',
  '- One section per substantial topic taught or discussed at length — as many as the session warrants, no cap.',
  '  Minor asides fold into action items or are dropped.',
  '- Sections carry real explanatory detail, not headline bullets. Each point states the principle, the reasoning',
  '  behind it, and the concrete example or consequence from this session, with its time stamp inline. House',
  '  style: a **bolded lead that is a self-contained takeaway** — the reader can read ONLY the bolded lead and',
  '  get the full point; everything after it is OPTIONAL supporting detail (proof, numbers, example, stamp).',
  '  Write the lead as ONE complete, readable statement ending with a colon ":" — full readable words, never',
  '  shorthand ("Position", not "Pos"). A bare topic label is the failure: "**Shred.**" or "**The damage',
  '  proof.**" force the reader into the body to learn anything. Write "**The team lacked shred (raw DPS):**"',
  '  and "**Victor did nearly double Infernus\'s damage on fewer souls:**" instead. Keep the lead to one crisp',
  '  line — a full takeaway, never a crammed paragraph. After it, the explanation follows as prose, bullets, or',
  '  a table, whichever the material fits.',
  '- Prose economy: write each point in the fewest words that still teach it. State the reasoning ONCE — never',
  '  re-phrase the same idea across two or three sentences — and cut narrative framing and color (quoted table-',
  '  talk like "a lot of people will call...", connectors like "better still", filler like "the thing you actually',
  '  care about", "worth far more money"). Fold consecutive stamps on one idea into a single range. Keep the',
  '  principle, one clause of reasoning, the concrete example, and the stamp; drop everything that is only',
  '  re-statement or flavor. Aim for roughly half the words the point would take written conversationally. This is',
  '  writing DENSITY, not fewer points and not shorter sections: every point and every stamp stays, and taught',
  '  frameworks + live worked-example tables are still reproduced in FULL (see the two rules below) — never',
  '  tighten those. Density applies to the explanatory discussion prose only — NOT to the bolded lead, which',
  '  stays a complete self-contained takeaway (see House style above), never shrunk to a one-word label.',
  '- Game-review material (soul distribution, itemization, what went wrong this game) is a normal detailed',
  '  section like any taught lesson — never a list of one-line takeaways.',
  '- A topic aimed at ONE player (their hero\'s gameplay loop, individual coaching) is NEVER a team section —',
  '  it goes in that player\'s "coaching" field instead, full step list intact.',
  '- NEVER compress a taught framework. When the coach lays out steps, a sequence, or a plan, reproduce',
  '  EVERY step, in order, faithful to the coach\'s meaning, inside that topic\'s section (paraphrased, not',
  '  quoted — the step list stays complete, the words are yours). Summarizing a',
  '  taught sequence is a failure.',
  '- A live worked example from the coach (a draft read hero by hero, an item plan) ALWAYS gets its own section,',
  '  table-formatted where the material fits a table — never summarize it away.',
  '- Steps live in their section only. If the coach also assigned it as homework, emit exactly ONE action',
  '  item that references the section ("apply the <heading> plan — see the <heading> section"), never the',
  '  steps themselves.',
  '- Use markdown tables where the discussion is tabular (e.g. behind-in-souls vs ahead-in-souls behaviors).',
  '- Player-written notes (when provided) are supplementary source material for sections; on any conflict',
  '  the transcript wins.',
  '',
  'RECONCILIATION — only when a === FIRST REPORT (ANALYST) === block is present. For each notable [analyst]',
  'claim in it that the review session actually addressed, record one entry in "reconciliation": verdict',
  '"confirmed" when the review agrees with the read, "overridden" when it corrects it; "note" states the',
  'review\'s position in your words (brief), "stamp" is the review moment that settles it. Claims the review',
  'never touched are OMITTED — reconciliation is never padded. With no first-report block, "reconciliation"',
  'is []. The first report is REFERENCE for reconciliation and continuity, never source text to copy — the',
  'review transcript is the primary source of this report.',
  '',
  'CARRY-FORWARD — the "carry" index. Three kinds of thing outlive this match, and the scrim\'s exported',
  'carry-forward sheet is compiled mechanically from this index alone:',
  '- "habit"  — a recurring pattern WITH its stated age ("he has not bought Counterspell since the rework").',
  '- "plan"   — something aimed at the NEXT scrim or session rather than at this match ("draft a shred item',
  '             into the next comp").',
  '- "debate" — a two-sided call the review left genuinely unresolved.',
  'Each entry copies the wording of a point you ALREADY wrote elsewhere in the report, EXACTLY as written.',
  'The index points AT content; it never invents, rewrites or summarizes it, and it is never a new section —',
  'nothing in the report body changes because an entry exists. "player" is the player it belongs to, or null',
  'when team-wide; "stamp" is the transcript moment, "" when there is none.',
  'Index ONLY those three kinds. A normal action item, a praise line, or a lesson taught about THIS match',
  'does not belong here. When in doubt, leave it out — an unindexed point still lives in the report in full.',
  'Nothing that outlives this match was voiced → "carry" is [].',
].join('\n');

// M11: compact the .tfcomms judgment sidecar into one prompt block so commsGrade grades IN-GAME comms
// instead of review-session talk. Only judged calls (verdict set) and missed calls survive — neutral
// callouts are the bulk of a fight and carry no judgment, so dumping them would only cost tokens. A
// fight with nothing judged collapses into the header count.
export function serializeTfComms(fights, label = '') {
  const fs = (Array.isArray(fights) ? fights : []).filter((f) => f && typeof f === 'object');
  if (!fs.length) return '';
  const lines = [];
  let judged = 0;
  let missedN = 0;
  for (const f of fs) {
    const calls = (Array.isArray(f.calls) ? f.calls : []).filter((c) => c && c.verdict);
    const missed = (Array.isArray(f.missed) ? f.missed : []).filter((m) => m && (m.what || m.shouldSay));
    judged += calls.length;
    missedN += missed.length;
    if (!calls.length && !missed.length) continue;
    const jl = f.jumble && f.jumble.label ? ` (${f.jumble.label})` : '';
    lines.push(`Fight ${mmss(Number(f.tStart) || 0)}–${mmss(Number(f.tEnd) || 0)}${jl}:`);
    for (const c of calls) lines.push(`  ${c.verdict} — ${c.speaker || '?'} ${mmss(Number(c.atGame) || 0)}: ${c.text || ''}${c.note ? ` [${c.note}]` : ''}`);
    for (const m of missed) lines.push(`  missed — ${m.what || ''}${m.shouldSay ? ` (should have said: "${m.shouldSay}")` : ''}`);
  }
  const head = `${fs.length} fights reviewed, ${judged} call${judged === 1 ? '' : 's'} judged, ${missedN} missed call${missedN === 1 ? '' : 's'}. Times are GAME clock, not VOD stamps.`;
  return [`=== IN-GAME COMMS JUDGMENTS${label ? ` (${label})` : ''} ===`, head, ...lines].join('\n');
}

// Build the user prompt: transcript + team context + any prior action items to follow up on.
// priorActionItems is [] until sub-plan 12 (Team Progress) feeds it — the follow-up block is
// simply omitted when empty (empty-tolerant), so nothing to rework when D lands.
export function buildReportPrompt({ transcriptBlock, teams = {}, coachedTeam = '', priorActionItems = [], notesBlock = '', brainContext = '', matchDigests = [], coachNotesBlock = '', tfCommsBlocks = [], firstReportBlock = '' }) {
  const lines = [];
  lines.push(`Coached team: ${coachedTeam || '(unnamed)'}${teams.opponent ? ` vs ${teams.opponent}` : ''}.`);
  if (String(brainContext).trim()) {
    lines.push('', '=== ANALYST BRAIN ===', String(brainContext).trim());
  }
  const digests = (Array.isArray(matchDigests) ? matchDigests : []).filter((dg) => String(dg ?? '').trim());
  for (const dg of digests) lines.push('', '=== MATCH DATA DIGEST ===', String(dg).trim());
  for (const tf of (Array.isArray(tfCommsBlocks) ? tfCommsBlocks : [])) {
    if (String(tf ?? '').trim()) lines.push('', String(tf).trim());
  }
  // M4 Process 2: the analyst's first report rides along as REFERENCE — reconciliation source and
  // continuity, never copy material. The hard rule is restated inline because this block is the
  // biggest single input and the most tempting thing to re-narrate.
  if (String(firstReportBlock).trim()) {
    lines.push('', '=== FIRST REPORT (ANALYST) ===',
      'Reference ONLY: reconcile its [analyst] claims against the review session and keep continuity.',
      'NEVER copy its text as source material — the review transcript below is the primary source.',
      String(firstReportBlock).trim());
  }
  // No match data attached (no Match ID / Run Process) → run from the transcript alone. Suppress the
  // filler the data-grounded schema comments otherwise pull ("no individual curve discussed" ×5) and
  // make commsGrade name its evidence basis, so the empty-data run degrades honestly instead of guessing.
  if (!digests.length) {
    lines.push('',
      '=== NO MATCH DATA ATTACHED ===',
      'This report has NO match-data digest. Work from the VOD review transcript alone:',
      '- Leave playerCards[].soulsCurveRead and playerCards[].laneVerdict as "" unless the review itself voiced that read — never write filler like "no individual curve discussed"; an empty field renders as "Not analyzed."',
      '- Ground commsGrade only in what the review session evidenced, and open commsGrade.overall by naming that basis, e.g. "(review-talk evidence only) ...".',
      '- Make no claim that cross-references match data (souls curves, item timings, objective damage, net-worth swings) — none is available this run.');
  }
  if (String(coachNotesBlock).trim()) {
    lines.push('', 'Coach\'s tagged in-game notes (chess.com-style classifications):', String(coachNotesBlock).trim());
  }
  if (priorActionItems.length) {
    lines.push('');
    lines.push('Prior action items from earlier scrims — judge each resolved / persisting / unclear from this review and fill "followUps":');
    lines.push(JSON.stringify(priorActionItems.map((p) => ({ id: p.id, text: p.text })), null, 0));
  }
  if (String(notesBlock).trim()) {
    lines.push('');
    lines.push('Player-written notes (supplementary source for sections; the transcript wins on conflict):');
    lines.push(String(notesBlock).trim());
  }
  lines.push('');
  lines.push('VOD Review transcript:');
  lines.push(transcriptBlock || '(empty transcript)');
  return lines.join('\n');
}

// Coerce arbitrary parsed JSON into the report shape: guarantee arrays exist, stamp a stable id on
// any action item missing one (falls back to slugId(text)), and force status to a known value.
export function coerceReport(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => String(v ?? '');
  const prose = (v) => collapseStampRuns(str(v)); // M15: fold [m:ss] runs to ranges in free-text fields
  return {
    // absent (v1 sidecars) → 1; fresh model output says 2. The view branches on this.
    schemaVersion: Number(o.schemaVersion) > 0 ? Math.floor(Number(o.schemaVersion)) : 1,
    tldr: typeof o.tldr === 'string' ? o.tldr : '',
    playerCards: arr(o.playerCards).map((c) => ({
      player: str(c?.player), hero: str(c?.hero), lane: str(c?.lane),
      laneVerdict: prose(c?.laneVerdict), soulsCurveRead: prose(c?.soulsCurveRead), itemCritique: prose(c?.itemCritique),
      coaching: prose(c?.coaching),
      deathAnalysis: arr(c?.deathAnalysis).map((d) => ({ t: str(d?.t), what: str(d?.what), why: str(d?.why), lesson: str(d?.lesson) })),
      drills: arr(c?.drills).map(String),
    })).filter((c) => c.player || c.hero),
    macro: {
      tempoRead: prose(o.macro?.tempoRead),
      objectiveWindows: arr(o.macro?.objectiveWindows).map((w) => ({ t: str(w?.t), event: str(w?.event), verdict: str(w?.verdict), why: prose(w?.why) })),
      laneMap: prose(o.macro?.laneMap),
      swings: arr(o.macro?.swings).map((s) => ({ t: str(s?.t), direction: str(s?.direction), cause: prose(s?.cause) })),
    },
    commsGrade: {
      overall: prose(o.commsGrade?.overall),
      callouts: arr(o.commsGrade?.callouts).map((c) => ({ t: str(c?.t), who: str(c?.who), call: prose(c?.call), verdict: prose(c?.verdict), evidence: prose(c?.evidence) })),
      missed: arr(o.commsGrade?.missed).map(prose),
    },
    meta: {
      passes: arr(o.meta?.passes).map(String),
      brainSections: arr(o.meta?.brainSections).map(String),
      warnings: arr(o.meta?.warnings).map(String),
      // M6: resolved "Speaker N" → roster name, with the evidence behind each mapping. v1/v2 sidecars
      // have none; an absent or non-object value coerces to {} so the view never branches on undefined.
      speakerMap: o.meta?.speakerMap && typeof o.meta.speakerMap === 'object' && !Array.isArray(o.meta.speakerMap)
        ? Object.fromEntries(Object.entries(o.meta.speakerMap).map(([k, v]) => [String(k), {
          name: str(v?.name), confidence: v?.confidence === 'high' ? 'high' : 'low', evidence: str(v?.evidence),
        }]))
        : {},
      // non-auto-applied Pass-2 findings the view renders as inline flags
      findings: arr(o.meta?.findings).map((f) => ({
        ref: str(f?.ref), field: str(f?.field), issue: str(f?.issue), fix: str(f?.fix),
        confidence: str(f?.confidence), evidence: str(f?.evidence),
      })),
    },
    sections: arr(o.sections).map((s) => ({
      id: String(s?.id || slugId(s?.heading)),
      heading: String(s?.heading ?? ''),
      md: prose(s?.md),
    })).filter((s) => s.heading || s.md),
    actionItems: arr(o.actionItems).map((it) => ({
      id: String(it?.id || slugId(it?.text)),
      text: String(it?.text ?? ''),
      count: Number(it?.count) > 0 ? Math.floor(Number(it.count)) : 1,
      timestamps: arr(it?.timestamps).map(String),
      player: it?.player ? String(it.player) : null,
      metric: it?.metric ? String(it.metric) : null,
      status: it?.status === 'done' ? 'done' : 'pending',
    })),
    qa: arr(o.qa).map((x) => ({ q: String(x?.q ?? ''), a: String(x?.a ?? ''), askedBy: x?.askedBy ? String(x.askedBy) : null, t: x?.t ? String(x.t) : null })),
    keepDoing: arr(o.keepDoing).map(prose),
    debates: arr(o.debates).map(prose),
    followUps: arr(o.followUps).map((f) => ({ priorItem: prose(f?.priorItem), verdict: ['resolved', 'persisting', 'unclear'].includes(f?.verdict) ? f.verdict : 'unclear', evidence: prose(f?.evidence) })),
    // M4: the final report's judgment of the first report's [analyst] claims. Old sidecars (v1/v2,
    // and every first report) default to [] and render unchanged — the banner just stays analyst-side.
    reconciliation: arr(o.reconciliation).map((x) => ({
      claim: str(x?.claim),
      verdict: x?.verdict === 'overridden' ? 'overridden' : 'confirmed',
      note: str(x?.note),
      stamp: str(x?.stamp),
    })),
    // M17: the carry-forward index — the ONLY input to the scrim's mechanical Carry-Forward export
    // (M24), never rendered in the report view. Old sidecars have none and default to []. An entry
    // whose kind the model garbled is DROPPED rather than mis-bucketed: the point itself still lives
    // in the report body, so the index losing a pointer costs a line in the export, not content.
    carry: arr(o.carry).map((c) => ({
      kind: String(c?.kind ?? '').toLowerCase(),
      text: str(c?.text),
      player: c?.player ? String(c.player) : null,
      stamp: str(c?.stamp),
    })).filter((c) => c.text && ['habit', 'plan', 'debate'].includes(c.kind)),
    generated: str(o.generated), // set by the caller at save time; the banner dates "Coach-reviewed" from it
  };
}

// Tolerant parse of Claude's text: strip a ```lang … ``` fence, slice the outermost {…}, JSON.parse,
// coerce. Mirrors autoClassify.parseClassifications but for one object, not an array.
export function parseReport(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) throw new Error('no JSON object in model output');
  return coerceReport(JSON.parse(t.slice(a, b + 1)));
}

// Carry the app-owned checkbox state (status: done/pending) from a prior report onto a fresh one,
// matched by stable action-item id (mirror autoClassify.reconcile). Fresh AI content wins for
// everything else; the human's done/pending toggles survive a regenerate.
export function reconcileReport(fresh, prior) {
  const priorById = new Map((prior?.actionItems || []).map((it) => [it.id, it]));
  return {
    ...fresh,
    actionItems: (fresh.actionItems || []).map((it) => {
      const p = priorById.get(it.id);
      return { ...it, status: p && p.status === 'done' ? 'done' : (it.status || 'pending') };
    }),
  };
}

// Compile a subset of the report into a single GFM markdown string for the "Export
// to .md" action on the VOD Review popup. `selected` is a Set of section ids:
// 'report' | 'actions' | 'qa' | 'keep' | 'debates' | 'followups' | 'segments'.
// `name` is the scrim title for the H1 (the caller derives it from the scrim
// mdPath basename). `segments` (the parsed .vodcomms segment list) is read only
// when 'segments' is selected. section.md bodies are emitted RAW — their [m:ss]
// tokens are plain text in the file (the in-app linkTimeTokens/TimeChip transform
// is render-only and must NOT run on export). Empty selection → ''.
// Sections offered by the Export popover, in emit order (matches the ORDER list below).
export const EXPORT_SECTIONS = [
  { id: 'report', label: 'Report' },
  { id: 'players', label: 'Player Cards' },
  { id: 'macro', label: 'Macro' },
  { id: 'comms', label: 'Comms Grade' },
  { id: 'actions', label: 'Action Items' },
  { id: 'qa', label: 'Q&A' },
  { id: 'keep', label: 'Keep Doing' },
  { id: 'debates', label: 'Debates' },
  { id: 'followups', label: 'Follow-ups' },
  { id: 'segments', label: 'Segments (transcript)' },
];

export function serializeReportMarkdown(report, selected, name, segments = []) {
  const r = report || {};
  const sel = (id) => !!selected?.has(id);
  const ORDER = ['report', 'players', 'macro', 'comms', 'actions', 'qa', 'keep', 'debates', 'followups', 'segments'];
  if (!ORDER.some(sel)) return '';
  const blocks = [];
  blocks.push(`# ${String(name ?? '').trim() || 'VOD Review'}`);

  if (sel('report')) {
    for (const sec of (Array.isArray(r.sections) ? r.sections : [])) {
      const h = String(sec?.heading ?? '').trim();
      const md = String(sec?.md ?? '').trim();
      if (!h && !md) continue;
      blocks.push(`## ${h || 'Section'}\n\n${md}`);
    }
  }
  if (sel('players')) {
    const cards = Array.isArray(r.playerCards) ? r.playerCards : [];
    blocks.push('## Player Cards\n\n' + (cards.length
      ? cards.map((c) => {
          const name = `${String(c?.hero || c?.player || '').trim()}${c?.player && c.player !== c.hero ? ` (${c.player})` : ''}`;
          const L = [`### ${name || 'Player'}${c?.lane ? ` — ${c.lane}` : ''}`];
          if (String(c?.laneVerdict ?? '').trim()) L.push(`- **Lane verdict:** ${c.laneVerdict.trim()}`);
          if (String(c?.soulsCurveRead ?? '').trim()) L.push(`- **Souls curve:** ${c.soulsCurveRead.trim()}`);
          if (String(c?.itemCritique ?? '').trim()) L.push(`- **Items:** ${c.itemCritique.trim()}`);
          if (String(c?.coaching ?? '').trim()) L.push(`- **Coaching:** ${c.coaching.trim()}`);
          for (const d of (Array.isArray(c?.deathAnalysis) ? c.deathAnalysis : [])) {
            const parts = [d?.what, d?.why, d?.lesson ? `Lesson: ${d.lesson}` : ''].map((x) => String(x ?? '').trim()).filter(Boolean);
            if (parts.length) L.push(`- **Death${d?.t ? ` [${d.t}]` : ''}:** ${parts.join(' — ')}`);
          }
          const drills = (Array.isArray(c?.drills) ? c.drills : []).map(String).filter(Boolean);
          if (drills.length) L.push(`- **Drills:** ${drills.join('; ')}`);
          return L.join('\n');
        }).join('\n\n')
      : '_(none)_'));
  }
  if (sel('macro')) {
    const m = r.macro || {};
    const L = ['## Macro'];
    if (String(m.tempoRead ?? '').trim()) L.push(`**Tempo:** ${m.tempoRead.trim()}`);
    if (String(m.laneMap ?? '').trim()) L.push(`**Lane map:** ${m.laneMap.trim()}`);
    const ows = Array.isArray(m.objectiveWindows) ? m.objectiveWindows : [];
    if (ows.length) {
      L.push('**Objective windows:**');
      for (const w of ows) L.push(`- ${w?.t ? `[${w.t}] ` : ''}${String(w?.event ?? '').trim()}${w?.verdict ? ` — ${w.verdict}` : ''}${String(w?.why ?? '').trim() ? ` (${w.why.trim()})` : ''}`);
    }
    const sws = Array.isArray(m.swings) ? m.swings : [];
    if (sws.length) {
      L.push('**Tempo swings:**');
      for (const s of sws) L.push(`- ${s?.t ? `[${s.t}] ` : ''}${String(s?.direction ?? '').trim()}${String(s?.cause ?? '').trim() ? ` — ${s.cause.trim()}` : ''}`);
    }
    blocks.push(L.length > 1 ? L.join('\n\n') : '## Macro\n\n_(none)_');
  }
  if (sel('comms')) {
    const cg = r.commsGrade || {};
    const L = ['## Comms Grade'];
    if (String(cg.overall ?? '').trim()) L.push(`**Overall:** ${cg.overall.trim()}`);
    const cos = Array.isArray(cg.callouts) ? cg.callouts : [];
    if (cos.length) {
      L.push('**Callouts:**');
      for (const c of cos) L.push(`- ${c?.t ? `[${c.t}] ` : ''}**${String(c?.who ?? '').trim()}:** ${String(c?.call ?? '').trim()}${String(c?.verdict ?? '').trim() ? ` — ${c.verdict.trim()}` : ''}${String(c?.evidence ?? '').trim() ? ` (${c.evidence.trim()})` : ''}`);
    }
    const missed = (Array.isArray(cg.missed) ? cg.missed : []).map(String).filter(Boolean);
    if (missed.length) { L.push('**Missed calls:**'); for (const mm of missed) L.push(`- ${mm}`); }
    blocks.push(L.length > 1 ? L.join('\n\n') : '## Comms Grade\n\n_(none)_');
  }
  if (sel('actions')) {
    const items = Array.isArray(r.actionItems) ? r.actionItems : [];
    blocks.push('## Action Items\n\n' + (items.length
      ? items.map((it) => {
          const box = it?.status === 'done' ? '- [x]' : '- [ ]';
          let line = `${box} ${String(it?.text ?? '').trim()}`;
          if (Number(it?.count) > 1) line += ` ×${it.count}`;
          if (it?.player) line += ` @${it.player}`;
          const ts = (Array.isArray(it?.timestamps) ? it.timestamps : []).map(String).filter(Boolean);
          if (ts.length) line += ` ${ts.map((t) => `[${t}]`).join(' ')}`;
          return line;
        }).join('\n')
      : '_(none)_'));
  }
  if (sel('qa')) {
    const qa = Array.isArray(r.qa) ? r.qa : [];
    blocks.push('## Q&A\n\n' + (qa.length
      ? qa.map((x) => {
          const stamp = x?.t ? `[${x.t}] ` : '';
          const who = String(x?.askedBy || 'Q').trim();
          const q = String(x?.q ?? '').trim();
          const a = String(x?.a ?? '').trim() || '_(no answer)_';
          return `**${stamp}${who}:** ${q}\n\n> ${a.replace(/\n/g, '\n> ')}`;
        }).join('\n\n')
      : '_(none)_'));
  }
  if (sel('keep')) {
    const kd = (Array.isArray(r.keepDoing) ? r.keepDoing : []).map(String);
    blocks.push('## Keep Doing\n\n' + (kd.length ? kd.map((x) => `- ${x}`).join('\n') : '_(none)_'));
  }
  if (sel('debates')) {
    const db = (Array.isArray(r.debates) ? r.debates : []).map(String);
    blocks.push('## Debates\n\n' + (db.length ? db.map((x) => `- ${x}`).join('\n') : '_(none)_'));
  }
  if (sel('followups')) {
    const fu = Array.isArray(r.followUps) ? r.followUps : [];
    blocks.push('## Follow-ups\n\n' + (fu.length
      ? fu.map((f) => {
          const v = String(f?.verdict ?? 'unclear');
          const p = String(f?.priorItem ?? '').trim() || '_(item)_';
          const ev = String(f?.evidence ?? '').trim();
          let line = `- **${v}** — ${p}`;
          if (ev) line += `\n  ${ev}`;
          return line;
        }).join('\n')
      : '_(none)_'));
  }
  if (sel('segments')) {
    const segs = Array.isArray(segments) ? segments : [];
    blocks.push('## Segments (transcript)\n\n' + (segs.length
      ? segs.map((s) => {
          const t = mmss((Number(s?.t0Ms) || 0) / 1000);
          const sp = String(s?.speaker || '—');
          const tx = String(s?.text || '').trim() || '·';
          return `${t} ${sp} ${tx}`;
        }).join('\n')
      : '_(unavailable)_'));
  }
  return blocks.join('\n\n') + '\n';
}

// ── Pass 0: transcript name-normalization (Analyst pipeline, Move 9) ─────────
// One-shot lexicon-grounded proper-noun correction of the diarized transcript before the report
// draft reads it. An ENHANCER, never a blocker: any contract slip (parse failure after one
// reprompt, runaway correction count, mass from-mismatch) discards the pass for this run and the
// pipeline proceeds un-normalized with a warning for the report meta.

export const NORMALIZE_SYSTEM_PROMPT = [
  'You correct Deadlock STT transcripts. Given the canonical lexicon (with known mishears) and a',
  'numbered transcript, output ONLY a JSON array of corrections:',
  '  [{"i": number, "from": string, "to": string}]',
  'where "i" is the segment number and "from" is an EXACT substring of that segment.',
  'Correct ONLY proper nouns — hero, item, and ability names and map terms — to their canonical',
  'lexicon spelling. Never rewrite meaning, grammar, or anything that is not a proper noun.',
  'No corrections needed → output [].',
].join('\n');

// Numbered by ORIGINAL index (blank segments skipped in the listing, never renumbered) so a
// correction's `i` always addresses the caller's array.
export function buildNormalizePrompt(segments, lexicon) {
  const lines = ['Canonical lexicon:', String(lexicon ?? '').trim() || '(empty)', '', 'Transcript segments:'];
  (Array.isArray(segments) ? segments : []).forEach((s, i) => {
    const text = String(s?.text ?? '').trim();
    if (text) lines.push(`${i}\t${text}`);
  });
  return lines.join('\n');
}

// Strict parse: strip a fence, slice the outermost […], keep only well-formed entries.
export function parseCorrections(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('[');
  const b = t.lastIndexOf(']');
  if (a === -1 || b === -1 || b <= a) throw new Error('no JSON array in model output');
  const arr = JSON.parse(t.slice(a, b + 1));
  if (!Array.isArray(arr)) throw new Error('corrections not an array');
  return arr
    .filter((c) => c && Number.isInteger(c.i) && typeof c.from === 'string' && c.from && typeof c.to === 'string' && c.to && c.from !== c.to)
    .map((c) => ({ i: c.i, from: c.from, to: c.to }));
}

// Exact-substring replace within segment i (all occurrences in that segment). A miss — bad index
// or from-string not present — is skipped and collected, never guessed at.
export function applyCorrections(segments, corrections) {
  const out = (Array.isArray(segments) ? segments : []).map((s) => ({ ...s }));
  const skipped = [];
  for (const c of (Array.isArray(corrections) ? corrections : [])) {
    const s = out[c.i];
    if (!s || typeof s.text !== 'string' || !s.text.includes(c.from)) { skipped.push(c); continue; }
    s.text = s.text.split(c.from).join(c.to);
  }
  return { segments: out, skipped };
}

// FNV-1a over segment texts — the cache key for the .vodnorm sidecar (regenerates skip the pass
// when the transcript hasn't changed).
export function transcriptHash(segments) {
  let h = 0x811c9dc5;
  for (const s of (Array.isArray(segments) ? segments : [])) {
    const t = `${String(s?.text ?? '')}\n`;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16);
}

// The pass. Returns { segments, corrections, skipped, discarded, warning } — on any discard the
// input segments come back untouched. `cached` (a prior { corrections } for this hash) short-circuits
// the model call entirely.
export async function normalizeTranscript(invoke, segments, lexicon, agents = {}, { cached = null } = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  const keep = (warning) => ({ segments: segs, corrections: [], skipped: [], discarded: true, warning });
  if (!segs.length) return { segments: segs, corrections: [], skipped: [], discarded: false, warning: null };

  let corrections;
  if (cached && Array.isArray(cached.corrections)) {
    corrections = cached.corrections;
  } else {
    const base = {
      systemPrompt: NORMALIZE_SYSTEM_PROMPT,
      backend: agents.authBackend || 'api-key',
      model: agents.model || 'opus',
      cliPath: agents.claudeCliPath || '',
    };
    const user = buildNormalizePrompt(segs, lexicon);
    const call = (userPrompt) => invoke('coaching_classify_match', { ...base, userPrompt });
    try {
      corrections = await parseOrRetry(call, user, parseCorrections, 'Respond with ONLY the JSON array, nothing else.');
    } catch (err) {
      // parse-failed-twice OR a transport failure (timeout/auth/upstream) — either way this pass
      // is an enhancer, so ship the transcript un-normalized rather than block the report.
      return keep(`Pass 0 discarded: ${err.message}`);
    }
  }

  // contract-drift guards: a rewrite-everything output or mass from-mismatch = discard.
  // Floor of 10 so a tiny transcript with a handful of legit fixes never self-discards.
  if (corrections.length > Math.max(10, 0.3 * segs.length)) return keep(`Pass 0 discarded: ${corrections.length} corrections for ${segs.length} segments (rewrite drift)`);
  const { segments: fixed, skipped } = applyCorrections(segs, corrections);
  if (corrections.length && skipped.length > 0.2 * corrections.length) return keep(`Pass 0 discarded: ${skipped.length}/${corrections.length} corrections failed exact-substring match (drift)`);
  return { segments: fixed, corrections, skipped, discarded: false, warning: null };
}

// ── Pass 2: tool-using fact-check (Analyst pipeline, Move 11) ─────────────────
// The draft report goes to a read-only, tool-armed CLI run (coaching_agent_run: cwd = the
// GameWiki Deadlock/ folder, Read/Grep/Glob) that checks proper nouns, stat claims, and
// timestamps against Fact/ pages, the match digest, and the transcript. Findings with
// confidence "exact" (spelling-level name fixes) auto-apply; everything else lands in
// meta.findings + meta.warnings for the view to flag. Degrades like Pass 0: a failed or
// unparseable verify run warns and ships the draft — it never fakes a verification.

export const VERIFY_SYSTEM_PROMPT = [
  'You are verifying a Deadlock match report. For every proper noun (hero/item/ability names),',
  'stat claim, and timestamp in the draft: check it against the Fact/ pages in your working',
  'directory (use Read/Grep/Glob), the attached match digest, and the transcript excerpts.',
  'Output ONLY a JSON object:',
  '  {"findings": [{"ref": string, "field": string, "issue": string, "fix": string,',
  '                 "confidence": "exact"|"likely"|"unsure", "evidence": string}]}',
  'where "issue" is the EXACT wrong text as it appears in the draft, "fix" is the correction,',
  '"ref" locates it (e.g. "playerCards[2].itemCritique"), and "evidence" cites the source that',
  'proves it (a Fact/ page path, a digest line, or a transcript timestamp).',
  'Use "exact" ONLY for unambiguous canonical-name spelling fixes. Flag, never rewrite,',
  'anything judgemental. No problems found → {"findings": []}.',
  'Timestamp corrections: when the wrong value IS a [m:ss] / [h:mm:ss] stamp, set "field" to exactly',
  '"timestamp", "issue" to the wrong stamp as written in the draft, and "fix" to the right one. That',
  'exact field value is what lets a verified stamp correction be APPLIED instead of only flagged — any',
  'other field name ships the known-wrong stamp in the report body.',
].join('\n');

export function buildVerifyPrompt({ report, matchDigests = [], lexicon = '' }) {
  const lines = ['Draft report JSON:', JSON.stringify(report)];
  if (String(lexicon).trim()) lines.push('', 'Canonical lexicon:', String(lexicon).trim());
  for (const dg of (Array.isArray(matchDigests) ? matchDigests : [])) {
    if (String(dg ?? '').trim()) lines.push('', '=== MATCH DATA DIGEST ===', String(dg).trim());
  }
  return lines.join('\n');
}

// Strict parse mirroring parseCorrections: fence-strip → outermost {} → findings array.
export function parseFindings(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) throw new Error('no JSON object in verify output');
  const v = JSON.parse(t.slice(a, b + 1));
  return (Array.isArray(v?.findings) ? v.findings : [])
    .filter((f) => f && typeof f.issue === 'string' && f.issue)
    .map((f) => ({
      ref: String(f.ref ?? ''), field: String(f.field ?? ''), issue: String(f.issue),
      fix: String(f.fix ?? ''), confidence: String(f.confidence ?? 'unsure'), evidence: String(f.evidence ?? ''),
    }));
}

// Recursive string replace across the report, skipping `id` fields (stable ids feed
// reconcileReport — a name fix must never re-key an action item).
function mapStrings(v, f, key = '') {
  if (typeof v === 'string') return key === 'id' ? v : f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f, key));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = mapStrings(x, f, k);
    return out;
  }
  return v;
}

// Auto-apply "exact" name fixes (global substring replace); everything else → meta.findings
// + a meta.warnings line. Returns a new report; the input is untouched.
export function applyFindings(report, findings, segments = []) {
  let out = mapStrings(report, (s) => s);
  const flagged = [];
  // Timestamp findings (M4): a verified [m:ss]→[m:ss] correction whose FIXED stamp lands in a real
  // segment and whose WRONG stamp appears exactly once auto-applies like an "exact" fix — otherwise the
  // known-wrong stamp ships in the section body with its correction buried in the warnings bar. Guarded
  // by the segment list (no segments → never auto-applies, stays flag-only).
  const segs = (Array.isArray(segments) ? segments : []).filter((s) => s && Number.isFinite(Number(s.t0Ms)));
  const spanEnd = segs.length ? Math.max(...segs.map((s) => Number(s.t1Ms) || 0)) : 0;
  const TOL = 5000;
  const stampRe = /\b(?:\d{1,2}:)?\d{1,2}:[0-5]\d\b/;
  const stampSec = (str) => { const m = String(str).match(/\b(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)\b/); return m ? (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null; };
  const inSeg = (sec) => { if (sec == null || !segs.length) return false; const ms = sec * 1000; if (ms < 0 || ms > spanEnd + TOL) return false; return segs.some((s) => ms >= Number(s.t0Ms) - TOL && ms <= Number(s.t1Ms) + TOL); };
  const isTimestampFix = (f) => f.field === 'timestamp' && f.fix && f.issue !== f.fix
    && stampRe.test(f.issue) && stampRe.test(f.fix) && inSeg(stampSec(f.fix))
    && JSON.stringify(out).split(f.issue).length === 2; // wrong stamp is unique → safe global replace
  for (const f of (Array.isArray(findings) ? findings : [])) {
    if ((f.confidence === 'exact' && f.fix && f.issue !== f.fix) || isTimestampFix(f)) {
      out = mapStrings(out, (s) => s.split(f.issue).join(f.fix));
    } else {
      flagged.push(f);
    }
  }
  out.meta = out.meta || { passes: [], brainSections: [], warnings: [], findings: [] };
  out.meta.findings = [...(out.meta.findings || []), ...flagged];
  out.meta.warnings = [
    ...(out.meta.warnings || []),
    ...flagged.map((f) => `verify: ${f.field || f.ref || 'claim'} — ${f.issue}${f.fix ? ` → ${f.fix}` : ''}`),
  ];
  return out;
}

// The pass: coaching_agent_run (tool-armed CLI) → parse → apply. Reprompt-once, then degrade
// with a warning — the draft ships un-verified rather than not at all.
export async function verifyReport(invoke, { report, matchDigests = [], lexicon = '', segments = [] }, agents = {}) {
  const user = buildVerifyPrompt({ report, matchDigests, lexicon });
  const call = (userPrompt) => invoke('coaching_agent_run', {
    systemPrompt: VERIFY_SYSTEM_PROMPT,
    userPrompt,
    model: agents.model || 'opus',
    cliPath: agents.claudeCliPath || '',
  });
  let findings;
  try {
    findings = await parseOrRetry(call, user, parseFindings, 'Respond with ONLY the JSON object, nothing else.');
  } catch (err2) {
    const out = mapStrings(report, (s) => s);
    out.meta = out.meta || { passes: [], brainSections: [], warnings: [], findings: [] };
    out.meta.warnings = [...(out.meta.warnings || []), `Pass 2 skipped: ${err2.message}`];
    return { report: out, findings: [], ran: false };
  }
  return { report: applyFindings(report, findings, segments), findings, ran: true };
}

// DI'd invoke (like autoClassify.classifyMoments) → generate + parse + reconcile. Reprompt-once on a
// parse failure, then let a second failure throw. Opus via the alias the Rust side maps to claude-opus-4-8.
// M4: this is also Process 2's entry — called per match with the review transcriptBlock, one-element
// matchDigests, and firstReportBlock (reconciliation reference); saved as .matchfinal by the caller.
export async function generateReport(invoke, { transcriptBlock, teams, coachedTeam, priorActionItems = [], notesBlock = '', brainContext = '', matchDigests = [], coachNotesBlock = '', tfCommsBlocks = [], firstReportBlock = '', prior = null, onRaw = null }, agents = {}) {
  const user = buildReportPrompt({ transcriptBlock, teams, coachedTeam, priorActionItems, notesBlock, brainContext, matchDigests, coachNotesBlock, tfCommsBlocks, firstReportBlock });
  const base = {
    systemPrompt: VOD_REPORT_SYSTEM_PROMPT,
    backend: agents.authBackend || 'api-key',
    model: agents.model || 'opus',
    cliPath: agents.claudeCliPath || '',
  };
  const call = (userPrompt) => invoke('coaching_classify_match', { ...base, userPrompt });
  // The one pass that must not degrade — a failed draft is a failed report, so this throws.
  // onRaw persists each raw emission first: the draft is the single most expensive call in the
  // pipeline and a double parse failure used to discard it entirely.
  const report = await parseOrRetry(call, user, parseReport, 'Respond with ONLY the JSON object, nothing else.', onRaw);
  report.schemaVersion = REPORT_SCHEMA_VERSION; // stamp regardless of what the model echoed
  return prior ? reconcileReport(report, prior) : report;
}

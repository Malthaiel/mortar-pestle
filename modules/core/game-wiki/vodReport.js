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
  return s.replace(/\[\d+:\d{2}(?::\d{2})?\](?:\s+\[\d+:\d{2}(?::\d{2})?\])+/g, (run) => {
    const stamps = run.match(/\[\d+:\d{2}(?::\d{2})?\]/g).map((b) => b.slice(1, -1));
    const groups = [[stamps[0]]];
    for (let i = 1; i < stamps.length; i++) {
      const gap = toSec(stamps[i]) - toSec(stamps[i - 1]);
      if (gap >= 0 && gap <= 45) groups[groups.length - 1].push(stamps[i]);
      else groups.push([stamps[i]]);
    }
    return groups.map((g) => (g.length >= 3 ? `[${g[0]}–${g[g.length - 1]}]` : g.map((t) => `[${t}]`).join(' '))).join(' ');
  });
}

// Deterministic stamp validation (ported from vodReportGate.mjs so it runs in-pipeline, not just in
// the standalone gate): every m:ss / h:mm:ss token anywhere in the report must land inside a real
// vodcomms segment (±5s). Returns the offending stamps as mmss text, deduped ([] when clean or when
// no segments are supplied). `matchSummaries` is excluded — its game-clock times aren't VOD stamps
// (owned by the deterministic match digest; added with M24), so validating them here is a false positive.
export function validateStamps(report, segments = []) {
  const segs = (Array.isArray(segments) ? segments : []).filter((s) => s && Number.isFinite(Number(s.t0Ms)));
  if (!segs.length) return [];
  const { matchSummaries, ...rest } = report || {};
  void matchSummaries;
  const text = JSON.stringify(rest);
  const stamps = [...text.matchAll(/\b(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)\b/g)]
    .map((m) => (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  const spanEnd = Math.max(...segs.map((s) => Number(s.t1Ms) || 0));
  const TOL = 5000; // segments are ~2.5s apart; ±5s covers rounding
  const inSeg = (sec) => {
    const ms = sec * 1000;
    if (ms < 0 || ms > spanEnd + TOL) return false;
    return segs.some((s) => ms >= Number(s.t0Ms) - TOL && ms <= Number(s.t1Ms) + TOL);
  };
  return [...new Set(stamps)].filter((s) => !inSeg(s)).map(mmss);
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
  '  "meta": { "warnings": [string] }   // anything you could not verify or had to assume',
  '}',
  '',
  'Rules: every timestamp is a time string copied VERBATIM from the transcript, hour part included past',
  '1:00:00 (m:ss under the hour, h:mm:ss over it) — never reformat or recompute one. Never invent content not',
  'in the transcript or notes. Merge duplicate action items and bump their count instead of repeating. If a',
  'section has nothing, use an empty array. Keep it tight — this is a coach\'s cheat sheet, not a summary essay.',
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
  'Section rules:',
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
].join('\n');

// Build the user prompt: transcript + team context + any prior action items to follow up on.
// priorActionItems is [] until sub-plan 12 (Team Progress) feeds it — the follow-up block is
// simply omitted when empty (empty-tolerant), so nothing to rework when D lands.
export function buildReportPrompt({ transcriptBlock, teams = {}, coachedTeam = '', priorActionItems = [], notesBlock = '', brainContext = '', matchDigests = [], coachNotesBlock = '' }) {
  const lines = [];
  lines.push(`Coached team: ${coachedTeam || '(unnamed)'}${teams.opponent ? ` vs ${teams.opponent}` : ''}.`);
  if (String(brainContext).trim()) {
    lines.push('', '=== ANALYST BRAIN ===', String(brainContext).trim());
  }
  const digests = (Array.isArray(matchDigests) ? matchDigests : []).filter((dg) => String(dg ?? '').trim());
  for (const dg of digests) lines.push('', '=== MATCH DATA DIGEST ===', String(dg).trim());
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
export async function generateReport(invoke, { transcriptBlock, teams, coachedTeam, priorActionItems = [], notesBlock = '', brainContext = '', matchDigests = [], coachNotesBlock = '', prior = null, onRaw = null }, agents = {}) {
  const user = buildReportPrompt({ transcriptBlock, teams, coachedTeam, priorActionItems, notesBlock, brainContext, matchDigests, coachNotesBlock });
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

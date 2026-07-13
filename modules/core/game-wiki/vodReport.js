// vodReport.js — VOD Review Report (Deadlock Scrim Coaching, sub-plan 11). Pure ESM (no React,
// no @host) so the prompt/parse/reconcile logic round-trips through a Node harness like
// autoClassify.js / deathAudit.js. Turns a diarized VOD-review transcript (the post-match session
// where the coach + players talk through the game) into an actionable coaching report via Claude,
// reusing the generic coaching_classify_match(systemPrompt, userPrompt, backend, model, cliPath)
// bridge (no new Rust). Opus by default — a condensed report is ~2-4k tokens, well under 16k out.
//
// Report JSON shape (what Claude returns, what VodReportView renders, what the .vodreport sidecar
// stores):
//   { tldr, sections:[{id, heading, md}],
//     actionItems:[{id, text, count, timestamps[], player?, metric?, status}],
//     qa:[{q, a, askedBy, t}], keepDoing[], debates[], followUps:[{priorItem, verdict, evidence}] }
//   status ∈ 'pending' | 'done' — the checkbox state, reconciled across regenerates by stable id.
//   sections = dynamic per-scrim topic pages (taught lessons/frameworks) in GFM markdown; time
//   references inside md are literal [m:ss] tokens the view swaps for jump chips.

// Whole-second time → m:ss (standalone so the Node harness needs no matchData import).
export function mmss(s) {
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0) return '0:00';
  const w = Math.floor(v);
  return `${Math.floor(w / 60)}:${String(w % 60).padStart(2, '0')}`;
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

export const VOD_REPORT_SYSTEM_PROMPT = [
  'You are a Deadlock scrim coach organizing a post-match VOD-review discussion into a concise,',
  'actionable report. The transcript is speaker-labeled and timestamped [m:ss]. The coach is the',
  'person whose lines answer questions and direct the review; the others are the coached team\'s players.',
  '',
  'Return ONLY a single JSON object (no markdown, no code fences, no commentary) with EXACTLY these keys:',
  '{',
  '  "tldr": string,                    // 1-3 sentence digest of the whole review',
  '  "sections": [                      // one entry per substantial topic taught or discussed at length',
  '    { "id": string,                  // short stable kebab-case slug of the heading',
  '      "heading": string,             // name the section after the topic itself ("Tempo", "Gaining a Lead", ...)',
  '      "md": string }                 // full GFM markdown body: bullets, numbered steps, tables all allowed;',
  '                                     // cite moments as literal [m:ss] tokens copied from the transcript',
  '  ],',
  '  "actionItems": [                   // concrete things to change; DEDUPE near-identical asks',
  '    { "id": string,                  // short stable kebab-case slug of the item; REUSE a prior id if given one',
  '      "text": string,                // the action, imperative ("rotate mid after first tower")',
  '      "count": number,               // how many distinct moments raised it (>=1)',
  '      "timestamps": [string],        // every m:ss where it came up',
  '      "player": string|null,         // the player it targets, or null if team-wide',
  '      "metric": string|null,         // leave null (measurable-goal mapping is a later phase)',
  '      "status": "pending" }          // always "pending" — the app owns done/pending',
  '  ],',
  '  "qa": [ { "q": string, "a": string, "askedBy": string, "t": string } ],  // player question -> coach answer, t = m:ss',
  '  "keepDoing": [string],             // things praised / working well',
  '  "debates": [string],               // points raised but left unresolved',
  '  "followUps": [ { "priorItem": string, "verdict": "resolved"|"persisting"|"unclear", "evidence": string } ]',
  '}',
  '',
  'Rules: every timestamp is an m:ss string copied from the transcript. Never invent content not in the',
  'transcript or notes. Merge duplicate action items and bump their count instead of repeating. If a section has',
  'nothing, use an empty array (or "" for tldr). Keep it tight — this is a coach\'s cheat sheet, not a summary essay.',
  '',
  'Section rules:',
  '- NEVER compress a taught framework. When the coach lays out steps, a sequence, or a plan, reproduce',
  '  EVERY step, in order, faithful to the coach\'s wording, inside that topic\'s section. Summarizing a',
  '  taught sequence is a failure.',
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
export function buildReportPrompt({ transcriptBlock, teams = {}, coachedTeam = '', priorActionItems = [], notesBlock = '' }) {
  const lines = [];
  lines.push(`Coached team: ${coachedTeam || '(unnamed)'}${teams.opponent ? ` vs ${teams.opponent}` : ''}.`);
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
  return {
    tldr: typeof o.tldr === 'string' ? o.tldr : '',
    sections: arr(o.sections).map((s) => ({
      id: String(s?.id || slugId(s?.heading)),
      heading: String(s?.heading ?? ''),
      md: String(s?.md ?? ''),
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
    keepDoing: arr(o.keepDoing).map(String),
    debates: arr(o.debates).map(String),
    followUps: arr(o.followUps).map((f) => ({ priorItem: String(f?.priorItem ?? ''), verdict: ['resolved', 'persisting', 'unclear'].includes(f?.verdict) ? f.verdict : 'unclear', evidence: String(f?.evidence ?? '') })),
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

// DI'd invoke (like autoClassify.classifyMoments) → generate + parse + reconcile. Reprompt-once on a
// parse failure, then let a second failure throw. Opus via the alias the Rust side maps to claude-opus-4-8.
export async function generateReport(invoke, { transcriptBlock, teams, coachedTeam, priorActionItems = [], notesBlock = '', prior = null }, agents = {}) {
  const user = buildReportPrompt({ transcriptBlock, teams, coachedTeam, priorActionItems, notesBlock });
  const base = {
    systemPrompt: VOD_REPORT_SYSTEM_PROMPT,
    backend: agents.authBackend || 'api-key',
    model: agents.model || 'opus',
    cliPath: agents.claudeCliPath || '',
  };
  const call = (userPrompt) => invoke('coaching_classify_match', { ...base, userPrompt });
  let report;
  try {
    report = parseReport(await call(user));
  } catch (err) {
    const retry = `${user}\n\nYour previous response failed to parse (${err.message}). Respond with ONLY the JSON object, nothing else.`;
    report = parseReport(await call(retry));
  }
  return prior ? reconcileReport(report, prior) : report;
}

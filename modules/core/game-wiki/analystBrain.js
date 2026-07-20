// analystBrain.js — Deadlock Analyst brain (Coaching/Analyst/ in the GameWiki vault). Pure ESM
// (no React, no @host) like teamProgress.js: the caller passes the host `api` (getVaultFolder /
// getRawFileMeta; writes go through api.savePage), so the logic round-trips through a Node
// harness against the live vault (analystBrain.selftest.mjs).
//
// The Lexicon is the Analyst's canonical-vocabulary page, auto-derived from the Fact/ layer:
// page basenames = canonical names. Regeneration re-derives every Fact-sourced section but
// CARRIES FORWARD the learned `## Mishears` rows (the Learn loop grows them; losing them on a
// refresh would silently un-teach the Analyst — never lose information).

export const ANALYST_DIR = 'Deadlock/Coaching/Analyst';
export const LEXICON_PATH = `${ANALYST_DIR}/Lexicon.md`;

// Fact/ subfolders that feed the lexicon: [section heading, vault-relative folder].
export const LEXICON_SOURCES = [
  ['Heroes', 'Fact/Heroes'],
  ['Weapon Items', 'Fact/Weapon Items'],
  ['Spirit Items', 'Fact/Spirit Items'],
  ['Vitality Items', 'Fact/Vitality Items'],
  ['Abilities', 'Fact/Abilities'],
  ['Structures', 'Fact/Structures'],
  ['Mechanics', 'Fact/Mechanics'],
];

// Historical renames (mirrors Deadlock Domain Rules § Historical Name Aliases): old → current.
export const NAME_ALIASES = [
  ['Doorman', 'The Doorman'],
  ['Debuff Remover', 'Dispel Magic'],
  ['Curse', 'Cursed Relic'],
  ['Backstabber', 'Stalker'],
];

// Canonical page basenames from a vault_get_folder result: .md pages only, no dot-prefixed
// sidecars, no Index, sorted for a stable render.
export function pageNames(res) {
  return (((res && res.pages) || [])
    .map((p) => String(p.path || '').replace(/^\/+/, '').split('/').pop())
    .filter((n) => n.endsWith('.md') && !n.startsWith('.'))
    .map((n) => n.slice(0, -3))
    .filter((n) => n && n !== 'Index'))
    .sort((a, b) => a.localeCompare(b));
}

// Learned mishear rows out of an existing Lexicon.md: the `## Mishears` table's body rows as
// [heard, canonical] pairs. Tolerates a missing section/table (fresh scaffold) → [].
export function parseMishears(md) {
  // Line-anchored heading lookup (a prose mention of the heading in backticks must not match).
  const s = '\n' + String(md || '');
  const i = s.indexOf('\n## Mishears');
  if (i === -1) return [];
  let body = s.slice(i + '\n## Mishears'.length);
  const j = body.indexOf('\n## ');
  if (j !== -1) body = body.slice(0, j);
  return body.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !/^\|[\s:|-]+\|$/.test(l) && !/^\|\s*Heard\s*\|/i.test(l))
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((c) => c.length >= 2 && c[0] && c[1])
    .map((c) => [c[0], c[1]]);
}

// Render the full Lexicon.md. `stamp` (YYYY-MM-DD) injected so the function stays deterministic.
export function renderLexicon(sections, mishears = [], stamp = '') {
  const L = [];
  L.push('---');
  L.push('Type: Deadlock-Analyst');
  L.push('Status: active');
  L.push('Owner: agent-regenerated');
  if (stamp) L.push(`Updated: ${stamp}`);
  L.push('---');
  L.push('Canonical Deadlock vocabulary, auto-derived from the `Fact/` layer (page basenames = canonical names). Regenerated on demand — do not hand-edit generated sections. `## Mishears` rows are learned by the Learn loop and survive regeneration.');
  for (const [heading, names] of sections) {
    L.push('');
    L.push(`## ${heading}`);
    L.push('');
    if (names.length) for (const n of names) L.push(`- ${n}`);
    else L.push('_(no pages found in this Fact/ folder)_');
  }
  L.push('');
  L.push('## Aliases');
  L.push('');
  L.push('Historical renames — old name maps forward to current canonical name.');
  L.push('');
  L.push('| Old Name | Current Name |');
  L.push('|---|---|');
  for (const [oldName, cur] of NAME_ALIASES) L.push(`| ${oldName} | ${cur} |`);
  L.push('');
  L.push('## Mishears');
  L.push('');
  L.push('Learned STT mishear map — phonetic transcript errors mapped to canonical names. Grown by the Learn loop.');
  L.push('');
  L.push('| Heard | Canonical |');
  L.push('|---|---|');
  for (const [heard, canonical] of mishears) L.push(`| ${heard} | ${canonical} |`);
  L.push('');
  return L.join('\n');
}

// `Updated:` stamp missing or older than `days` = stale → report-time auto-refresh (Move 4).
export function lexiconStale(md, now = new Date(), days = 7) {
  const m = String(md || '').match(/^Updated:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
  if (!m) return true;
  return now - new Date(m[1]) > days * 86400e3;
}

export const ANALYST_PAGE_PATH = `${ANALYST_DIR}/Analyst.md`;
export const CONCEPTS_PATH = `${ANALYST_DIR}/Concepts.md`;
export const CORRECTIONS_PATH = `${ANALYST_DIR}/Corrections.md`;
export const PATCH_DIGEST_PATH = `${ANALYST_DIR}/Patch Digest.md`;
export const PATCH_INGESTED_DIR = 'Patch Notes Pipeline/Ingested';

export const PATCH_DIGEST_SYSTEM_PROMPT = [
  'You are a Deadlock analyst summarizing official patch notes for a coach. Given dated patch notes,',
  'produce a balance digest in GFM markdown: hero buffs/nerfs, item buffs/nerfs, and meta implications',
  'a coach should factor into scrim analysis. Use canonical hero/item names exactly as written in the',
  'patches. Cite the patch date next to every change ("(2026-04-30)"). Most recent patches first.',
  'Lead with a short "Current meta pressure" paragraph, then "## Heroes" and "## Items" sections of',
  'dated bullets. Only include balance-relevant changes — skip bug fixes, cosmetics, and UI notes.',
  'Omit anything about Legendary items, Street Brawl, or Enhanced items entirely — never mention',
  'these categories. Output ONLY the markdown body, no preamble, no code fences.',
].join('\n');

// `Digested:` frontmatter list out of an existing Patch Digest.md → array of date strings.
export function parseDigested(md) {
  const m = String(md || '').match(/^Digested:\s*\[(.*?)\]\s*$/m);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export function renderPatchDigest(body, dates = [], stamp = '') {
  const L = [];
  L.push('---');
  L.push('Type: Deadlock-Analyst');
  L.push('Status: active');
  L.push('Owner: agent-regenerated');
  L.push(`Digested: [${dates.join(', ')}]`);
  if (stamp) L.push(`Updated: ${stamp}`);
  L.push('---');
  L.push('Dated summary of balance-relevant changes, distilled from `Patch Notes Pipeline/Ingested/`. Regenerated when new patches land — the `Digested` frontmatter lists which ingested patches this digest covers.');
  L.push('');
  L.push('## Digest');
  L.push('');
  L.push(String(body || '').trim() || '_(no patches ingested yet)_');
  L.push('');
  return L.join('\n');
}

// True when the Ingested/ folder holds patches the current digest hasn't covered (report-time
// auto-refresh trigger).
export function patchDigestStale(digestMd, ingestedDates = []) {
  const have = new Set(parseDigested(digestMd));
  return ingestedDates.some((d) => !have.has(d));
}

// Enumerate Ingested/, read the `count` most recent patches, one-shot summarize via the generic
// coaching_classify_match bridge (DI'd invoke, mirror generateReport) → full Patch Digest.md
// markdown. No ingested patches → a valid "none yet" digest, never a throw (non-blocking).
export async function buildPatchDigest(api, invoke, agents = {}, { count = 13, stamp = '' } = {}) {
  const res = await api.getVaultFolder('Deadlock', PATCH_INGESTED_DIR, 'gamewiki').catch(() => null);
  const dates = pageNames(res).sort((a, b) => b.localeCompare(a)).slice(0, count); // newest first
  if (!dates.length) return renderPatchDigest('', [], stamp);
  const parts = [];
  for (const d of dates) {
    try {
      const { content } = await api.getRawFileMeta(`Deadlock/${PATCH_INGESTED_DIR}/${d}.md`, 'gamewiki');
      parts.push(`=== PATCH ${d} ===\n${String(content).slice(0, 80000)}`);
    } catch { /* unreadable patch page — skip */ }
  }
  const body = await invoke('coaching_classify_match', {
    systemPrompt: PATCH_DIGEST_SYSTEM_PROMPT,
    userPrompt: parts.join('\n\n'),
    backend: agents.authBackend || 'api-key',
    model: agents.model || 'opus',
    cliPath: agents.claudeCliPath || '',
  });
  return renderPatchDigest(String(body || '').trim(), dates.slice().sort(), stamp);
}

// Enumerate Fact/ + carry existing mishears → the full Lexicon.md markdown. Caller saves it:
// api.savePage(LEXICON_PATH, md, null, 'gamewiki'). A missing Fact/ subfolder degrades to an
// empty section (lexicon completeness is iterative, never blocking).
export async function buildLexicon(api, stamp = '') {
  const sections = [];
  for (const [heading, rel] of LEXICON_SOURCES) {
    const res = await api.getVaultFolder('Deadlock', rel, 'gamewiki').catch(() => null);
    sections.push([heading, pageNames(res)]);
  }
  let mishears = [];
  try { mishears = parseMishears((await api.getRawFileMeta(LEXICON_PATH, 'gamewiki')).content); } catch { /* fresh vault */ }
  return renderLexicon(sections, mishears, stamp);
}

// ---- Brain context (the block every Analyst call reads: report passes + the chat system prompt) ----

// Frontmatter off, CRLF normalized — brain pages are hand-editable, so tolerate both EOL styles.
export function stripFrontmatter(md) {
  return String(md || '').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
}

// Body of a `## <heading>` section, line-anchored (a backticked prose mention must not match),
// up to the next `## ` heading. '' when absent.
export function sectionOf(md, heading) {
  const s = '\n' + String(md || '').replace(/\r\n/g, '\n') + '\n';
  const i = s.indexOf(`\n## ${heading}\n`);
  if (i === -1) return '';
  const body = s.slice(i + heading.length + 5);
  const j = body.indexOf('\n## ');
  return (j === -1 ? body : body.slice(0, j)).trim();
}

// Prior report takeaways for a coached team: walk Coaching/Scrim FOLDERS (schema v2 —
// a scrim is a folder holding Overview.md + .vodreport.json), keep the ones whose
// Overview frontmatter names this team. Newest last. Reads the "VOD Takeaways" section
// (mandatory since 2026-07-19); pre-takeaways reports fall back to their tldr field.
// ponytail: folder-name order ≈ chronology (names carry a date suffix); a real date sort can
// come with a real need.
export async function collectPriorTldrs(api, coachedTeam, max = 3) {
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!norm(coachedTeam)) return [];
  const res = await api.getVaultFolder('Deadlock', 'Coaching/Scrim', 'gamewiki').catch(() => null);
  const folders = ((res && res.subfolders) || []).map((sf) => String(sf.name || '')).filter(Boolean).sort();
  const out = [];
  for (const base of folders) {
    const dir = `Deadlock/Coaching/Scrim/${base}`;
    let content;
    try { content = String((await api.getRawFileMeta(`${dir}/Overview.md`, 'gamewiki')).content); } catch { continue; }
    const m = content.match(/^Coached Team:\s*(.+)$/m) || content.match(/^Team 1:\s*(.+)$/m);
    if (!m || norm(m[1]) !== norm(coachedTeam)) continue;
    try {
      const rep = JSON.parse((await api.getRawFileMeta(`${dir}/.vodreport.json`, 'gamewiki')).content);
      const take = (Array.isArray(rep?.sections) ? rep.sections : [])
        .find((s) => s?.id === 'vod-takeaways' || /^vod takeaways$/i.test(String(s?.heading || '').trim()));
      const text = String(take?.md || rep?.tldr || '').trim();
      if (text) out.push({ scrim: base, tldr: text });
    } catch { /* no report for this scrim */ }
  }
  return out.slice(-Math.max(0, max));
}

// Assemble the labeled brain-context string. Deterministic section order; per-section char
// ceilings (lexicon rides full — canonical names ARE the point); every section
// optional-with-loud-placeholder so a missing brain file surfaces in the text AND in `warnings`
// (Move 10 persists the section list in report meta) — the report never silently degrades.
export async function buildBrainContext(api, { coachedTeam = '', priorTldrMax = 3 } = {}) {
  const read = async (p) => { try { return String((await api.getRawFileMeta(p, 'gamewiki')).content); } catch { return null; } };
  const cap = (s, n = 20000) => (String(s).length > n ? `${String(s).slice(0, n)}\n[truncated at ${n} chars]` : String(s));
  const parts = [];
  const sections = [];
  const warnings = [];
  const push = (label, text, missingName) => {
    const ok = text != null && String(text).trim();
    sections.push({ label, present: !!ok });
    if (!ok) warnings.push(`[MISSING: ${missingName}]`);
    parts.push(`=== ${label} ===\n${ok ? String(text).trim() : `[MISSING: ${missingName}]`}`);
  };

  const charter = await read(ANALYST_PAGE_PATH);
  push('ANALYST CHARTER', charter && cap(stripFrontmatter(charter)), 'Analyst.md');
  const lex = await read(LEXICON_PATH);
  push('LEXICON', lex && stripFrontmatter(lex), 'Lexicon.md');
  const dig = await read(PATCH_DIGEST_PATH);
  push('PATCH DIGEST', dig && cap(stripFrontmatter(dig)), 'Patch Digest.md');
  const con = await read(CONCEPTS_PATH);
  push('TAUGHT CONCEPTS', con && cap(sectionOf(con, 'Distilled')), 'Concepts.md ## Distilled');
  const cor = await read(CORRECTIONS_PATH);
  push('CORRECTION LESSONS', cor && cap(sectionOf(cor, 'Distilled')), 'Corrections.md ## Distilled');

  const team = String(coachedTeam || '').trim();
  if (team) {
    const teamPage = await read(`Deadlock/Coaching/Teams/${team}.md`);
    push('TEAM PAGE', teamPage && cap(teamPage), `Teams/${team}.md`);
    let progress = null;
    try {
      const agg = JSON.parse(await read(`Deadlock/Coaching/Teams/.teamprogress.${team}.json`));
      progress = JSON.stringify({
        scrimCount: agg.scrimCount, record: agg.record, recurring: agg.recurring,
        openHomework: (agg.homework || []).filter((h) => !h.done).map((h) => h.text),
        recurringLessons: agg.recurringLessons,
      });
    } catch { /* no progress sidecar yet */ }
    push('TEAM PROGRESS', progress && cap(progress), `.teamprogress.${team}.json`);
    const tldrs = await collectPriorTldrs(api, team, priorTldrMax);
    push('PRIOR REPORT TAKEAWAYS', tldrs.length ? cap(tldrs.map((t) => `${t.scrim}:\n${t.tldr}`).join('\n\n')) : null, 'prior reports');
  }

  return { text: parts.join('\n\n'), sections, warnings };
}

// ---- Teach/Learn distiller (shared: the analyst-teach recipe now, correct-report/learn in Phase B) ----

// The distiller user-turn prompt: current Distilled bodies + new material → full replacement
// bodies. The never-lose-information contract lives IN the prompt and is re-enforced by
// distilledShrunk() before any write.
export function buildDistillerPrompt({ taught = '', feedback = [], concepts = '', corrections = '', mishears = [] } = {}) {
  const L = [
    'You are distilling durable coaching knowledge into the Deadlock Analyst brain.',
    'Merge the NEW MATERIAL below into the CURRENT sections. Rules:',
    '- NEVER drop a prior fact. If new material contradicts an old fact, keep the old one on its own',
    '  line marked "SUPERSEDED: <old> → <new>".',
    '- Misheard/misspelled names mapped to canonical names go to "mishears" (new pairs only).',
    '- Team facts, strategy frameworks, and taught concepts go to "concepts".',
    '- Lessons about report mistakes (what the Analyst got wrong and the rule preventing a repeat) go to "corrections".',
    '- Keep entries terse, factual, reusable — one bullet per fact.',
    '- Output ONLY a JSON object, no fences, no commentary:',
    '  {"concepts": string, "corrections": string, "mishears": [["heard","Canonical"], ...]}',
    '  concepts/corrections are the FULL replacement markdown bodies for each Distilled section.',
    '',
    '=== CURRENT Concepts Distilled ===',
    String(concepts).trim() || '(empty)',
    '',
    '=== CURRENT Corrections Distilled ===',
    String(corrections).trim() || '(empty)',
    '',
    '=== CURRENT Mishears ===',
    (mishears || []).map(([h, c]) => `${h} → ${c}`).join('\n') || '(empty)',
  ];
  if (String(taught).trim()) L.push('', '=== NEW MATERIAL: TAUGHT BY THE COACH ===', String(taught).trim());
  if (feedback && feedback.length) L.push('', '=== NEW MATERIAL: REPORT-CORRECTION FEEDBACK ===', JSON.stringify(feedback));
  return L.join('\n');
}

// Fence-strip → outermost {} slice → JSON.parse → coerce (same technique as vodReport.parseReport).
export function parseDistillerOutput(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/^```[a-z]*\s*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) throw new Error('no JSON object in distiller output');
  const o = JSON.parse(t.slice(a, b + 1));
  return {
    concepts: typeof o.concepts === 'string' ? o.concepts : '',
    corrections: typeof o.corrections === 'string' ? o.corrections : '',
    mishears: (Array.isArray(o.mishears) ? o.mishears : [])
      .map((p) => (Array.isArray(p) ? [String(p[0] ?? '').trim(), String(p[1] ?? '').trim()] : null))
      .filter((p) => p && p[0] && p[1]),
  };
}

// The >20%-shrinkage guard: a replacement Distilled body that shrinks past `ratio` without a
// SUPERSEDED marker means the model dropped facts — refuse the write, surface for manual review.
export function distilledShrunk(before, after, ratio = 0.2) {
  const b = String(before ?? '').trim();
  const a = String(after ?? '').trim();
  if (!b || b.startsWith('_(')) return false; // empty/placeholder before — any content is growth
  if (a.length >= b.length * (1 - ratio)) return false;
  return !a.includes('SUPERSEDED:');
}

// Swap a page's `## Distilled` body for `newBody` and append a dated line to `## Log`.
// ponytail: the log append targets end-of-file — the scaffold keeps ## Log as the final section.
export function replaceDistilled(pageMd, newBody, logLine = '') {
  let s = String(pageMd || '').replace(/\r\n/g, '\n');
  const marker = '\n## Distilled\n';
  const i = s.indexOf(marker);
  if (i === -1) throw new Error('page has no ## Distilled section');
  const start = i + marker.length;
  const j = s.indexOf('\n## ', start);
  const tail = j === -1 ? '\n' : s.slice(j);
  s = `${s.slice(0, start)}\n${String(newBody).trim()}\n${tail}`;
  if (String(logLine).trim()) s = `${s.trimEnd()}\n- ${String(logLine).trim()}\n`;
  return s;
}

// Append new mishear pairs to the Lexicon's ## Mishears table (case-insensitive dedupe on the
// heard form). ponytail: appends at end-of-file — renderLexicon keeps the table last.
export function addMishears(lexiconMd, pairs = []) {
  const seen = new Set(parseMishears(lexiconMd).map(([h]) => h.toLowerCase()));
  const add = (pairs || []).filter(([h, c]) => h && c && !seen.has(String(h).toLowerCase()));
  if (!add.length) return String(lexiconMd || '');
  return `${String(lexiconMd).replace(/\r\n/g, '\n').trimEnd()}\n${add.map(([h, c]) => `| ${h} | ${c} |`).join('\n')}\n`;
}

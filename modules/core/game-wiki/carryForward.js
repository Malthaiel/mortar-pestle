// M24 — the scrim's carry-forward sheet. Pure, mechanical, and deliberately AI-free: everything here
// was already written and judged by a Process 2 final report, so re-asking a model to summarize it
// would only introduce drift into text the coach already approved. This module copies, groups and
// tags. It never rewrites a word.
//
// Input mirrors aggregateTeam's `matchReports` shape — [{ n, report }] read by the caller — so the
// whole compiler is testable with fabricated reports and no file system.
//
// One-way street (locked decision 8): the app WRITES Carry-Forward.md and never reads it back. Grep
// for CARRY_FORWARD_FILE and you will find writers only; if a reader ever appears, that is the bug.
import { normIssue } from './teamProgress.js';
import { sidecarPath } from './matchData.js';

export const CARRY_FORWARD_FILE = 'Carry-Forward.md';

// The three carry kinds, in the order they appear in the sheet, with the heading each one owns.
const CARRY_SECTIONS = [
  ['habit', 'Season-Long Habits'],
  ['debate', 'Open Debates'],
  ['plan', 'Next-Scrim Plans'],
];

const str = (v) => String(v ?? '').trim();

// "[27:49] M2", or bare "M2" when the entry carries no stamp. The stamp is emitted as PLAIN TEXT,
// never a TimeChip token: this file is read outside the report view, where a chip means nothing.
function tag(stamp, n) {
  const s = str(stamp);
  return s ? `${s} M${n}` : `M${n}`;
}

// Fold entries that say the same thing, conservatively: normIssue is an exact match after casing and
// trailing-punctuation normalization, so different wording keeps BOTH rows (the plan's rule — unsure
// never merges). The first spelling wins as the display text, and every source match is listed, so a
// wrong fold stays visible and traceable instead of quietly eating a row.
function fold(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = normIssue(row.text);
    if (!key) continue;
    const hit = byKey.get(key);
    if (hit) {
      for (const t of row.tags) if (!hit.tags.includes(t)) hit.tags.push(t);
      if (!hit.player && row.player) hit.player = row.player;
    } else {
      byKey.set(key, { text: row.text, player: row.player, tags: [...row.tags] });
    }
  }
  return [...byKey.values()];
}

// [{ n, report }] -> the full markdown sheet, or '' when nothing carries forward. Returning '' rather
// than an empty file is deliberate: the context-menu item is disabled with a tooltip in that case
// (M2), so an empty sheet should never reach disk.
export function buildCarryForward(matchReports = [], { scrim = '', date = '' } = {}) {
  const reports = (Array.isArray(matchReports) ? matchReports : [])
    .filter((m) => m && m.report && typeof m.report === 'object')
    .sort((a, b) => (Number(a.n) || 0) - (Number(b.n) || 0));

  const actions = fold(reports.flatMap(({ n, report }) => (report.actionItems || [])
    .map((it) => ({ text: str(it?.text), player: str(it?.player), tags: [`M${n}`] }))
    .filter((r) => r.text)));

  const carriedByKind = new Map(CARRY_SECTIONS.map(([kind]) => [kind, []]));
  for (const { n, report } of reports) {
    for (const c of report.carry || []) {
      const bucket = carriedByKind.get(str(c?.kind));
      if (!bucket || !str(c?.text)) continue;
      bucket.push({ text: str(c.text), player: str(c.player), tags: [tag(c?.stamp, n)] });
    }
  }

  const blocks = [];
  if (actions.length) {
    blocks.push(['## Action Items', '', ...actions.map((a) => {
      const who = a.player ? ` — ${a.player}` : '';
      return `- [ ] ${a.text}${who} (${a.tags.join(', ')})`;
    })].join('\n'));
  }
  for (const [kind, heading] of CARRY_SECTIONS) {
    const rows = fold(carriedByKind.get(kind));
    if (!rows.length) continue;
    blocks.push([`## ${heading}`, '', ...rows.map((r) => {
      const who = r.player ? ` — ${r.player}` : '';
      return `- ${r.text}${who} ${r.tags.join(', ')}`;
    })].join('\n'));
  }
  if (!blocks.length) return '';

  const sources = reports.map(({ n }) => `Match ${n}`).join(', ');
  const header = [
    `Carry-forward${scrim ? ` for ${scrim}` : ''}${date ? `, built ${date}` : ''}.`,
    '',
    `Compiled from the final reports of: ${sources || '(none)'}. Nothing here was rewritten — every`,
    'line is copied from the report that raised it, tagged with the match it came from.',
  ].join('\n');

  return `${header}\n\n${blocks.join('\n\n')}\n`;
}

// Which matches of a scrim have a FINAL report, straight off a listFolderRaw file list. Pulled out
// so both callers and the selftest agree on the one filename pattern.
export function finalMatchNumbers(files = []) {
  return [...new Set((Array.isArray(files) ? files : [])
    .map((f) => Number((String(f).match(/^\.matchfinal\.Match (\d+)\.json$/) || [])[1]))
    .filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
}

// Read every final report in a scrim, compile, write. `onlyIfExists` is the auto-refresh mode used
// after a Process 2 run: the sheet is a thing the coach ASKED for once, so it stays refreshed but is
// never conjured behind their back. Returns the written path, or null when nothing was written.
export async function exportCarryForward(api, folder, { scrim = '', date = '', onlyIfExists = false } = {}) {
  const target = `${folder}/${CARRY_FORWARD_FILE}`;
  if (onlyIfExists) {
    try { await api.getRawFileMeta(target, 'gamewiki'); } catch { return null; }
  }
  const list = await api.listFolderRaw(`${folder}/Matches`, 'gamewiki').catch(() => null);
  const matchReports = [];
  for (const n of finalMatchNumbers(list?.files)) {
    try {
      matchReports.push({ n, report: JSON.parse((await api.getRawFileMeta(sidecarPath(folder, n, 'matchfinal'), 'gamewiki')).content) });
    } catch { /* unreadable sidecar — the other matches still carry forward */ }
  }
  const md = buildCarryForward(matchReports, { scrim, date });
  if (!md) return null;
  await api.savePage(target, md, null, 'gamewiki');
  return target;
}

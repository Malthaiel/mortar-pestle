// Parse / serialize a Deadlock coaching-scrim markdown file into a structured
// object and back, losslessly. The ScrimViewer renders the structured object as
// fill-in boxes; every save round-trips read -> parse -> merge -> serialize -> write.
//
// Contract (see Knowledge/Mortar & Pestle/Plans/Deadlock Scrim Coaching/Scrim Surface & Viewer.md):
//   frontmatter (ordered Key: value)
//   ## Scrim          (- Key: value bullets — Score, VOD Review)
//   ## Match N        { - Key: value bullets (Match ID, Time, Scrim Recording, Scoreboard),
//                       ### Notes (<team>) bullets,
//                       opaque ### Match Data / ### Coaching Summary / ### Comms Transcript }
//
// Opaque subsection bodies are Run-Process-owned (sibling sub-plans 2/3/4) and are
// round-tripped verbatim. The serializer's canonical spacing IS the normal form:
// incidental whitespace normalizes, but content (notes, opaque regions, unknown
// keys/sections) is never lost. `serializeScrim(parseScrim(x)) === x` for any file
// already in canonical form.

export const SCRIM_TYPE = 'Deadlock-Coaching-Scrim';

// A match subsection is a structural boundary ONLY for these known headings; any
// other ### is body content of the current section, so an opaque Match Data blob
// may itself contain ### without being split.
const KNOWN_SUBSECTION_RE = /^###\s+(Notes\s*\(.*\)|Match Data|Coaching Summary|Comms Transcript|Auto Classification\s*\(.*\))\s*$/;
const NOTES_HEADING_RE = /^###\s+Notes\s*\(([^)]*)\)\s*$/;
const H2_RE = /^##\s+.*\S\s*$/;
const MATCH_H2_RE = /^##\s+Match\s+(\d+)\s*$/;
const BULLET_KV_RE = /^-\s+([^:]+):\s?(.*)$/;
const BULLET_RE = /^-\s+(.*)$/;

function splitFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return { fmLines: [], bodyLines: lines };
  let close = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i] === '---') { close = i; break; } }
  if (close === -1) return { fmLines: [], bodyLines: lines };
  return { fmLines: lines.slice(1, close), bodyLines: lines.slice(close + 1) };
}

function parseFrontmatter(fmLines) {
  const fm = {};
  for (const line of fmLines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fm[key] = value;
  }
  return fm;
}

// Join lines into a body string, trimming leading + trailing blank lines only.
function bodyString(lines) {
  let s = 0, e = lines.length;
  while (s < e && lines[s].trim() === '') s++;
  while (e > s && lines[e - 1].trim() === '') e--;
  return lines.slice(s, e).join('\n');
}

// Ordered Key->value object from `- Key: value` lines (blanks/non-kv skipped).
function parseKvBullets(lines) {
  const obj = {};
  for (const line of lines) {
    const m = BULLET_KV_RE.exec(line.trim());
    if (m) obj[m[1].trim()] = m[2].trim();
  }
  return obj;
}

function parseMatchBlock(n, lines) {
  const markers = [];
  for (let i = 0; i < lines.length; i++) if (KNOWN_SUBSECTION_RE.test(lines[i])) markers.push(i);
  const firstMarker = markers.length ? markers[0] : lines.length;
  const fields = parseKvBullets(lines.slice(0, firstMarker));
  const subsections = [];
  for (let k = 0; k < markers.length; k++) {
    const start = markers[k];
    const end = k + 1 < markers.length ? markers[k + 1] : lines.length;
    const headerLine = lines[start];
    const inner = lines.slice(start + 1, end);
    const notesM = NOTES_HEADING_RE.exec(headerLine);
    if (notesM) {
      const bullets = [];
      for (const line of inner) {
        const bm = BULLET_RE.exec(line.trim());
        if (bm) bullets.push(bm[1].trim());
      }
      subsections.push({ kind: 'notes', team: notesM[1].trim(), bullets });
    } else {
      subsections.push({ kind: 'opaque', heading: headerLine.replace(/^###\s+/, '').trim(), body: bodyString(inner) });
    }
  }
  return { n, fields, subsections };
}

export function parseScrim(content) {
  const { fmLines, bodyLines } = splitFrontmatter(content || '');
  const frontmatter = parseFrontmatter(fmLines);

  const blocks = [];
  let cur = null;
  for (const line of bodyLines) {
    if (H2_RE.test(line)) { cur = { header: line, lines: [] }; blocks.push(cur); }
    else if (cur) cur.lines.push(line);
    // pre-first-H2 lines (the blank after frontmatter) are dropped — the
    // serializer re-emits canonical spacing.
  }

  let scrim = {};
  const matches = [];
  const extraBlocks = [];
  for (const b of blocks) {
    const matchM = MATCH_H2_RE.exec(b.header);
    if (b.header.trim() === '## Scrim') scrim = parseKvBullets(b.lines);
    else if (matchM) matches.push(parseMatchBlock(parseInt(matchM[1], 10), b.lines));
    else extraBlocks.push({ header: b.header, body: bodyString(b.lines) });
  }
  return { frontmatter, scrim, matches, extraBlocks };
}

// Emit `- Key: value`, or `- Key:` when value is empty (no trailing whitespace).
function kvLine(prefix, k, v) {
  return v === '' || v == null ? `${prefix}${k}:` : `${prefix}${k}: ${v}`;
}

export function serializeScrim(s) {
  const out = ['---'];
  for (const [k, v] of Object.entries(s.frontmatter || {})) out.push(kvLine('', k, v));
  out.push('---', '');
  out.push('## Scrim');
  for (const [k, v] of Object.entries(s.scrim || {})) out.push(kvLine('- ', k, v));
  for (const m of s.matches || []) {
    out.push('', `## Match ${m.n}`);
    for (const [k, v] of Object.entries(m.fields || {})) out.push(kvLine('- ', k, v));
    for (const sub of m.subsections || []) {
      out.push('');
      if (sub.kind === 'notes') {
        out.push(`### Notes (${sub.team})`);
        for (const b of sub.bullets || []) out.push(`- ${b}`);
      } else {
        out.push(`### ${sub.heading}`);
        if (sub.body) out.push(sub.body);
      }
    }
  }
  for (const b of s.extraBlocks || []) {
    out.push('', b.header);
    if (b.body) out.push(b.body);
  }
  return out.join('\n') + '\n';
}

// ── Skeletons for "+ New Scrim" (SF6) and "+ New Match" (SF7) ───────────────

export function emptyMatch(n, coachedTeam, enemyTeam) {
  const notes = [{ kind: 'notes', team: coachedTeam || '', bullets: [] }];
  if (enemyTeam && enemyTeam !== coachedTeam) notes.push({ kind: 'notes', team: enemyTeam, bullets: [] });
  return {
    n,
    fields: { 'Match ID': '', 'Time': '', 'Amber': '', 'Sapphire': '', 'Scrim Recording': '', 'Scoreboard': '' },
    subsections: [
      ...notes,
      { kind: 'opaque', heading: 'Match Data', body: '_(populated on Run Process)_' },
    ],
  };
}

export function emptyScrim({ team1 = '', team2 = '', coachedTeam = '', date = '' }) {
  const coached = coachedTeam || team1;
  const enemy = (team1 === coached ? team2 : team1) || '';
  return {
    frontmatter: {
      'Type': SCRIM_TYPE,
      'Team 1': team1,
      'Team 2': team2,
      'Coached Team': coached,
      'Date': date,
      'Status': 'draft',
    },
    scrim: { 'Score': '', 'VOD Review': '' },
    matches: [emptyMatch(1, coached, enemy)],
    extraBlocks: [],
  };
}

export function appendMatch(scrim) {
  const n = (scrim.matches?.length || 0) + 1;
  const fm = scrim.frontmatter || {};
  const coached = fm['Coached Team'] || fm['Team 1'] || '';
  const enemy = (fm['Team 1'] === coached ? fm['Team 2'] : fm['Team 1']) || '';
  return { ...scrim, matches: [...(scrim.matches || []), emptyMatch(n, coached, enemy)] };
}

// Merge user-edited regions (frontmatter, scrim bullets, match fields, notes) from
// `local` with Run-Process-owned opaque subsections (Match Data, Coaching Summary,
// unknown ###) re-read fresh from disk — so a concurrent Run Process write is never
// clobbered by a box edit. Matches align by their number `n`; a local-only match
// (just added, not yet on disk) keeps its local subsections.
export function mergeScrim(local, fresh) {
  const freshByN = new Map((fresh.matches || []).map((m) => [m.n, m]));
  const matches = (local.matches || []).map((lm) => {
    const fm = freshByN.get(lm.n);
    if (!fm) return lm;
    const nonOpaque = (lm.subsections || []).filter((s) => s.kind !== 'opaque');
    const opaque = (fm.subsections || []).filter((s) => s.kind === 'opaque');
    return { ...lm, subsections: [...nonOpaque, ...opaque] };
  });
  return {
    frontmatter: local.frontmatter,
    scrim: local.scrim,
    matches,
    extraBlocks: (fresh.extraBlocks && fresh.extraBlocks.length) ? fresh.extraBlocks : (local.extraBlocks || []),
  };
}

// Convenience accessors for the viewer (immutable setters return a new object).
export function getNotes(match, team) {
  const notes = (match?.subsections || []).filter((s) => s.kind === 'notes');
  if (team == null) return notes[0] || null;
  return notes.find((s) => s.team === team) || null;
}

// Return a copy of `match` guaranteed to have a notes subsection for `team` (added
// empty, before the first opaque section, if absent). Used to lazily create the
// enemy notes block on its first accepted classification.
export function ensureNotes(match, team) {
  if ((match.subsections || []).some((s) => s.kind === 'notes' && s.team === team)) return match;
  const subs = [...(match.subsections || [])];
  const firstOpaque = subs.findIndex((s) => s.kind === 'opaque');
  const note = { kind: 'notes', team: team || '', bullets: [] };
  if (firstOpaque === -1) subs.push(note); else subs.splice(firstOpaque, 0, note);
  return { ...match, subsections: subs };
}

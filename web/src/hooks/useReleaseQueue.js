import { useEffect, useState } from 'react';
import { api } from '../api.js';

const QUEUE_PATH = 'Iskariel/Release Queue.md';

// Canonical Releases.md section order (mirrors useReleases.js). Drives parse + compose.
const CANONICAL_SECTIONS = ['New', 'Changed', 'Removed', 'Performance', 'Fixed', 'Migration', 'Known Issues', 'Process'];
// Allowed Surface tokens in schema order; unknown tokens sort last.
const SURFACE_ORDER = ['host', 'tauri', 'vault', 'sdk', 'web', 'infra', 'docs'];
// Suggested Area palette (Releases.md schema). Free-form names are allowed;
// they sort after the palette, alphabetically, with General always last.
export const AREA_PALETTE = ['Vault', 'Planner', 'Dock', 'Design', 'Browser', 'Music', 'Video', 'Library', 'Pomodoro', 'Shield', 'Release Pipeline', 'Settings', 'System', 'Domain Builder', 'General'];

export function orderAreaNames(names) {
  const known = AREA_PALETTE.filter(n => n !== 'General' && names.has(n));
  const unknown = [...names]
    .filter(n => n !== 'General' && !AREA_PALETTE.includes(n))
    .sort((a, b) => a.localeCompare(b));
  return names.has('General') ? [...known, ...unknown, 'General'] : [...known, ...unknown];
}

function splitFrontmatter(raw) {
  const m = (raw || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : { fm: '', body: raw || '' };
}

function fmValue(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

// Parse one entry block (text following its leading "## ").
function parseEntryBlock(chunk) {
  const lines = chunk.split('\n');
  const header = lines[0].trim();
  const hm = header.match(/^(.*?)\s*[—-]\s*queued\s+(\d{4}-\d{2}-\d{2})\s*$/i);
  const feature = (hm ? hm[1] : header).trim();
  const queuedDate = hm ? hm[2] : null;

  let surface = [];
  const plans = [];
  let area = null;
  const summaryLines = [];
  const sections = {};
  let current = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('**Surface:**')) {
      surface = t.replace('**Surface:**', '').split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }
    if (t.startsWith('**Plans:**')) {
      plans.push(t.replace('**Plans:**', '').trim());
      continue;
    }
    if (t.startsWith('**Area:**')) {
      area = t.replace('**Area:**', '').trim() || null;
      continue;
    }
    const sm = t.match(/^###\s+(.+?)\s*$/);
    if (sm) {
      current = CANONICAL_SECTIONS.includes(sm[1].trim()) ? sm[1].trim() : null;
      if (current && !sections[current]) sections[current] = [];
      continue;
    }
    if (current && (t.startsWith('- ') || t.startsWith('* '))) {
      sections[current].push(t.slice(2).trim());
    } else if (current && (line.startsWith('  ') || line.startsWith('\t'))) {
      const arr = sections[current];
      if (arr.length) arr[arr.length - 1] += ' ' + t; // wrapped continuation
    } else if (!current) {
      summaryLines.push(t);
    }
  }

  return { feature, queuedDate, surface, plans, area, summary: summaryLines.join(' ').trim(), sections };
}

// { pending, updated, entries[] }. The schema note is a `>` blockquote, so its
// `> ## ...` lines never match the `\n## ` entry split.
export function parseReleaseQueue(raw) {
  const { fm, body } = splitFrontmatter(raw);
  const chunks = body.split(/\n## /).slice(1); // [0] = preamble (note + comment)
  const entries = chunks.map(parseEntryBlock).filter(e => e.feature);
  return { pending: entries.length, updated: fmValue(fm, 'Updated'), entries };
}

// Group bullets by each entry's Area (General fallback), then by canonical
// section (exact-trimmed dedupe per area+section, first kept); union surfaces.
// Prose narrative + per-feature Plans are intentionally dropped from merged
// ships — Releases are bullets-only (see Releases.md schema) and a 40-feature
// merge has no single plan; provenance lives in Plans/ + logs. The flat
// `sections` aggregate (across areas) feeds count chips + legacy consumers.
export function mergeQueue(entries) {
  const byArea = new Map(); // name -> { sections, seen }
  const surfaceSet = new Set();

  for (const e of entries) {
    for (const s of e.surface) surfaceSet.add(s);
    const areaName = (e.area || 'General').trim() || 'General';
    if (!byArea.has(areaName)) {
      const sections = {}, seen = {};
      for (const name of CANONICAL_SECTIONS) { sections[name] = []; seen[name] = new Set(); }
      byArea.set(areaName, { sections, seen });
    }
    const bucket = byArea.get(areaName);
    for (const name of CANONICAL_SECTIONS) {
      for (const b of (e.sections[name] || [])) {
        const key = b.trim();
        if (!bucket.seen[name].has(key)) { bucket.seen[name].add(key); bucket.sections[name].push(b); }
      }
    }
  }

  const areas = orderAreaNames(new Set(byArea.keys()))
    .map(name => {
      const trimmed = {};
      for (const s of CANONICAL_SECTIONS) {
        if (byArea.get(name).sections[s].length) trimmed[s] = byArea.get(name).sections[s];
      }
      return { name, sections: trimmed };
    })
    .filter(a => Object.keys(a.sections).length);

  const sections = {};
  for (const s of CANONICAL_SECTIONS) {
    const merged = areas.flatMap(a => a.sections[s] || []);
    if (merged.length) sections[s] = merged;
  }

  const surfaces = SURFACE_ORDER.filter(s => surfaceSet.has(s))
    .concat([...surfaceSet].filter(s => !SURFACE_ORDER.includes(s)));

  return { surfaces, areas, sections };
}

// Schema-perfect release block (two-tier 0.x format: required Summary meta line,
// `### Area` → `#### Section` groups). `**Area:**` lines are queue-only metadata —
// in Releases.md areas are structural. No trailing newline (caller adds separators).
export function composeReleaseBlock({ date, version, tag = 'Early Stage', surfaces = [], plans = [], summary = '', areas = [] }) {
  const lines = [`## ${date} — v${version}`, `**Tag:** ${tag} · **Released:** ${date}`];
  if (surfaces.length) lines.push(`**Surface:** ${surfaces.join(', ')}`);
  for (const p of plans) lines.push(`**Plans:** ${p}`);
  const oneLine = summary.trim().replace(/\s*\n\s*/g, ' ');
  if (oneLine) lines.push(`**Summary:** ${oneLine}`);
  for (const area of areas) {
    const names = CANONICAL_SECTIONS.filter(n => area.sections[n]?.length);
    if (!names.length) continue;
    lines.push('', `### ${area.name}`);
    for (const name of names) {
      lines.push('', `#### ${name}`);
      for (const b of area.sections[name]) lines.push(`- ${b}`);
    }
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// Prepend `newBlock` above the newest existing release; never replaces an H2.
// Updates Version/Updated frontmatter, preserving the Schema section + all
// prior blocks. Mirrors the Close-the-Loop content-preservation rule.
export function composeFullReleases(raw, newBlock, version, date) {
  const fmMatch = (raw || '').match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  let frontmatter = '';
  let body = raw || '';
  if (fmMatch) { frontmatter = fmMatch[1]; body = fmMatch[2]; }

  frontmatter = frontmatter
    .replace(/^Version:\s*.*$/m, `Version: ${version}`)
    .replace(/^Updated:\s*.*$/m, `Updated: ${date}`);

  const m = body.match(/^## \d{4}-\d{2}-\d{2}\s*[—-]\s*v?\d/m);
  if (m == null) {
    return `${frontmatter}${body.replace(/\s+$/, '')}\n\n${newBlock}\n`;
  }
  const before = body.slice(0, m.index);
  const after = body.slice(m.index);
  return `${frontmatter}${before}${newBlock}\n\n---\n\n${after}`;
}

// Rebuild the queue keeping only the entry blocks NOT in `shippedKeys` (verbatim,
// lossless), updating Pending to the kept count + Updated to `date`, preserving the
// schema-note preamble. `shippedKeys` holds `feature::queuedDate` keys (same regex
// as parseEntryBlock). Shipping every entry clears the queue to preamble-only.
export function composeQueueRetaining(rawQueue, shippedKeys, date) {
  const { fm, body } = splitFrontmatter(rawQueue);
  const parts = body.split(/\n## /);
  const preamble = parts[0].replace(/^\s+/, '').replace(/\s+$/, '');
  const kept = parts.slice(1).filter(b => {
    const h = b.split('\n')[0].trim();
    const hm = h.match(/^(.*?)\s*[—-]\s*queued\s+(\d{4}-\d{2}-\d{2})\s*$/i);
    const feature = (hm ? hm[1] : h).trim();
    return !shippedKeys.has(`${feature}::${hm ? hm[2] : ''}`);
  });
  let newFm = (fm || `Pending: ${kept.length}\nUpdated: ${date}`)
    .replace(/^Pending:\s*.*$/m, `Pending: ${kept.length}`)
    .replace(/^Updated:\s*.*$/m, `Updated: ${date}`);
  if (!/^Pending:/m.test(newFm)) newFm = `Pending: ${kept.length}\n${newFm}`;
  if (!/^Updated:/m.test(newFm)) newFm = `${newFm}\nUpdated: ${date}`;
  if (!kept.length) return `---\n${newFm}\n---\n\n${preamble}\n`;
  const blocks = kept.map(b => `## ${b.replace(/\s+$/, '')}`).join('\n\n');
  return `---\n${newFm}\n---\n\n${preamble}\n\n${blocks}\n`;
}

export function useReleaseQueue() {
  const [data, setData] = useState({ pending: 0, entries: [], updated: null, mtime: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.releaseQueue.read()
      .then(({ content, mtime }) => {
        if (cancelled) return;
        setData({ ...parseReleaseQueue(content), mtime });
        setError(null);
      })
      .catch(err => { if (!cancelled) { console.warn('[release-queue] failed to load:', err); setError(err); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [nonce]);

  return { ...data, loading, error, reload: () => setNonce(n => n + 1) };
}

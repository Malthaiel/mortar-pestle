import { useEffect, useState } from 'react';
import { api } from '../api.js';

const RELEASES_PATH = 'Iskariel/Releases.md';

// Canonical Releases.md section order (mirrors useReleaseQueue.js). Drives parse + render.
const CANONICAL_SECTIONS = ['New', 'Changed', 'Removed', 'Performance', 'Fixed', 'Migration', 'Known Issues', 'Process'];

export function parseReleases(raw) {
  if (!raw) return [];
  // Strip YAML frontmatter
  const body = raw.replace(/^---[\s\S]*?---\n*/, '').trim();
  // Split on H2 headers (## )
  const chunks = body.split(/\n## /).filter(Boolean);
  return chunks.map(chunk => parseReleaseChunk(chunk)).filter(Boolean);
}

function parseReleaseChunk(chunk) {
  const lines = chunk.split('\n');
  if (lines.length === 0) return null;

  // Header line: "2026-06-07 — v0.7.0"
  const header = lines[0].trim().replace(/^##\s*/, '');
  const headerMatch = header.match(/^(\d{4}-\d{2}-\d{2})\s*[—-]\s*(.+)$/);
  if (!headerMatch) return null;
  let date = headerMatch[1];
  const versionLabel = headerMatch[2].trim();
  // Bare semver for comparisons (PACKAGE_VERSION match, expanded-state keys).
  const version = versionLabel.replace(/^v/i, '');

  // Meta line: "**Tag:** Early Stage · **Released:** 2026-05-21"
  let tag = 'Early Stage';
  let was = null;       // bare old version ("1.10.1") or null
  let wasLabel = null;  // raw **Was:** text ("v1.7.0 (split)") or null
  let summary = '';
  const areas = [];     // [{ name, synthetic, sections }] in file order
  let currentArea = null;
  let currentSection = null;

  const getArea = (name, synthetic = false) => {
    let area = areas.find(a => a.name === name);
    if (!area) { area = { name, synthetic, sections: {} }; areas.push(area); }
    return area;
  };
  const openSection = (area, name) => {
    if (!area.sections[name]) area.sections[name] = [];
    return name;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('**Tag:')) {
      const tagMatch = trimmed.match(/\*\*Tag:\*\*\s*([^·]+)/);
      const dateMatch = trimmed.match(/\*\*Released:\*\*\s*(\d{4}-\d{2}-\d{2})/);
      if (tagMatch) tag = tagMatch[1].trim();
      if (dateMatch) date = dateMatch[1];
      continue;
    }
    if (trimmed.startsWith('**Was:**')) {
      wasLabel = trimmed.slice(8).trim();
      was = wasLabel.match(/(\d+(?:\.\d+)+)/)?.[1] || null;
      continue;
    }
    if (trimmed.startsWith('**Summary:**')) {
      summary = trimmed.slice(12).trim();
      continue;
    }
    // Any other **Key:** line (Surface / Plans / Consolidates / future meta) is
    // metadata, never content — it must not reach the bullet-continuation rule.
    if (/^\*\*[A-Za-z][^*\n]*:\*\*/.test(trimmed)) continue;

    // #### Section inside an area (current format).
    const h4 = trimmed.match(/^####\s+(.+?)\s*$/);
    if (h4) {
      const name = h4[1].trim();
      if (CANONICAL_SECTIONS.includes(name)) {
        if (!currentArea) currentArea = getArea('General', true);
        currentSection = openSection(currentArea, name);
      } else {
        currentSection = null;
      }
      continue;
    }

    // ### Area (current format) or ### Section (legacy flat block).
    const h3 = trimmed.match(/^###(?!#)\s+(.+?)\s*$/);
    if (h3) {
      const name = h3[1].trim();
      if (CANONICAL_SECTIONS.includes(name)) {
        // Legacy flat block — synthesize a General area, header suppressed in render.
        currentArea = getArea('General', true);
        currentSection = openSection(currentArea, name);
      } else {
        currentArea = getArea(name);
        currentSection = null;
      }
      continue;
    }

    if (currentArea && currentSection && trimmed.startsWith('- ')) {
      currentArea.sections[currentSection].push(trimmed.slice(2).trim());
    } else if (currentArea && currentSection) {
      // Continuation of a bullet (indented or wrapped)
      const arr = currentArea.sections[currentSection];
      if (arr.length) arr[arr.length - 1] += ' ' + trimmed;
    }
    // Pre-section prose is intentionally dropped — summaries live in **Summary:**.
  }

  // Drop areas that collected no bullets (e.g. a stray header with nothing under it).
  const filledAreas = areas.filter(a => CANONICAL_SECTIONS.some(n => a.sections[n]?.length));

  // Aggregate canonical map across areas, in area order — keeps WhatsNewOverlay,
  // useLastSeenVersion and section-count consumers working unchanged.
  const sections = {};
  for (const name of CANONICAL_SECTIONS) {
    const merged = [];
    for (const area of filledAreas) {
      if (area.sections[name]?.length) merged.push(...area.sections[name]);
    }
    if (merged.length) sections[name] = merged;
  }

  return {
    version,                        // bare semver — matches PACKAGE_VERSION
    versionLabel,                   // display string with the v prefix
    title: versionLabel,            // legacy alias (WhatsNewOverlay headline)
    tag,
    date,
    was,
    wasLabel,
    summary,
    areas: filledAreas,             // [{ name, synthetic, sections }]
    sections,                       // aggregate { New: [...], ... } across areas
    narrative: '',                  // legacy alias; always empty
    features: sections.New || [],   // legacy aliases (WhatsNewOverlay, useLastSeenVersion)
    fixes: sections.Fixed || [],
    issues: sections['Known Issues'] || [],
  };
}

// --- Release Queue helpers (consumed by the Ship Release flow) ---

// Newest *real* shipped version from raw Releases.md, e.g. "1.35.1". Skips the
// `## YYYY-MM-DD — vX.Y.Z` schema placeholders (their literal YYYY fails \d{4}).
export function latestPublishedVersion(raw) {
  if (!raw) return null;
  const body = raw.replace(/^---[\s\S]*?---\n*/, '');
  const m = body.match(/^##\s+\d{4}-\d{2}-\d{2}\s*[—-]\s*v?(\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}

// Bump a version. Always returns 3-part semver (stacked 4-part hotfixes stay a
// manual edit). Unparseable segments fall back to 0.
export function bumpVersion(base, level) {
  const p = String(base || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  const maj = p[0] || 0, min = p[1] || 0, pat = p[2] || 0;
  if (level === 'major') return `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`; // patch
}

// Patch is the default for every ship under the two-tier 0.x scheme; minor is a
// deliberate milestone judgment made by a human in the Ship modal; major (1.0.0)
// is reserved for public readiness. Signature kept for existing call sites.
export function inferBumpLevel() {
  return 'patch';
}

export function useReleases() {
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getRawFile(RELEASES_PATH, 'app')
      .then(raw => {
        if (cancelled) return;
        setReleases(parseReleases(raw));
      })
      .catch(err => {
        if (cancelled) return;
        console.warn('[releases] failed to load:', err);
        setReleases([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [nonce]);

  return { releases, loading, reload: () => setNonce(n => n + 1) };
}

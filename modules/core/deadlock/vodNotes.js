// Personal VODs — the note file's body format. Pure ESM (no React, no @host).
//
// One match = ONE markdown file under `Coaching/Personal VODs/`, not a
// folder: these are solo games reviewed alone, so there is no transcript, no
// report and no second participant to give a folder shape to.

import { fmt } from './vodTimer.js';

export const NOTES_HEADING = '## Notes';

// Tree paths in this app are EXTENSION-LESS (useDeadlockTree's childNodes
// strips `.md`, and nav/live-target carry the stripped form), but the vault
// commands take the real filename — useVaultTree's createNote appends `.md`
// itself, Rust never does. Getting this wrong writes a file with no extension
// that Obsidian ignores and the tree never lists again. One helper so the rule
// lives in one place.
export const vodFile = (p) => (String(p || '').endsWith('.md') ? String(p) : `${p}.md`);

// Frontmatter Type keeps these out of the scrim tooling's way; Created is the
// day the match was played (the file is made at the start of it).
export function newVodScaffold(name, today = new Date()) {
  const iso = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
  return [
    '---',
    'Type: personal-vod',
    `Created: ${iso}`,
    'Status: unreviewed',
    '---',
    '',
    `Live notes taken during **${name}**. Timestamps are the match timer, synced by hand to the in-game clock at the start.`,
    '',
    NOTES_HEADING,
    '',
    '',
  ].join('\n');
}

// Append one dictated note as `- **m:ss** — text`.
//
// The heading is CREATED if a hand-edited file lost it, and the note is appended
// at the END of the file in that case. Losing a note because a markdown edit
// went sideways is the one failure this file exists to prevent — a dropped
// coaching point is a defect, not an acceptable degradation.
export function appendNote(body, stampMs, text) {
  const clean = String(text || '').trim();
  if (!clean) return body; // A wordless hold has nothing to record.
  const line = `- **${fmt(stampMs)}** — ${clean}`;
  const src = String(body || '');

  const i = src.indexOf(NOTES_HEADING);
  if (i === -1) {
    const sep = src.endsWith('\n') ? '' : '\n';
    return `${src}${sep}\n${NOTES_HEADING}\n\n${line}\n`;
  }

  // Insert at the end of the Notes section — i.e. before the next `## ` heading,
  // or at end-of-file. Trailing blank lines inside the section are dropped so
  // the bullets stay a contiguous list, but an EMPTY section keeps one blank
  // line under the heading or the first note renders glued to `## Notes`.
  const after = src.slice(i + NOTES_HEADING.length);
  const nextH = after.search(/\n## /);
  const section = nextH === -1 ? after : after.slice(0, nextH);
  const rest = nextH === -1 ? '' : after.slice(nextH);
  const trimmed = section.replace(/\s+$/, '');
  const head = trimmed === '' ? '\n' : trimmed;
  return `${src.slice(0, i)}${NOTES_HEADING}${head}\n${line}\n${rest || ''}`;
}

// Every note bullet in a body, oldest first — `[{ stamp, text }]`. The panel
// uses it for the "N notes" count; review happens in the markdown reader.
export function readNotes(body) {
  const out = [];
  const re = /^- \*\*(\d+:\d{2})\*\* — (.+)$/gm;
  let m;
  while ((m = re.exec(String(body || '')))) out.push({ stamp: m[1], text: m[2] });
  return out;
}

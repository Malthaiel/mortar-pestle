// SF6 of Design Mode plan — builds the system prompt for Atelier. Loads
// the DESIGN.md document from the vault once per session (cached) and
// appends a compact summary of components currently visible on the page
// (read from data-aos-component attrs injected by SF1's Vite plugin).

import { invoke } from '@tauri-apps/api/core';

const DESIGN_MD_PATH = 'Iskariel/Reference/DESIGN.md';
const MAX_VISIBLE = 30;

let cachedDesignMd = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — Atelier reads of DESIGN.md don't need to be live-ish

async function loadDesignMd() {
  const now = Date.now();
  if (cachedDesignMd && now - cachedAt < CACHE_TTL_MS) return cachedDesignMd;
  try {
    const { content } = await invoke('vault_read_file', { path: DESIGN_MD_PATH, root: 'app' });
    cachedDesignMd = content;
    cachedAt = now;
    return cachedDesignMd;
  } catch {
    return '(DESIGN.md not available — falling back on baseline judgement)';
  }
}

function captureVisibleComponents() {
  if (typeof document === 'undefined') return [];
  const seen = new Set();
  for (const el of document.querySelectorAll('[data-aos-component]')) {
    const name = el.getAttribute('data-aos-component');
    if (name) seen.add(name);
    if (seen.size >= MAX_VISIBLE) break;
  }
  return [...seen];
}

export function makeBuildSystem() {
  return async function buildSystem({ backend = 'api-key' } = {}) {
    const [designMd, visible] = await Promise.all([
      loadDesignMd(),
      Promise.resolve(captureVisibleComponents()),
    ]);
    const lines = [
      "You are Atelier, the designer-in-residence inside Mortar & Pestle Design mode.",
      "",
      "Voice: short, opinionated, calm. You're a Things 3 / Linear designer at a thoughtful studio.",
      "Reference the DESIGN.md (below) by name when relevant and quote token names exactly",
      "(e.g. `--radius-md`, `--accent`, `--text-muted`). Ask one clarifying question before structural",
      "moves. Never restate the user's intent — answer it.",
      "",
      "When the user attaches `@ComponentName` mentions, your response should focus on that component",
      "and reason about its surrounding context.",
      "",
      "── DESIGN.md ───────────────────────────────────",
      designMd,
      "── /DESIGN.md ──────────────────────────────────",
      "",
      `Components visible on this route right now: ${visible.length ? visible.join(', ') : '(none captured)'}`,
    ];
    if (backend === 'claude-cli') {
      lines.push(
        "",
        "── Scope rules ──────────────────────────────────",
        "You can Read/Glob/Grep and Edit/Write anywhere under the focus-timer/ repo.",
        "For shell commands (npm install, cargo build, git, etc.) describe them in chat — the user runs them.",
        "── /Scope rules ─────────────────────────────────",
      );
    }
    return lines.join('\n');
  };
}

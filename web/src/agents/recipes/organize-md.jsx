// SF6 — the `organize-md` recipe: read a vault .md, send it to the model for a
// structure pass, preview a diff, and on Apply overwrite in place after
// snapshotting the pre-edit version to the recycle bin (capture-before-destroy).
// v1 scope: vault files only (external reads are roadmap). The recipe round-trip
// runs `hidden` (tray-centric) so the whole-file prompt/response never hit chat.

import { invoke } from '@tauri-apps/api/core';
import { api } from '../../api.js';
import MarkdownDiff from '../../components/agents/MarkdownDiff.jsx';

export const organizeMd = {
  id: 'organize-md',
  label: 'Organize note',

  // ctx = { path, raw, mtime } — getRawFileMeta keeps mtime for the write guard.
  async loadContext(target) {
    if (!target) throw { code: 'NO_TARGET', message: 'No file to organize.' };
    const meta = await api.getRawFileMeta(target);
    return { path: target, raw: meta?.content || '', mtime: meta?.mtime };
  },

  // The instruction rides the (isolated) user turn — Concierge's own system
  // prompt already covers "organizing notes", so no system override is needed.
  buildPrompt(ctx) {
    return [
      'Reorganize the following Markdown note for clarity and structure.',
      'Rules:',
      '- Preserve ALL information: keep every link, tag, code block, and detail. Do not drop or invent content.',
      '- Improve heading hierarchy, grouping, and ordering; merge obvious duplicates.',
      '- Keep any YAML frontmatter (the leading --- block) intact at the very top.',
      '- Return ONLY the full reorganized Markdown — no commentary, no surrounding code fence.',
      '',
      '--- BEGIN NOTE ---',
      ctx.raw,
      '--- END NOTE ---',
    ].join('\n');
  },

  parse(text, ctx) {
    let out = (text || '').trim();
    // Strip a wrapping ```markdown … ``` fence if the model added one anyway.
    const fence = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
    if (fence) out = fence[1].trim();
    return { path: ctx.path, before: ctx.raw, after: out, mtime: ctx.mtime };
  },

  renderConfirm(proposal, { onApply, onDiscard, applying }) {
    return (
      <MarkdownDiff
        before={proposal.before}
        after={proposal.after}
        onApply={onApply}
        onDiscard={onDiscard}
        applying={applying}
      />
    );
  },

  async apply(proposal) {
    // Capture-before-destroy: snapshot the current on-disk version to the bin
    // FIRST, then overwrite. If the write fails the snapshot is harmless (the
    // file is unchanged + recoverable). Default root = content vault.
    await invoke('recycle_bin_snapshot', { path: proposal.path });
    await api.savePage(proposal.path, proposal.after, proposal.mtime);
  },
};

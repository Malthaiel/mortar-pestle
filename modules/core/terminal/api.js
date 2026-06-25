// Module-owned API helpers. Tauri-only (SF12 deleted the Fastify fallback).
//
// Streaming: `subscribeRun(jobId, onEvent)` opens a Tauri `Channel<SkillEvent>`
// and dispatches the tagged-enum messages straight to SkillOutput.

import { invoke, Channel } from '@tauri-apps/api/core';

let _api = null;

export function bindSkillsApi(api) { _api = api; }

export const skillsApi = {
  getSkills: () => invoke('skills_list'),

  getSkill: (slug) => invoke('skills_get', { slug }),

  listSkillRuns: () => invoke('skills_list_runs'),

  // Returns `{ jobId, slug, command, _channel }`. Callers typically ignore
  // `_channel` and call `subscribeRun(jobId, ...)` instead.
  runSkill: async (slug, args, onEvent) => {
    const ch = new Channel();
    if (onEvent) ch.onmessage = onEvent;
    const start = await invoke('skills_run', { slug, args, onEvent: ch });
    return { ...start, _channel: ch };
  },

  // Late-attach to an existing job (e.g. webview reload). Opens a fresh
  // Channel handed to `skills_subscribe_run`, which immediately fires Replay
  // then becomes a live subscriber. Returns an unsubscribe function.
  subscribeRun: (jobId, onEvent) => {
    const ch = new Channel();
    ch.onmessage = (msg) => { try { onEvent(msg); } catch {} };
    invoke('skills_subscribe_run', { jobId, onEvent: ch }).catch(() => {});
    return () => { ch.onmessage = () => {}; };
  },

  cancelRun: (jobId) => invoke('skills_cancel_run', { jobId }),

  resizeRun: (jobId, cols, rows) => invoke('skills_resize_run', { jobId, cols, rows }),
};

export function subscribeSkillsEvent(handler) {
  return _api.vault.subscribe('skills', handler);
}

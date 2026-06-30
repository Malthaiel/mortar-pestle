// Insert a transcript into today's daily log under ## Quick Notes, reusing the
// host's canonical daily-log writer (api.daySections.addNote → appendToDaySection
// in web/src/api.js): it creates the log from the New Today Page skeleton AND
// registers it in the Pulse Index when the day has none, and carries the
// mtime/conflict gate. We never re-derive the Pulse path here (the pulse root
// doubles) — the host api owns that routing.

import { api as hostApi } from '@host/api.js';

function todayDs() {
  return new Date().toISOString().slice(0, 10);
}

// Collapse the transcript to a single Quick Notes bullet (raw newlines would
// break the markdown bullet). Returns { ok, ds, created }.
export async function insertTranscriptToDailyLog(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, reason: 'empty' };
  const ds = todayDs();
  const r = await hostApi.daySections.addNote(ds, clean);
  return { ok: !!r?.ok, ds, created: !!r?.created };
}

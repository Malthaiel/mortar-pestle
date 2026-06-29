// commsCompile.js — Comms Extraction (Deadlock Scrim Coaching, sub-plan 4) helpers.
// Pure ESM (no React, no @host) so it round-trips through a Node harness exactly like
// scrimSchema.js / matchData.js / noteCompile.js. The per-match Extract Comms button
// transcribes a Scrim Recording's audio (via coaching_extract_audio + the mortar-pestle-stt
// sidecar) and persists the full segments to a `.commstranscript.…` sidecar; this module
// renders the one-line `### Comms Transcript` opaque summary (a pointer to that sidecar)
// and parses the sidecar back into a view-model. Mirrors setCoachingSummaryBody
// (noteCompile.js) / setMatchDataBody (matchData.js) byte-for-byte in structure.

const MARKER = '_(Run-Process-owned — regenerated)_';

// Whole seconds → m:ss. Local mirror of matchData.clock so this module stays import-free
// / standalone-harnessable. "0:00" for missing/NaN.
function mmss(s) {
  const v = Number.isFinite(Number(s)) ? Math.max(0, Math.floor(Number(s))) : 0;
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

// Parse the `.commstranscript.…` sidecar JSON into a [{ t0Ms, t1Ms, text, speaker }]
// view-model. Tolerant: malformed/empty JSON or a non-array → [] (degrade to a gap, never
// throw — like matchData's extractMatch). `speaker` is reserved: always null in v1, so
// sub-plan 6 (diarization) can fill it with no migration.
export function parseSegments(jsonStr) {
  let raw;
  try { raw = JSON.parse(jsonStr); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => ({
    t0Ms: Number(s?.t0Ms) || 0,
    t1Ms: Number(s?.t1Ms) || 0,
    text: String(s?.text ?? '').trim(),
    speaker: s?.speaker ?? null,
  }));
}

// Render the one-line `### Comms Transcript` opaque body: a summary headline + a pointer
// to the raw sidecar + the regenerated-marker. The full segments live in the sidecar
// (keeps the .md lean — opaque bodies round-trip verbatim on every save). `durationS`
// falls back to the last segment's end time.
export function renderCommsSummary({ n, segments = [], durationS, sidecarFileName } = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  const durS = durationS != null
    ? durationS
    : (segs.length ? Math.max(...segs.map((s) => Number(s?.t1Ms) || 0)) / 1000 : 0);
  const lines = [
    `**Match ${n} comms · ${mmss(durS)} · ${segs.length} segment${segs.length === 1 ? '' : 's'}**`,
  ];
  if (sidecarFileName) lines.push('', `_Raw: \`${sidecarFileName}\`_`);
  lines.push('', MARKER);
  return lines.join('\n');
}

// Set the `### Comms Transcript` opaque body on match n — replace if present, append if
// absent. Exact mirror of setCoachingSummaryBody (noteCompile.js) / setMatchDataBody
// (matchData.js): a disk-owned region the Extract Comms flow writes straight through
// serializeScrim; mergeScrim pulls it fresh, so it never clobbers Match Data / Coaching
// Summary (and they never clobber it).
export function setCommsTranscriptBody(scrim, n, body) {
  return {
    ...scrim,
    matches: (scrim.matches || []).map((mm) => {
      if (mm.n !== n) return mm;
      const subs = mm.subsections || [];
      const has = subs.some((s) => s.kind === 'opaque' && s.heading === 'Comms Transcript');
      return {
        ...mm,
        subsections: has
          ? subs.map((s) => (s.kind === 'opaque' && s.heading === 'Comms Transcript' ? { ...s, body } : s))
          : [...subs, { kind: 'opaque', heading: 'Comms Transcript', body }],
      };
    }),
  };
}

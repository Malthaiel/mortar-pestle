// coachTranscribe.js — shapes speaker-labelled STT segments into the `00-transcript.md`
// the coaching pipeline reads. Pure ESM (no React, no @host) so it round-trips through a
// Node harness exactly like diarize.js / commsCompile.js.
//
// The format is a contract with `Citadel/Infrastructure/Scripts/coaching/method.py`, whose
// `TURN_RE = ^\s*\d+:\d{2}\s*$` counts turns by finding bare timestamp lines. So a turn is
// exactly three lines — the timestamp, the speaker, the text — and nothing else may look
// like a timestamp. Minutes are NOT wrapped at 60 (`\d+` in the pattern): an hour-long
// review keeps counting up to 72:15 rather than restarting.
//
// Speaker labels are deliberately dumb ("Speaker 1"). METHOD-A §8a merges everyone who is
// not the coach into one Student, so getting the names right buys the pipeline nothing.

// ms → `m:ss`, minutes uncapped.
export function stamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// Segments (already speaker-labelled — run alignDiarization + mergeTranscripts first) →
// the markdown body. Empty/whitespace-only text is dropped: whisper emits blank segments
// for spans the VAD passed but the decoder found nothing in, and a turn with no words
// still counts as a turn to method.py, inflating its anti-truncation gate.
export function coachTranscribe(segments) {
  const rows = (Array.isArray(segments) ? segments : [])
    .filter((s) => String(s?.text ?? '').trim())
    .map((s) => `${stamp(s?.t0Ms)}\n${String(s?.speaker || 'Speaker 1').trim()}\n${String(s.text).trim()}`);
  return `${rows.join('\n')}\n`;
}

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
// STUDENT labels are deliberately dumb — METHOD-A §8a merges everyone who is not the coach
// into one Student, so telling them apart buys the pipeline nothing. The COACH label is the
// exception and is NOT optional: `coach.py` binds phase 2 with "the coach is the speaker
// labelled <coach_label>, every other label is the Student". Ship a transcript with no such
// label and the coach's own words are filed as the student's, which is a wrong set of notes
// rather than a failed run.
//
// That label comes from the AUDIO TRACK, not from voice matching (Job 3, 2026-08-02): the OBS
// capture carries the mic on its own track and Discord on another, so every segment of the mic
// pass IS the coach by construction. A voice-tapping picker (`summarizeSpeakers`/`labelCoach`)
// lived here for one night and was removed with the track split — diarization put ~4 real
// people into 26 clusters and made the user adjudicate them.

// ms → `m:ss`, minutes uncapped.
export function stamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// Segments (already speaker-labelled — run mergeTranscripts first) →
// the markdown body. Empty/whitespace-only text is dropped: whisper emits blank segments
// for spans the VAD passed but the decoder found nothing in, and a turn with no words
// still counts as a turn to method.py, inflating its anti-truncation gate.
export function coachTranscribe(segments) {
  const rows = (Array.isArray(segments) ? segments : [])
    .filter((s) => String(s?.text ?? '').trim())
    .map((s) => `${stamp(s?.t0Ms)}\n${String(s?.speaker || 'Speaker 1').trim()}\n${String(s.text).trim()}`);
  return `${rows.join('\n')}\n`;
}

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
// STUDENT labels are deliberately dumb ("Speaker 1") — METHOD-A §8a merges everyone who is
// not the coach into one Student, so telling them apart buys the pipeline nothing. The COACH
// label is the exception and is NOT optional: `coach.py` binds phase 2 with "the coach is the
// speaker labelled <coach_label>, every other label is the Student". Ship a transcript with no
// such label and the coach's own words are filed as the student's, which is a wrong set of
// notes rather than a failed run. Hence `summarizeSpeakers` + `labelCoach` below: the user
// taps which voices are theirs before the file is written.

// A stable key for a cluster id, including the unattributed one. Cluster ids are numbers and
// `null` means the diarizer had no span covering that segment — both have to survive a round
// trip through a Set, so everything is stringified.
export function clusterKey(cluster) {
  return cluster == null ? 'unknown' : String(cluster);
}

// One row per distinct voice, most-talkative first, each carrying the first thing that voice
// said long enough to recognise. This is what the picker renders — the count and the sample
// are the only things that let someone tell "which of these 26 is me".
export function summarizeSpeakers(segments) {
  const by = new Map();
  for (const s of Array.isArray(segments) ? segments : []) {
    const text = String(s?.text ?? '').trim();
    if (!text) continue;
    const key = clusterKey(s?.cluster);
    const row = by.get(key) || { key, cluster: s?.cluster ?? null, speaker: s?.speaker || 'Unknown', count: 0, sample: '' };
    row.count += 1;
    // Prefer a sample with some substance — "Okay." identifies nobody.
    if (text.length > row.sample.length && row.sample.length < 60) row.sample = text;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

// Rename every segment belonging to a picked cluster to the coach's label. Picking several is
// normal and expected: the diarizer splits one person across clusters whenever their voice
// shifts, and on a real hour-long review it produced 26 clusters for about 4 people.
export function labelCoach(segments, coachKeys, coachLabel) {
  const picked = coachKeys instanceof Set ? coachKeys : new Set(coachKeys || []);
  const label = String(coachLabel || '').trim();
  if (!label || !picked.size) return Array.isArray(segments) ? segments : [];
  return (Array.isArray(segments) ? segments : []).map((s) => (
    picked.has(clusterKey(s?.cluster)) ? { ...s, speaker: label } : s
  ));
}

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

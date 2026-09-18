// Personal VODs — the match clock. Pure ESM (no React, no @host) so the node
// harness can drive it.
//
// THE RECORDER OWNS THE CLOCK. `startedMs` is the capture engine's own
// `started_at_unix_ms`, handed in by whoever started the recording — never
// `Date.now()` taken here. Elapsed is DERIVED at read time from that anchor, so
// a note's timestamp and the video's playhead are the same number by
// construction rather than by two counters agreeing. The overlay-host webview
// reloads on every Shift+C in dev, and any counter incremented by a setInterval
// would silently lose whatever time passed while it was gone.
//
// Nothing here is mirrored in Rust: Rust owns the keys, the capture engine owns
// the start instant, this owns only the file the notes go to.

const KEY = 'vod-timer';

const IDLE = { target: null, startedMs: null };

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function read() {
  const s = store();
  if (!s) return { ...IDLE };
  try {
    const raw = s.getItem(KEY);
    if (!raw) return { ...IDLE };
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return { ...IDLE };
    return {
      target: typeof v.target === 'string' && v.target ? v.target : null,
      startedMs: Number.isFinite(v.startedMs) ? v.startedMs : null,
    };
  } catch {
    return { ...IDLE };
  }
}

function write(next) {
  const s = store();
  try { s?.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}

// The engine reports `started_at_unix_ms: 0` while idle and for a beat after
// `start_clip` (state `starting`), and 0 is a perfectly finite number — anchored
// on it the clock would read 57 years. Nothing before 2020 is a real start.
const okStamp = (ms) => Number.isFinite(ms) && ms > 1_577_836_800_000;

/// True once a VOD is armed — the note sink and the header clock both gate on this.
export function isArmed(state = read()) {
  return !!state.target;
}

// Arm `target` against the recorder's start instant.
//
// `startedMs` MUST come from the capture snapshot (`started_at_unix_ms`); it
// falls back to now only when the engine omitted it, which is a degraded clock,
// not the design.
//
// A second start while already armed is IGNORED on purpose: these keys fire
// while the game has focus, and a stray F6 twenty minutes in would otherwise
// wipe the match with no undo. End is the only way back to zero.
export function start(target, startedMs) {
  if (!target) return read();
  const cur = read();
  if (isArmed(cur)) return cur;
  return write({ target, startedMs: okStamp(startedMs) ? startedMs : Date.now() });
}

// Re-anchor an already-armed clock on the engine's real start instant.
//
// `start_clip` can ack while the engine is still in `starting`, with no
// `started_at_unix_ms` yet — the arm then holds a best-effort anchor. The next
// snapshot carries the true one, and this replaces it. Correcting a live clock
// beats leaving the notes a second or two off the video for the whole match.
export function anchor(startedMs) {
  const cur = read();
  if (!isArmed(cur) || !okStamp(startedMs)) return cur;
  if (cur.startedMs === startedMs) return cur;
  return write({ ...cur, startedMs });
}

// Disarm completely. The caller also stops the recording and clears the Rust
// live target, so a stray hold-to-talk after the match cannot write into a
// finished VOD.
export function end() {
  return write({ ...IDLE });
}

export function elapsedMs(state = read()) {
  if (!isArmed(state)) return 0;
  return Math.max(0, Date.now() - (state.startedMs ?? Date.now()));
}

// `m:ss` with minutes UNCAPPED — a 70-minute Deadlock match reads 70:04, not
// 10:04. Same rule as coachTranscribe.stamp for the same reason.
export function fmt(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

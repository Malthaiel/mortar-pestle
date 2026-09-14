// Personal VODs — the match stopwatch. Pure ESM (no React, no @host) so the
// node harness can drive it.
//
// ANCHOR, NEVER A TICK COUNT. The state stored is a wall-clock ANCHOR
// (`startedMs`) plus the milliseconds banked across earlier pauses
// (`accumMs`); elapsed is DERIVED at read time. The overlay-host webview
// reloads on every Shift+C in dev, and any counter incremented by a setInterval
// would silently lose whatever time passed while it was gone — the exact class
// of bug the "measure, never predict" rule exists for. Nothing here is ever
// mirrored in Rust: Rust owns the keys, this owns the clock, one truth each.
//
// Malthaiel syncs the clock to the in-game timer by hand — the app never tries
// to read the game.

const KEY = 'vod-timer';

const IDLE = { target: null, startedMs: null, accumMs: 0, running: false };

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
      accumMs: Number.isFinite(v.accumMs) && v.accumMs >= 0 ? v.accumMs : 0,
      running: !!v.running,
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

/// True once a VOD is armed — the note sink and the header clock both gate on this.
export function isArmed(state = read()) {
  return !!state.target;
}

// Arm `target` and run from zero.
//
// A second start while already armed is IGNORED on purpose: these keys fire
// while the game has focus, and a stray F6 twenty minutes in would otherwise
// wipe the match with no undo. End is the only way back to zero.
export function start(target) {
  if (!target) return read();
  const cur = read();
  if (isArmed(cur)) return cur;
  return write({ target, startedMs: Date.now(), accumMs: 0, running: true });
}

// One key does both directions (the row is labelled "Pause / resume") — with
// three keys total there is nowhere else for resume to live.
export function pauseResume() {
  const cur = read();
  if (!isArmed(cur)) return cur;
  if (cur.running) {
    const banked = cur.accumMs + Math.max(0, Date.now() - (cur.startedMs ?? Date.now()));
    return write({ ...cur, startedMs: null, accumMs: banked, running: false });
  }
  return write({ ...cur, startedMs: Date.now(), running: true });
}

// Disarm completely. The caller also clears the Rust live target, so a stray
// hold-to-talk after the match cannot write into a finished VOD.
export function end() {
  return write({ ...IDLE });
}

export function elapsedMs(state = read()) {
  if (!isArmed(state)) return 0;
  const live = state.running ? Math.max(0, Date.now() - (state.startedMs ?? Date.now())) : 0;
  return state.accumMs + live;
}

// `m:ss` with minutes UNCAPPED — a 70-minute Deadlock match reads 70:04, not
// 10:04. Same rule as coachTranscribe.stamp for the same reason.
export function fmt(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

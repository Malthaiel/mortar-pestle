// Pure scheduling logic for Planner block timers + pull-forward rescheduling.
// No React, no IPC — the provider executes the WriteOps this module computes.
// Times are minutes-since-midnight. "24:00" is the end-of-day sentinel (1440)
// and must survive round-trips — never modulo it back to "00:00".

function pad(n) { return String(n).padStart(2, '0'); }

export function toMins(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

export function toHM(mins) {
  if (mins >= 1440) return '24:00';
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

// ── Block descriptors ───────────────────────────────────────────────────────
// A desc is the uniform shape the timer/pull layer works with:
//   { ref, key, label, startMins, endMins, wrapSegment }
// ref is kind-tagged and carries exactly what the write path needs. Keys are
// stable identities that survive the post-write remount (session ids are
// content-derived: `HH:MM:::HH:MM:::task`, so post-pull keys are computable).

export function blockKeyOf(ref) {
  if (ref.kind === 'session') return `s:${ref.ds}:${ref.id}`;
  if (ref.kind === 'frame') return `f:${ref.ds}:${ref.frameId}:${ref.segment || 'whole'}`;
  return `p:${ref.ds}:${ref.start}-${ref.end}-${ref.title}`;
}

// From a session-shaped calendar entry (real session OR merged frame segment).
export function descFromSession(s) {
  const isFrame = !!s.meta?.isFrame;
  const ref = isFrame
    ? { kind: 'frame', ds: s.dateKey, frameId: s.meta.frameId, segment: s.meta.segment || null }
    : { kind: 'session', ds: s.dateKey, id: s.id, task: s.task, notes: s.notes || '' };
  return {
    ref,
    key: blockKeyOf(ref),
    label: s.task,
    startMins: toMins(s.start),
    endMins: toMins(s.end),
    wrapSegment: isFrame && !!s.meta.segment,
  };
}

// From a plan-fence block (no id — the (start,end,title) tuple is identity,
// so keep the ORIGINAL strings for the write's old-tuple match).
export function descFromPlan(b, ds) {
  const ref = { kind: 'plan', ds, start: b.start, end: b.end, title: b.title };
  return {
    ref,
    key: blockKeyOf(ref),
    label: b.title,
    startMins: toMins(b.start),
    endMins: toMins(b.end),
    wrapSegment: false,
  };
}

// Re-find a (possibly stale) desc in a fresh desc list. Null = the block was
// deleted or re-timed externally; callers refuse the action.
export function resolveDesc(ref, freshDescs) {
  const key = blockKeyOf(ref);
  return freshDescs.find(d => d.key === key) || null;
}

// Selection-mode eligibility: later-or-equal start, not the source itself,
// never a midnight-split frame segment (overrides on those need cross-midnight
// pairing — excluded from pulls by design; still timer-startable + trimmable).
export function isEligibleForPull(desc, source) {
  return desc.key !== source.key && !desc.wrapSegment && desc.startMins >= source.startMins;
}

// ── Pull plan ───────────────────────────────────────────────────────────────
// WriteOps (executed by the provider, in array order):
//   { type:'session', ds, oldId, newSession:{task,start,end,notes} }
//   { type:'plan',    ds, oldBlock:{start,end,title}, newBlock:{start,end,title} }
//   { type:'frame',   ds, frameId, override:{start,end} }
// ORDER CONTRACT: session/plan ops (writerCall — chained daily mtime) MUST all
// precede frame ops (setOverride re-reads its own mtime and does NOT update
// the writer cache); the caller ends with one loadVault() to re-sync. Trims
// come before shifts within each class.

function frameTrimOp(desc, allBlocks, nowMins) {
  const { frameId, ds, segment } = desc.ref;
  let startHM;
  if (segment === 'tail') {
    // Trimming the after-midnight tail: the frame's canonical start lives on
    // the head segment. Missing pair → skip the trim (defensive).
    const head = allBlocks.find(b => b.ref.kind === 'frame'
      && b.ref.frameId === frameId && b.ref.segment === 'head');
    if (!head) return null;
    startHM = toHM(head.startMins);
  } else {
    // Non-wrap frame, or the pre-midnight head (trim collapses the wrap; the
    // same-day tail is already past at that hour — harmless).
    startHM = toHM(desc.startMins);
  }
  return { type: 'frame', ds, frameId, override: { start: startHM, end: toHM(nowMins) } };
}

function shiftOp(desc, newStart, newEnd) {
  const { ref } = desc;
  if (ref.kind === 'session') {
    return {
      type: 'session', ds: ref.ds, oldId: ref.id,
      newSession: { task: ref.task, start: toHM(newStart), end: toHM(newEnd), notes: ref.notes },
    };
  }
  if (ref.kind === 'plan') {
    return {
      type: 'plan', ds: ref.ds,
      oldBlock: { start: ref.start, end: ref.end, title: ref.title },
      newBlock: { start: toHM(newStart), end: toHM(newEnd), title: ref.title },
    };
  }
  return { type: 'frame', ds: ref.ds, frameId: ref.frameId, override: { start: toHM(newStart), end: toHM(newEnd) } };
}

function postPullKey(desc, newStart, newEnd) {
  const { ref } = desc;
  if (ref.kind === 'session') {
    return `s:${ref.ds}:${toHM(newStart)}:::${toHM(newEnd)}:::${ref.task}`;
  }
  if (ref.kind === 'plan') {
    return `p:${ref.ds}:${toHM(newStart)}-${toHM(newEnd)}-${ref.title}`;
  }
  return desc.key; // frame identity is frameId-stable across overrides
}

// source: desc being pulled to now. selected: later descs riding along (empty
// for past pulls). allBlocks: every desc for the day (trim scan + tail pairing).
// Returns { writes, post } or { refusal }.
export function computePullPlan({ source, selected = [], allBlocks, nowMins }) {
  const delta = nowMins - source.startMins;
  const shiftSet = [source];
  const seen = new Set([source.key]);
  for (const d of selected) {
    if (!seen.has(d.key)) { seen.add(d.key); shiftSet.push(d); }
  }

  const shifts = [];
  let post = null;
  for (const d of shiftSet) {
    const newStart = d.startMins + delta;
    const newEnd = Math.min(1440, d.endMins + delta);
    if (newEnd - newStart < 1) {
      return { refusal: 'No room left today — the block can’t fit before midnight.' };
    }
    shifts.push(shiftOp(d, newStart, newEnd));
    if (d.key === source.key) {
      post = { key: postPullKey(d, newStart, newEnd), label: d.label, endMins: newEnd, dateKey: d.ref.ds };
    }
  }

  // Trim pass: any block NOT being shifted whose span contains now is "the
  // block you just finished early" — its end becomes now. Strict < on start
  // so a block starting exactly now is left alone.
  const trims = [];
  for (const b of allBlocks) {
    if (seen.has(b.key)) continue;
    if (b.startMins < nowMins && nowMins < b.endMins) {
      const op = b.ref.kind === 'frame' ? frameTrimOp(b, allBlocks, nowMins) : shiftOp(b, b.startMins, nowMins);
      if (op) trims.push(op);
    }
  }

  const isWriter = op => op.type !== 'frame';
  const writes = [
    ...trims.filter(isWriter), ...shifts.filter(isWriter),
    ...trims.filter(op => !isWriter(op)), ...shifts.filter(op => !isWriter(op)),
  ];
  return { writes, post };
}

// Finish-early: trim ONE block's end to now (the running block). Same op
// shapes as the pull trim pass. Null when now sits outside the block's span —
// a run started ahead of its calendar slot (early start, no pull) or finished
// inside its first minute has nothing truthful to trim.
export function trimToNowOp(desc, allBlocks, nowMins) {
  if (!(desc.startMins < nowMins && nowMins < desc.endMins)) return null;
  return desc.ref.kind === 'frame'
    ? frameTrimOp(desc, allBlocks, nowMins)
    : shiftOp(desc, desc.startMins, nowMins);
}

// Next upcoming block (start >= now) for the completion prompt. In-window
// blocks are deliberately skipped — a long surrounding frame would otherwise
// shadow the natural "next to-do".
export function findNextBlock(allBlocks, nowMins, excludeKey) {
  let best = null;
  for (const b of allBlocks) {
    if (b.key === excludeKey || b.startMins < nowMins) continue;
    if (!best || b.startMins < best.startMins) best = b;
  }
  return best;
}

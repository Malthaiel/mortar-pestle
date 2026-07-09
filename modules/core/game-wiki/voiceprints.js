// voiceprints.js — Comms Diarization (Deadlock Scrim Coaching, sub-plan 6 SF3) voiceprint
// enrollment + matching. Pure ESM (no React, no @host) so it round-trips through a Node
// harness exactly like diarize.js / commsCompile.js. A team's saved voiceprints let new
// scrims auto-recognize each player: `stt_diarize_file` returns per-cluster mean embeddings,
// this module cosine-matches them against the team's saved prints → a name (or unknown), and
// the coach's one-time correction folds the embedding back into that player's running-average
// print so it sticks and improves.
//
// Per-team store (host-owned JSON, SF4 writes it into a deliberately-created
// `Deadlock/Coaching/Teams/<Team>/.voiceprints.json`):
//   { roster: [names], prints: { name: [f32] } }   // prints are L2-normalized vectors

// Default cosine threshold above which a cluster is accepted as a known player. Speaker
// embeddings are direction-only; tune at the SF1/SF4 live gate (Discord compression vs mic
// differences move the knee). Exposed as a param so the caller can override per team.
export const DEFAULT_THRESHOLD = 0.5;

// EMA weight for a correction: how much a new sample pulls the stored print. Small = stable
// (resists a noisy correction), large = adapts fast. 0.3 is a conservative default.
export const DEFAULT_ALPHA = 0.3;

// L2-normalize a vector to unit length (keeps stored prints from drifting in magnitude under
// repeated averaging; cosine itself is scale-invariant so matching is unaffected). Zero
// vector → zero vector (never divide by 0).
function l2normalize(v) {
  const vec = (Array.isArray(v) ? v : []).map((x) => Number(x) || 0);
  let n = 0;
  for (const x of vec) n += x * x;
  n = Math.sqrt(n);
  return n === 0 ? vec.map(() => 0) : vec.map((x) => x / n);
}

// Cosine similarity of two equal-length embedding vectors (−1..1). Returns 0 for empty,
// mismatched-length, or zero-magnitude inputs (a non-match, never NaN/throw).
export function cosineSimilarity(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  if (x.length === 0 || x.length !== y.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = Number(x[i]) || 0;
    const yi = Number(y[i]) || 0;
    dot += xi * yi;
    na += xi * xi;
    nb += yi * yi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// Best matching player for one cluster embedding. Returns { name, score }: the highest-scoring
// print's name when its cosine ≥ threshold, else { name: null } (unknown). `score` is the best
// cosine seen (0 when there are no prints).
export function matchCluster(embedding, prints = {}, threshold = DEFAULT_THRESHOLD) {
  let best = null;
  let bestScore = -Infinity;
  for (const [name, vec] of Object.entries(prints || {})) {
    const s = cosineSimilarity(embedding, vec);
    if (s > bestScore) {
      bestScore = s;
      best = name;
    }
  }
  const score = bestScore === -Infinity ? 0 : bestScore;
  return best != null && bestScore >= threshold ? { name: best, score } : { name: null, score };
}

// Assign a diarization's clusters to player names, GREEDILY 1:1 — a print can't label two
// clusters in one pass (two Discord voices never map to the same player). Highest cosine wins
// first. Returns { [clusterId]: name | null } for every cluster (unmatched → null).
export function matchClusters(clusters = [], prints = {}, threshold = DEFAULT_THRESHOLD) {
  const names = Object.keys(prints || {});
  const cands = [];
  for (const c of Array.isArray(clusters) ? clusters : []) {
    const cid = Number(c?.clusterId);
    if (!Number.isInteger(cid)) continue;
    for (const name of names) {
      const s = cosineSimilarity(c?.embedding, prints[name]);
      if (s >= threshold) cands.push({ cid, name, s });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  const usedCid = new Set();
  const usedName = new Set();
  const out = {};
  for (const { cid, name } of cands) {
    if (usedCid.has(cid) || usedName.has(name)) continue;
    out[cid] = name;
    usedCid.add(cid);
    usedName.add(name);
  }
  for (const c of Array.isArray(clusters) ? clusters : []) {
    const cid = Number(c?.clusterId);
    if (Number.isInteger(cid) && !(cid in out)) out[cid] = null;
  }
  return out;
}

// Enroll or correct a player's print with a new cluster embedding. A new name (or a dimension
// change) stores the embedding verbatim (L2-normalized); an existing name folds it in by an
// exponential running average, so a one-time correction improves the print without discarding
// history. Returns a NEW prints object (never mutates the input).
export function enrollPrint(prints = {}, name, embedding, alpha = DEFAULT_ALPHA) {
  const next = { ...(prints || {}) };
  const emb = l2normalize(embedding);
  const prev = next[name];
  next[name] =
    Array.isArray(prev) && prev.length === emb.length
      ? l2normalize(prev.map((x, i) => x * (1 - alpha) + emb[i] * alpha))
      : emb;
  return next;
}

// Tolerant parse of a `.voiceprints.json` store into `{ roster, prints }` — malformed/empty
// JSON or wrong shape degrades to an empty store (never throws), mirroring diarize/commsCompile.
export function parseVoiceprints(jsonStr) {
  let raw;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    return { roster: [], prints: {} };
  }
  const roster = Array.isArray(raw?.roster) ? raw.roster.map(String) : [];
  const prints = raw?.prints && typeof raw.prints === 'object' ? raw.prints : {};
  return { roster, prints };
}

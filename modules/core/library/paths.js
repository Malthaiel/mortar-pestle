// Shared hash-path encoders for every Library module route (Anime + Music). A
// vault series/album path is encoded segment-by-segment so the '/' separators
// survive inside the hash (encodeURIComponent alone would escape them).
// decodePath reverses exactly one encodePath pass.
//
// This is the ONE copy. Six Music files each carried a byte-identical private
// clone until 2026-07-25 — import from here rather than re-typing it.
//
// It used to loop until the string stopped changing, "defensively" unwinding
// repeated encoding. Nothing in the app ever double-encodes (encodePath is the
// only encoder and every route applies it once), so the loop had no real input
// to unwind — but it DID over-decode any name holding a literal escape:
// 'Track%20Name' → encode 'Track%2520Name' → decode 'Track%20Name' → loop again
// → 'Track Name', routing to an album that does not exist. Decoding once is both
// correct and what every caller assumed. Pinned in check-path-marshal.mjs.

export function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function decodePath(path) {
  // Per-segment try/catch: one malformed segment falls back to its raw text
  // instead of aborting the whole path (a bad '%' used to strand every
  // following segment still encoded).
  return path
    .split('/')
    .map((s) => { try { return decodeURIComponent(s); } catch { return s; } })
    .join('/');
}

// Shared hash-path encoders for the Anime module routes. A vault series path
// is encoded segment-by-segment so the '/' separators survive inside the hash
// (encodeURIComponent alone would escape them). decodePath reverses repeated
// encoding defensively, matching the prior in-VideoPage helper it replaces.

export function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function decodePath(path) {
  let prev;
  let current = path;
  let safety = 0;
  while (safety < 10 && current !== prev) {
    prev = current;
    try {
      current = current.split('/').map(s => decodeURIComponent(s)).join('/');
    } catch {
      break;
    }
    safety++;
  }
  return current;
}

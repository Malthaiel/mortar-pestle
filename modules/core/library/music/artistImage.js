// A photo of the ARTIST, for the album header.
//
// Nothing in the app stores one: MusicBrainz search results carry a name, an
// mbid, a country and a disambiguation and no image at all, and an album's own
// frontmatter holds only its sleeve. TheAudioDB does, its `strArtistThumb` is a
// square press photo, its free endpoint answers cross-origin (`*`) and needs no
// key or sign-up — the literal `2` in the path IS the free key. Same shape as
// util/characterImage.js, which solves the identical problem for a film's cast.
//
// Measured 2026-09-19 over 7 artists: 6 answered with a thumb; one (alyzea) is
// not in the database at all, which costs nothing — the header falls back to an
// initials circle, exactly as a playlist with no cover does.
//
// Every answer is cached in localStorage, MISSES INCLUDED, so a second visit to
// an album never repeats the round trip and an artist with no photo is probed
// once ever.

const CACHE_KEY = 'music:artistImages';
const API = 'https://www.theaudiodb.com/api/v1/json/2/search.php?s=';

const slug = (s) => String(s || '').trim().toLowerCase();

function read() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function write(value) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* private mode */ }
}

const images = read();
// Two albums by the same artist can mount in the same frame (the browser column
// and the detail pane). Without this they would each fire their own request.
const inflight = new Map();

async function probe(name) {
  const res = await fetch(API + encodeURIComponent(name));
  if (!res.ok) return '';
  const data = await res.json();
  const artist = data && Array.isArray(data.artists) ? data.artists[0] : null;
  return (artist && artist.strArtistThumb) || '';
}

// Resolves to a URL, or '' when this artist has no photo. Never rejects — a
// dead network must not break a header.
export async function artistImage(name) {
  const key = slug(name);
  if (!key) return '';
  if (key in images) return images[key];
  if (inflight.has(key)) return inflight.get(key);

  const p = probe(name)
    .catch(() => '')
    .then((url) => {
      images[key] = url;
      write(images);
      inflight.delete(key);
      return url;
    });
  inflight.set(key, p);
  return p;
}

// Test seam only — lets the self-check start from a known-empty cache.
export function __resetArtistImageCache() {
  for (const k of Object.keys(images)) delete images[k];
  inflight.clear();
}

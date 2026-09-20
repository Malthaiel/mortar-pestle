// A picture of the CHARACTER, for an animated film's cast tooltip.
//
// TMDb ships exactly one photo per credit -- the actor's headshot -- and has no
// character image at all. Those live on the film's Fandom wiki, whose MediaWiki
// read API answers cross-origin (`origin=*`), needs no key, and is a documented
// API rather than page scraping.
//
// Measured 2026-09-18 over 20 animated films: guessing the wiki from the film
// TITLE alone hit 13/20 -- every Pixar and Ghibli film misses, because those sit
// on one umbrella wiki rather than their own. Trying the film's STUDIO next
// (already stored on the card) recovered 6 of the 7. The one true miss was a
// one-off with no wiki anywhere, which costs nothing: the tooltip just shows the
// actor, exactly as a film with no character art does today.
//
// Every answer is cached in localStorage, misses included, so a second hover
// never repeats the round trip and a film with no wiki is probed once ever.

const CACHE_KEY = 'library:characterImages';
const WIKI_KEY = 'library:characterWikis';

// "Studio Ghibli" -> ghibli, "Illumination Entertainment" -> illumination.
// These words name a company's type, not the company, and no wiki is called
// after one.
const GENERIC = /^(studio|studios|pictures|picture|animation|animations|entertainment|films|film|movies|movie|productions|company|the)$/i;

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

const images = read(CACHE_KEY);
const wikis = read(WIKI_KEY);

// Wikis worth asking for this film, best guess first.
function candidates(film, studios) {
  const studio = Array.isArray(studios) ? studios[0] : studios;
  const bare = String(studio || '').split(/\s+/).filter(w => !GENERIC.test(w)).join('');
  return [...new Set([slug(film), slug(studio), slug(bare)].filter(Boolean))];
}

async function fromWiki(wiki, character) {
  const url = `https://${wiki}.fandom.com/api.php?action=query&generator=search`
    + `&gsrsearch=${encodeURIComponent(character)}&gsrlimit=1`
    + '&prop=pageimages&piprop=original&format=json&origin=*';
  const res = await fetch(url);
  if (!res.ok) return null;
  const pages = (await res.json())?.query?.pages;
  const page = pages && Object.values(pages)[0];
  const src = page?.original?.source;
  if (!src) return null;
  // The top hit for an odd name can be an unrelated page, and a wrong face is
  // worse than none -- so the page found must share a word with the character.
  const title = String(page.title || '').toLowerCase();
  const words = character.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  if (!words.some(w => title.includes(w))) return null;
  // The API hands back the ".../revision/latest?cb=…" form, which answers this
  // app with a 404 and the wiki's own grey "missing image" graphic -- which
  // LOADS, so nothing errors and the tooltip paints the placeholder as if it
  // were the character. The bare file URL serves the real picture.
  return src.replace(/\/revision\/.*$/, '');
}

export async function characterImage(film, studios, character) {
  if (!film || !character) return null;
  const key = `${slug(film)}|${slug(character)}`;
  if (key in images) return images[key];

  // The wiki that answered for this film's first character answers for the rest,
  // so only one credit per film ever pays for the probing.
  const known = wikis[slug(film)];
  const tries = known ? [known] : candidates(film, studios);
  let out = null;
  for (const wiki of tries) {
    try { out = await fromWiki(wiki, character); } catch { out = null; }
    if (out) { wikis[slug(film)] = wiki; write(WIKI_KEY, wikis); break; }
  }
  images[key] = out;
  write(CACHE_KEY, images);
  return out;
}

// matchImages.js — lazy client-side resolver for Deadlock hero + rank IMAGE assets from the
// deadlock-api asset endpoints. Those endpoints send `Access-Control-Allow-Origin: *`, so a
// browser fetch works with no Rust round-trip; csp:null lets <img> load the remote host. One
// fetch per manifest per session, memoized as a promise (12 portraits share one load). A miss
// or network failure resolves to an empty Map → the component shows its text fallback, never a
// broken image. Sibling to matchAssets.js's id→NAME bakes: names are baked+offline, images are
// live (Valve re-skins art far more often than it renames a hero).

const HEROES_URL = 'https://api.deadlock-api.com/v1/assets/heroes?only_active=true';
const RANKS_URL = 'https://api.deadlock-api.com/v1/assets/ranks';

let heroMapP = null; // Promise<Map<number,string>>  hero_id → small portrait URL
let rankMapP = null; // Promise<Map<number,string>>  tier    → small badge URL

async function loadHeroMap() {
  const res = await fetch(HEROES_URL);
  const list = await res.json();
  const m = new Map();
  for (const h of (Array.isArray(list) ? list : [])) {
    const url = h?.images?.icon_image_small || h?.images?.minimap_image || null;
    if (h?.id != null && url) m.set(h.id, url);
  }
  return m;
}

async function loadRankMap() {
  const res = await fetch(RANKS_URL);
  const list = await res.json();
  const m = new Map();
  for (const r of (Array.isArray(list) ? list : [])) {
    const url = r?.images?.small || r?.images?.large || null;
    if (r?.tier != null && url) m.set(r.tier, url);
  }
  return m;
}

// Memoized loaders — first call fetches, the rest reuse the promise. Errors degrade to an
// empty Map (component falls back to text), so a portrait miss never throws.
export const heroImageMap = () => (heroMapP ||= loadHeroMap().catch(() => new Map()));
export const rankImageMap = () => (rankMapP ||= loadRankMap().catch(() => new Map()));

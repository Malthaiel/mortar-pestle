// HeroPortrait — small round hero icon keyed off hero_id, image resolved live from
// deadlock-api (matchImages). Degrades to a text-initial chip on a missing id or a failed
// image load — never a broken image. New primitive (approved, Match View Rework Phase 0),
// staged in Prototypes.md before promotion. Used as the leadIcon on the Player Stats + Graphs
// tree leaves; also fine anywhere a hero needs a face.

import { useState, useEffect } from 'react';
import { heroImageMap } from './matchImages.js';
import { heroName } from './matchData.js';

export default function HeroPortrait({ heroId, size = 18 }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    heroImageMap().then((m) => { if (live) setUrl(m.get(heroId) || null); });
    return () => { live = false; };
  }, [heroId]);

  const base = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0, overflow: 'hidden',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--surface-3)',
  };
  if (!url || failed) {
    const initial = heroName(heroId).slice(0, 1).toUpperCase();
    return (
      <span style={{ ...base, fontSize: size * 0.5, fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
        {initial}
      </span>
    );
  }
  return (
    <span style={base}>
      <img src={url} alt="" width={size} height={size}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        onError={() => setFailed(true)} />
    </span>
  );
}

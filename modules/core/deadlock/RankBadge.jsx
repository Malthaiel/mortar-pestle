// RankBadge — Deadlock rank emblem + tier/subrank text, decoded from a raw badge number
// (tier*10 + subrank) via rankFromBadge; emblem image resolved live per-tier from deadlock-api
// (matchImages). Text-only until the image loads, and text-only for Unranked (tier 0). New
// primitive (approved, Match View Rework Phase 0), staged in Prototypes.md.
//
// Phase 0 only STANDS THE COMPONENT UP. The per-player rank data source lands in §2: the match
// sidecar carries no per-player badge (only a match-wide average, which reads 0 in scrims), so
// real ranks come from a deadlock-api player lookup wired later. Pass that badge here when it lands.

import { useState, useEffect } from 'react';
import { rankImageMap } from './matchImages.js';
import { rankFromBadge } from './matchAssets.js';

export default function RankBadge({ badge, size = 18 }) {
  const r = rankFromBadge(badge);
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    if (r.tier > 0) rankImageMap().then((m) => { if (live) setUrl(m.get(r.tier) || null); });
    else setUrl(null);
    return () => { live = false; };
  }, [r.tier]);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: r.color }}>
      {url && r.tier > 0 && <img src={url} alt="" width={size} height={size} style={{ display: 'block', flexShrink: 0 }} />}
      <span>{r.name}</span>
    </span>
  );
}

// Persistent stat strip pinned atop every Music browsing screen — the AnimeTopBar
// analog. The status / download tiles + Home button moved into the Library sidebar
// tree, so the topbar is slimmed to the read-only aggregates — Tracks + Artists —
// pending future use. Counts come from the shared useMusicStats store (one fetch,
// shared with the sidebar).

import { Topbar } from '@host/components/ui';
import { useMusicStats } from './useMusicStats.js';

export default function MusicTopBar({ accent }) {
  const { loading, tracks, artists } = useMusicStats();
  const n = (v) => (loading ? '—' : v);
  const tiles = [
    { id: 'tracks',  label: 'Tracks',  count: n(tracks),  static: true },
    { id: 'artists', label: 'Artists', count: n(artists), static: true },
  ];
  return <Topbar tiles={tiles} accent={accent} />;
}

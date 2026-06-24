// Persistent stat strip pinned atop every anime browsing screen. The status /
// download tiles + Home button moved into the Library sidebar tree (each status
// is now a count row there), so the topbar is slimmed to just the read-only
// aggregates — Rewatched + Episodes — pending future use. Counts come from the
// shared useAnimeStats store (one fetch, shared with the sidebar).

import { Topbar } from '@host/components/ui';
import { useAnimeStats } from './useAnimeStats.js';

export default function AnimeTopBar({ accent }) {
  const { loading, episodes, rewatched } = useAnimeStats();
  const n = (v) => (loading ? '—' : v);
  const tiles = [
    { id: 'rewatched', label: 'Rewatched', count: n(rewatched), static: true },
    { id: 'episodes',  label: 'Episodes',  count: n(episodes),  static: true },
  ];
  return <Topbar tiles={tiles} accent={accent} />;
}

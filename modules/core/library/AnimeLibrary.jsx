// Full-page anime library — the card grid lifted out of the retired
// SeriesSplit. Wraps SeriesBrowser (poster grid + search/sort filters) at full
// width. `status` (from the topbar route /tools/library/anime/library/<status>)
// pre-filters the grid; section navigation is owned by the persistent topbar.

import SeriesBrowser from './SeriesBrowser.jsx';
import { encodePath } from './paths.js';

export default function AnimeLibrary({ accent, status = null }) {
  const onSelect = (path) => { window.location.hash = '/tools/library/anime/' + encodePath(path); };
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SeriesBrowser accent={accent} onSelect={onSelect} selectedPath="" initialStatus={status} />
    </div>
  );
}

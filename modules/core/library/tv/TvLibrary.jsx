// Full-page TV shelf. The same SeriesBrowser the Anime room uses, pointed at
// the TV Shows catalog — `status` (from /tools/library/tv/library/<status>)
// pre-filters the grid.

import SeriesBrowser from '../SeriesBrowser.jsx';
import { encodePath } from '../paths.js';

export default function TvLibrary({ accent, status = null }) {
  const onSelect = (path) => { window.location.hash = '/tools/library/tv/' + encodePath(path); };
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SeriesBrowser accent={accent} onSelect={onSelect} selectedPath="" initialStatus={status} domain="TV Shows" />
    </div>
  );
}

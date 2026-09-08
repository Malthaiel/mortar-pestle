// Full-page shelf for a Stremio-backed room. The same SeriesBrowser the Anime
// room uses, pointed at this room's catalog — `status` (from
// /tools/library/<seg>/library/<status>) pre-filters the grid.

import SeriesBrowser from '../SeriesBrowser.jsx';
import { encodePath } from '../paths.js';
import { room, roomHome } from './util.js';

export default function RoomLibrary({ accent, kind = 'series', status = null }) {
  const onSelect = (path) => { window.location.hash = roomHome(kind) + '/' + encodePath(path); };
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SeriesBrowser accent={accent} onSelect={onSelect} selectedPath="" initialStatus={status} domain={room(kind).domain} />
    </div>
  );
}

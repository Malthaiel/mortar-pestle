// One search result as a full-width row: title, optional sub-line, optional
// right-aligned readout. `dim` greys a track whose audio isn't on disk.
//
// Lives apart from searchShared.jsx because React Fast Refresh refuses to
// hot-update a module that exports both hooks and a component — searchShared
// exports useSearchTab/useSearchSource, so keeping the row there made every
// edit log `hmr invalidate ... export is incompatible` and re-execute
// AlbumBrowser, MusicHome and AlbumDetail. Same reason useAddToPlaylistMenu
// was split out of AddToPlaylistButton.

import { useState } from 'react';

export default function ResultRow({ title, sub, right, dim, selected, onClick, onContextMenu }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={dim ? `${title} — not downloaded` : title}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        textAlign: 'left', width: '100%', padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        border: '1px solid ' + (selected ? 'var(--accent)' : 'var(--border)'),
        background: hover || selected ? 'var(--surface-2)' : 'transparent',
        cursor: 'pointer', transition: 'background 120ms ease',
        opacity: dim ? 0.5 : 1,
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span style={{
          fontSize: 13, fontWeight: 500, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        {sub && <span style={{
          fontSize: 11, color: 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{sub}</span>}
      </span>
      {right && (
        <span style={{
          fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums', flexShrink: 0,
        }}>{right}</span>
      )}
    </button>
  );
}

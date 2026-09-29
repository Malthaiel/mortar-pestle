// Always-visible "+ Playlist" control for a track row, album header, or queue
// row. `fuse` welds it into a .candy-split run (chip shape, the run's height).
// Click opens a ContextMenu listing the user's playlists ("Add to <name>")
// plus "New playlist with this song…". `refs` is the TrackRefInput[] to add (one
// for a single track, many for a whole album). Feedback via the global
// `agentic:notify` toast bridge — duplicates are surfaced, never silently
// dropped. `variant`: 'pill' (compact, for rows) | 'form' (candy outlined, for
// the album action row).

import { useState } from 'react';
import { useAddToPlaylistMenu } from './useAddToPlaylistMenu.jsx';

export default function AddToPlaylistButton({
  refs,
  accent,
  label = '+ Playlist',
  variant = 'pill',
  title = 'Save to Playlist',
  disabled,
  fuse = false,
  // Leading mark for the `form` trigger, so a fused one reads like the icon-led
  // parts it is welded to. The face is already inline-flex with its own gap.
  icon: Icon = null,
  // Anything else (data-open, for a name that opens on hover) lands on the form trigger.
  ...rest
}) {
  const { openMenu, modalEl, canAdd } = useAddToPlaylistMenu(accent);
  const [hover, setHover] = useState(false);

  const isDisabled = disabled || !canAdd(refs);
  const open = (e) => openMenu(e, refs);

  const trigger =
    variant === 'form' ? (
      <button
        {...rest}
        type="button"
        className="candy-btn"
        data-shape={fuse ? 'chip' : undefined}
        data-own-press
        onClick={open}
        disabled={isDisabled}
        title={title}
        // Fused, a greyed part keeps its paint (.candy-split rule in styles.css).
        style={fuse ? undefined : { height: 36, opacity: isDisabled ? 0.4 : 1 }}
      >
        <span className="candy-face" style={fuse ? undefined : { padding: '0 16px' }}>{Icon && <Icon size={14}/>}{label}</span>
      </button>
    ) : (
      <button
        type="button"
        onClick={open}
        disabled={isDisabled}
        title={title}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          flexShrink: 0,
          padding: '3px 9px',
          borderRadius: 999,
          border: `1px solid ${
            isDisabled
              ? 'var(--border)'
              : hover
                ? accent || 'var(--text-muted)'
                : 'var(--border)'
          }`,
          background: 'transparent',
          color: isDisabled ? 'var(--text-faint)' : hover ? accent || 'var(--text)' : 'var(--text-muted)',
          fontSize: 11,
          lineHeight: 1,
          fontFamily: 'var(--font-body)',
          whiteSpace: 'nowrap',
          cursor: isDisabled ? 'default' : 'pointer',
          transition: 'color 100ms ease, border-color 100ms ease',
        }}
      >
        {label}
      </button>
    );

  return (
    <>
      {trigger}
      {modalEl}
    </>
  );
}

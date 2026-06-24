// Always-visible "+ Playlist" control for a track row, album header, or queue
// row. Click opens a ContextMenu listing the user's playlists ("Add to <name>")
// plus "New playlist with this song…". `refs` is the TrackRefInput[] to add (one
// for a single track, many for a whole album). Feedback via the global
// `agentic:notify` toast bridge — duplicates are surfaced, never silently
// dropped. `variant`: 'pill' (compact, for rows) | 'form' (candy outlined, for
// the album action row).

import { useState } from 'react';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { usePlaylists } from './PlaylistProvider.jsx';
import PlaylistModal from './PlaylistModal.jsx';

function notify(detail) {
  window.dispatchEvent(new CustomEvent('agentic:notify', { detail }));
}

export default function AddToPlaylistButton({
  refs,
  accent,
  label = '+ Playlist',
  variant = 'pill',
  title = 'Add to playlist',
  disabled,
}) {
  const { playlists, addTracks, createPlaylist } = usePlaylists();
  const { openContextMenu } = useContextMenu();
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [hover, setHover] = useState(false);

  // Only references the app can actually resolve to audio are addable.
  const list = (refs || []).filter((r) => r && (r.audioPath || r.wikilink));
  const isDisabled = disabled || list.length === 0;

  const open = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (isDisabled) return;
    const items = [
      ...playlists.map((p) => ({ label: p.title, onClick: () => onAdd(p) })),
      {
        label: playlists.length ? '＋ New playlist…' : '＋ New playlist with this song…',
        onClick: () => setModal(true),
      },
    ];
    openContextMenu({ x: e.clientX, y: e.clientY }, items, { header: 'Add to playlist', accent });
  };

  const onAdd = async (pl) => {
    try {
      const n = await addTracks(pl, list);
      notify({
        type: 'info',
        title: n > 1 ? `Added ${n} tracks to ${pl.title}` : `Added to ${pl.title}`,
        iconKey: 'bell',
        accent: accent || 'var(--accent)',
        transient: true,
        duration: 2200,
      });
    } catch (e) {
      if (e && e.duplicate) {
        notify({ type: 'info', title: `Already in ${pl.title}`, iconKey: 'bell', transient: true, duration: 2200 });
      } else {
        notify({
          type: 'music-error',
          title: 'Couldn’t add to playlist',
          message: String(e?.message || e),
          iconKey: 'alert',
          accent: 'var(--error)',
          duration: 4000,
        });
      }
    }
  };

  const onCreate = async ({ title: name, coverFile }) => {
    setBusy(true);
    setError(null);
    try {
      const pl = await createPlaylist(name, list, coverFile);
      setModal(false);
      notify({
        type: 'info',
        title: `Created “${pl.title}”`,
        iconKey: 'bell',
        accent: accent || 'var(--accent)',
        transient: true,
        duration: 2200,
      });
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const trigger =
    variant === 'form' ? (
      <button
        type="button"
        className="candy-btn"
        data-own-press
        onClick={open}
        disabled={isDisabled}
        title={title}
        style={{ height: 36, opacity: isDisabled ? 0.4 : 1 }}
      >
        <span className="candy-face" style={{ padding: '0 16px' }}>{label}</span>
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
      <PlaylistModal
        open={modal}
        mode="create"
        accent={accent}
        onSubmit={onCreate}
        onClose={() => {
          if (!busy) {
            setModal(false);
            setError(null);
          }
        }}
        busy={busy}
        error={error}
      />
    </>
  );
}

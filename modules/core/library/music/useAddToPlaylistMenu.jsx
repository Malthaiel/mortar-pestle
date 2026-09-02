// The add-to-playlist ContextMenu + its "New playlist…" modal, with no trigger
// of its own. Three surfaces open the identical menu: AddToPlaylistButton (the
// always-visible "+ Playlist" pill on track rows, album headers and queue rows),
// and MusicPlayerWidget (right-click the sidebar player tile to add what's
// playing). It was briefly also wired into SidebarMusicSlot, which nothing
// mounted; that file was deleted 2026-08-08. Wiring the slot first was the
// 2026-08-08 miss: its Component Map row still called it "the slim persistent
// right-sidebar player", and a grep for its name returns only its own defn.
//
// Lives in its own file rather than beside the button because React Fast
// Refresh refuses to hot-update a module that exports both a hook and a
// component — keeping them together invalidated AddToPlaylistButton and every
// importer on each edit.
//
// `openMenu(e, refs, header)` takes its refs per call, so one hook instance
// serves a control whose track changes underneath it. Feedback goes through the
// global `agentic:notify` toast bridge — duplicates are surfaced, never
// silently dropped.

import { useRef, useState } from 'react';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { usePlaylists } from './PlaylistProvider.jsx';
import PlaylistModal from './PlaylistModal.jsx';

function notify(detail) {
  window.dispatchEvent(new CustomEvent('agentic:notify', { detail }));
}

export function useAddToPlaylistMenu(accent) {
  const { playlists, addTracks, createPlaylist } = usePlaylists();
  const { openContextMenu } = useContextMenu();
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The modal opens after the menu closes, so the refs it creates a playlist
  // from have to be parked at open time rather than read from a live prop.
  const pending = useRef([]);

  // Only references the app can actually resolve to audio are addable: a file on
  // disk, a vault track page, or (since 2026-08-08) a source link for a streamed
  // song. Anything with none of the three filters out and canAdd() is false.
  const addable = (refs) => (refs || []).filter((r) => r && (r.audioPath || r.wikilink || r.watchUrl));

  // The rows themselves, so a bigger menu (useSongMenu) can nest them as a
  // submenu instead of growing a second copy of this list.
  const buildItems = (refs) => {
    const list = addable(refs);
    pending.current = list;
    // Nothing addable at all (no file, no track page, no source link) still gets
    // a dead row rather than a swallowed click — the player tile right-clicks
    // whatever is playing. Same shape defaultMenus uses for "No link actions".
    return list.length === 0
      ? [{ label: 'Nothing to Add', disabled: true }]
      : [
          ...playlists.map((p) => ({ label: p.title, onClick: () => onAdd(p, list) })),
          {
            label: playlists.length ? '＋ New playlist' : '＋ New playlist with this song',
            onClick: () => setModal(true),
          },
        ];
  };

  const openMenu = (e, refs, header = 'Add to playlist') => {
    e.stopPropagation();
    e.preventDefault();
    openContextMenu({ x: e.clientX, y: e.clientY }, buildItems(refs), { header, accent });
  };

  const onAdd = async (pl, list) => {
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
      const pl = await createPlaylist(name, pending.current, coverFile);
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

  // The caller renders this wherever it likes; it draws nothing until opened.
  const modalEl = (
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
  );

  return { openMenu, buildItems, modalEl, canAdd: (refs) => addable(refs).length > 0 };
}

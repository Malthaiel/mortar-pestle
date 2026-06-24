// Playlist state, app-wide. Holds the list of user playlists (vault markdown
// pages under Knowledge/Music/Playlists/), hydrated on mount and refreshed on a
// `music-playlists-changed` window event. Playlist writes are direct
// Knowledge/*.md writes, which the manifest watcher does NOT observe — so, like
// DownloadProvider, this provider self-refreshes off its own event rather than
// the manifest. Every mutation re-emits the whole page through the Rust writer
// (`music_write_playlist`); toasts are dispatched by callers via `agentic:notify`.

import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { musicApi } from './api.js';

const Ctx = createContext(null);
const PLAYLISTS_CHANGED = 'music-playlists-changed';

function announce() {
  window.dispatchEvent(new CustomEvent(PLAYLISTS_CHANGED));
}

export function usePlaylists() {
  return (
    useContext(Ctx) || {
      playlists: [],
      refresh: async () => {},
      createPlaylist: async () => {},
      addTracks: async () => {},
      saveTracks: async () => {},
      rename: async () => {},
      setCover: async () => {},
      deletePlaylist: async () => {},
    }
  );
}

// De-dupe / identity key for a track reference.
export function trackKey(ref) {
  return ref.audioPath || ref.wikilink || ref.title || '';
}

// Build a writer ref from a now-playing/album-mapped queue item (carries the
// album* fields). Paths are stored WITHOUT extension — the Rust emitter re-adds
// `.opus` / `.md` and the parser strips them back.
export function refFromQueueItem(item) {
  const dir = item.audioPath ? item.audioPath.split('/').slice(0, -1).join('/') : '';
  return {
    wikilink: item.wikilink && dir ? `${dir}/${item.wikilink}` : null,
    audioPath: item.audioPath || null,
    title: item.title || '',
    artist: item.artist || null,
    albumPath: item.albumPath ? item.albumPath.replace(/\.md$/, '') : null,
    albumTitle: item.albumTitle || null,
    duration: item.duration ?? null,
  };
}

// Build a writer ref from a PlaylistTrack returned by read_playlist.
export function refFromPlaylistTrack(t) {
  return {
    wikilink: t.wikilink || null,
    audioPath: t.audioPath || null,
    title: t.title || '',
    artist: t.artist || null,
    albumPath: t.albumPath ? t.albumPath.replace(/\.md$/, '') : null,
    albumTitle: t.albumTitle || null,
    duration: t.duration ?? null,
  };
}

async function fileToBytes(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  return Array.from(buf);
}
function fileExt(file) {
  return (file.name.split('.').pop() || 'png').toLowerCase();
}

export function PlaylistProvider({ children }) {
  const [playlists, setPlaylists] = useState([]);

  const refresh = useCallback(async () => {
    try {
      setPlaylists((await musicApi.listPlaylists()) || []);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[playlists] list failed', e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const h = () => refresh();
    window.addEventListener(PLAYLISTS_CHANGED, h);
    return () => window.removeEventListener(PLAYLISTS_CHANGED, h);
  }, [refresh]);

  // Create: write the page FIRST so a duplicate name is blocked before any cover
  // file is written (no orphan covers on the error path), then attach the cover.
  const createPlaylist = useCallback(async (title, refs = [], coverFile = null) => {
    let pl = await musicApi.writePlaylist(title, refs, null, null);
    if (coverFile) {
      const rel = await musicApi.savePlaylistCover(title, await fileToBytes(coverFile), fileExt(coverFile));
      pl = await musicApi.writePlaylist(title, refs, pl.path, rel);
    }
    announce();
    return pl;
  }, []);

  // Overwrite a playlist's track list in place (reorder / remove), preserving
  // title + cover.
  const saveTracks = useCallback(async (playlist, refs) => {
    const pl = await musicApi.writePlaylist(playlist.title, refs, playlist.path, playlist.image || null);
    announce();
    return pl;
  }, []);

  // Append refs not already present. Throws `{duplicate:true}` if all are dupes.
  const addTracks = useCallback(async (playlist, refs) => {
    const cur = await musicApi.readPlaylist(playlist.path);
    const existing = new Set((cur.tracks || []).map((t) => trackKey(refFromPlaylistTrack(t))));
    const fresh = refs.filter((r) => !existing.has(trackKey(r)));
    if (fresh.length === 0) {
      const e = new Error('duplicate');
      e.duplicate = true;
      throw e;
    }
    const combined = (cur.tracks || []).map(refFromPlaylistTrack).concat(fresh);
    await musicApi.writePlaylist(cur.title, combined, cur.path, cur.image || null);
    announce();
    return fresh.length;
  }, []);

  // Rename: re-emit under the new name (Rust moves the cover + deletes the old
  // file). Returns the playlist at its new path.
  const rename = useCallback(async (playlist, newTitle) => {
    const cur = await musicApi.readPlaylist(playlist.path);
    const refs = (cur.tracks || []).map(refFromPlaylistTrack);
    const pl = await musicApi.writePlaylist(newTitle, refs, cur.path, cur.image || null);
    announce();
    return pl;
  }, []);

  const setCover = useCallback(async (playlist, coverFile) => {
    const cur = await musicApi.readPlaylist(playlist.path);
    const refs = (cur.tracks || []).map(refFromPlaylistTrack);
    const rel = await musicApi.savePlaylistCover(cur.title, await fileToBytes(coverFile), fileExt(coverFile));
    const pl = await musicApi.writePlaylist(cur.title, refs, cur.path, rel);
    announce();
    return pl;
  }, []);

  const deletePlaylist = useCallback(async (playlist) => {
    await musicApi.deletePlaylist(playlist.path);
    announce();
  }, []);

  const value = {
    playlists,
    refresh,
    createPlaylist,
    addTracks,
    saveTracks,
    rename,
    setCover,
    deletePlaylist,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

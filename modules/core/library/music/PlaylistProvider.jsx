// Playlist state, app-wide. Holds the list of user playlists (vault markdown
// pages under Knowledge/Music/Playlists/), hydrated on mount and refreshed on a
// `music-playlists-changed` window event. Playlist writes are direct
// Knowledge/*.md writes, which the manifest watcher does NOT observe — so, like
// DownloadProvider, this provider self-refreshes off its own event rather than
// the manifest. Every mutation re-emits the whole page through the Rust writer
// (`music_write_playlist`); toasts are dispatched by callers via `agentic:notify`.

import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { musicApi } from './api.js';

const Ctx = createContext(null);
const PLAYLISTS_CHANGED = 'music-playlists-changed';

// The one playlist the app owns: a heart/save list (Spotify's Liked Songs), NOT
// a downloads log — a saved track may be on disk or streamed, exactly like an
// album. Created on demand the first time something is saved; never deletable.
export const SAVED_TITLE = 'Saved Tracks';
export const isSavedTracks = (pl) => (pl?.title || '').trim() === SAVED_TITLE;

function announce() {
  window.dispatchEvent(new CustomEvent(PLAYLISTS_CHANGED));
}

// Rewrites rows in EVERY playlist: `swap(row)` returns the new row, or a falsy
// value to keep it. Only changed pages are written.
// ponytail: reads every playlist per call; fine at a handful.
async function rewriteRows(swap) {
  let changed = false;
  for (const s of (await musicApi.listPlaylists()) || []) {
    const cur = await musicApi.readPlaylist(s.path);
    const rows = (cur.tracks || []).map(refFromPlaylistTrack);
    const next = rows.map((r) => swap(r) || r);
    if (next.every((r, i) => r === rows[i])) continue;
    await musicApi.writePlaylist(cur.title, next, cur.path, cur.image || null);
    changed = true;
  }
  if (changed) announce();
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
      savedPlaylist: null,
      isSaved: () => false,
      toggleSaved: async () => false,
    }
  );
}

// De-dupe / identity key for a track reference.
export function trackKey(ref) {
  // watchUrl before title: two streamed hits can share a title but never a URL.
  // A plain (not downloaded) row keys by album + title: two albums' "Intro"
  // are different songs.
  return ref.audioPath || ref.wikilink || ref.watchUrl
    || (ref.albumPath ? `${ref.albumPath}|${ref.title || ''}` : ref.title) || '';
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
    // A streamed hit has no file and no track page — the source link is the
    // only thing the playlist row can point at.
    watchUrl: item.watchUrl || null,
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
    watchUrl: t.watchUrl || null,
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
      // A failed list renders identically to "you have no playlists", and the
      // renderer console never reaches the dev log — so surface it as a toast.
      window.dispatchEvent(new CustomEvent('agentic:notify', { detail: {
        type: 'error', title: 'Playlists failed to load',
        message: e?.message || String(e),
        accent: 'var(--error)', iconKey: 'alert', duration: 4500,
      } }));
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
  // Saved Tracks is found by its name, so it keeps it (its cover can change).
  const rename = useCallback(async (playlist, newTitle) => {
    if (isSavedTracks(playlist) && (newTitle || '').trim() !== SAVED_TITLE) {
      throw new Error(`“${SAVED_TITLE}” can’t be renamed.`);
    }
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
    if (isSavedTracks(playlist)) throw new Error(`“${SAVED_TITLE}” can’t be deleted.`);
    await musicApi.deletePlaylist(playlist.path);
    announce();
  }, []);

  // ── Saved Tracks ──────────────────────────────────────────────────────────
  const savedPlaylist = playlists.find(isSavedTracks) || null;
  const [savedKeys, setSavedKeys] = useState(() => new Set());

  // The summary list carries no rows, so the hearted set comes from reading the
  // page itself — re-read on every refresh, which is what every mutation ends in.
  useEffect(() => {
    if (!savedPlaylist) { setSavedKeys(new Set()); return undefined; }
    let live = true;
    musicApi
      .readPlaylist(savedPlaylist.path)
      .then((d) => {
        if (live) setSavedKeys(new Set((d.tracks || []).map((t) => trackKey(refFromPlaylistTrack(t)))));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [savedPlaylist?.path, playlists]);

  const isSaved = useCallback((ref) => !!ref && savedKeys.has(trackKey(ref)), [savedKeys]);

  // Heart / unheart one song. Returns the new saved state.
  const toggleSaved = useCallback(async (ref) => {
    if (!savedPlaylist) {
      await createPlaylist(SAVED_TITLE, [ref]);
      return true;
    }
    const cur = await musicApi.readPlaylist(savedPlaylist.path);
    const rows = (cur.tracks || []).map(refFromPlaylistTrack);
    const key = trackKey(ref);
    const has = rows.some((r) => trackKey(r) === key);
    await saveTracks(cur, has ? rows.filter((r) => trackKey(r) !== key) : rows.concat([ref]));
    return !has;
  }, [savedPlaylist, createPlaylist, saveTracks]);

  // Save without un-saving — the auto-save path must never toggle a song off.
  // addTracks already de-dupes and throws `{duplicate:true}` when it's a no-op.
  const ensureSaved = useCallback(async (ref) => {
    if (!savedPlaylist) {
      await createPlaylist(SAVED_TITLE, [ref]);
      return;
    }
    try {
      await addTracks(savedPlaylist, [ref]);
    } catch (e) {
      if (!e?.duplicate) throw e;
    }
  }, [savedPlaylist, createPlaylist, addTracks]);

  // The listener registers once, so route it through a ref that always holds the
  // current fn (which closes over the live saved playlist).
  const ensureSavedRef = useRef(ensureSaved);
  ensureSavedRef.current = ensureSaved;

  // A downloaded LOOSE song (no album card): first every playlist row pointing
  // at its link switches to the saved file (user-picked 2026-09-27), so the
  // playlist knows it is on disk; then it auto-saves -- Saved Tracks is the only
  // place it could ever appear, and a switched Saved row de-dupes the add.
  // Album-track downloads never touch either.
  // The switched row keeps the link anyway: read_playlist reads it back off
  // the song's page (Source URL), with the file on disk or not.
  useEffect(() => {
    const h = async (e) => {
      const j = e.detail || {};
      if (!j.audioPath) return;
      const ref = {
        wikilink: j.audioPath.replace(/\.opus$/i, ''),
        audioPath: j.audioPath,
        title: j.title || '',
        artist: j.artist || null,
        albumPath: null,
        albumTitle: null,
        duration: j.duration ?? null,
        watchUrl: j.watchUrl || null,
      };
      try {
        if (j.watchUrl) {
          await rewriteRows((r) => r.watchUrl === j.watchUrl
            && { ...ref, title: r.title || ref.title, artist: r.artist || ref.artist });
        }
        await ensureSavedRef.current(ref);
      } catch { /* the song is on disk either way; the rows stay links */ }
    };
    window.addEventListener('music-single-downloaded', h);
    return () => window.removeEventListener('music-single-downloaded', h);
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
    savedPlaylist,
    isSaved,
    toggleSaved,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

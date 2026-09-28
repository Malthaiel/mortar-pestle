// One playlist, on the shared record page (RecordPage.jsx) -- the exact page an
// album wears (user-directed 2026-09-27): the cover full-bleed behind it, one
// fact line, the same action run, the same song rows plus the artist and a
// Remove part. No tabs (Credits and Discography are one artist's), no reorder.
// Edits persist by re-emitting the whole page through the provider. Reloads on
// `music-playlists-changed` (our writes, a downloaded song's row switch) and
// `music-library-changed` (an album download flips rows to on-disk).

import { useEffect, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import { usePlaylists, refFromPlaylistTrack, isSavedTracks } from './PlaylistProvider.jsx';
import { useDownloads } from './DownloadProvider.jsx';
import PlaylistModal from './PlaylistModal.jsx';
import CollageCover from './CollageCover.jsx';
import { encodePath } from '../paths.js';
import { navigate } from '@host/router.js';
import { useSongMenu } from './contextMenus.js';
import { trackToQueueItem, coverSrc, squash, TILE_MIN } from './util.js';
import { usePrefetchStreams } from './streamCache.js';
import { POSTER_COL_GAP, POSTER_DEPTH, PosterTile } from '../AnimeDetailHeader.jsx';
import ImageLightbox, { useLightbox } from '../ImageLightbox.jsx';
import { RecordPage, ActionRun, TrackRow, ArtistLink, Centered } from './RecordPage.jsx';
import { usePlayCounts, countPlays, useWorldPlays, useTrackVideos, worldCells } from './recordHooks.js';

// A song's identity on this page: two artists' "Intro" are different songs.
const songId = (t) => `${squash(t.artist)}|${squash(t.title)}`;

export default function PlaylistDetail({ path, accent }) {
  const [pl, setPl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState(null);
  const [dlJobIds, setDlJobIds] = useState([]);
  const reqId = useRef(0);

  const { playTracks, enqueue, currentTrack, isPlaying, toggle } = useMusicPlayer();
  const { saveTracks, rename, setCover, deletePlaylist } = usePlaylists();
  const { jobs: dlJobs } = useDownloads();
  const songMenu = useSongMenu(accent);

  const load = () => {
    const myId = ++reqId.current;
    musicApi
      .readPlaylist(path)
      .then((d) => {
        if (myId === reqId.current) {
          setPl(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (myId === reqId.current) {
          setError(String(e?.message || e));
          setLoading(false);
        }
      });
  };

  useEffect(() => {
    setLoading(true);
    setError(null);
    setPl(null);
    setDlJobIds([]);
    load();
    const h = () => load();
    window.addEventListener('music-playlists-changed', h);
    window.addEventListener('music-library-changed', h);
    return () => {
      window.removeEventListener('music-playlists-changed', h);
      window.removeEventListener('music-library-changed', h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const tracks = pl?.tracks || [];
  const songs = tracks.map((t) => ({ id: songId(t), artist: t.artist, title: t.title }));
  const world = useWorldPlays(pl ? 'music:worldPlays:' + pl.path : null, songs);
  // A YouTube-link row IS its video; every other song gets its own search
  // (a playlist's artists differ, so the album's one search can't cover it).
  const videos = useTrackVideos(pl ? 'music:trackVideos:' + pl.path : null,
    tracks.filter((t) => !t.watchUrl && t.artist).map((t) => ({
      q: `${t.artist} ${t.title} official video`, artist: t.artist,
      songs: [{ id: songId(t), title: t.title }], limit: 5,
    })));
  const plays = usePlayCounts();
  // The cover's viewer: the playlist's own picture, or its collage's sleeves.
  const lb = useLightbox();
  // Not-downloaded songs get their links ahead: first 30, then as rows scroll
  // into view (user-directed 2026-09-26), so a click plays at once.
  const rowRefs = useRef([]);
  usePrefetchStreams(pl ? tracks.map((t) => trackToQueueItem(t, pl)) : [], rowRefs);

  if (loading) return <Centered>Loading</Centered>;
  if (error) return <Centered tone="error">Failed to load: {error}</Centered>;
  if (!pl) return <Centered>Not found</Centered>;

  const items = tracks.map((t) => trackToQueueItem(t, pl));
  const saved = isSavedTracks(pl);
  const rowPlayable = (i) => !!(items[i] && (items[i].available || items[i].streamable));
  const playable = items.filter((it) => it.available || it.streamable);

  const playFrom = (i) => {
    if (rowPlayable(i)) playTracks(items, i);
  };

  // Optimistic local update + persist (remove). On failure, reload.
  const persist = (nextTracks) => {
    setPl((p) => ({ ...p, tracks: nextTracks }));
    saveTracks(pl, nextTracks.map(refFromPlaylistTrack)).catch((e) => {
      setError(String(e?.message || e));
      load();
    });
  };
  const removeAt = (i) => persist(tracks.filter((_, idx) => idx !== i));
  // Right-click a row → the shared song menu, plus this surface's own removal
  // (playlist entry only, never the underlying track).
  const rowMenu = (e, i) => songMenu.openMenu(e, items[i], [
    { label: 'Remove from Playlist', danger: true, onClick: () => removeAt(i) },
  ]);

  // The album's two fields, patched onto this page by the same commands.
  const setStatus = async (status) => {
    setBusy(true);
    try {
      await musicApi.markAlbumStatus(pl.path, status);
      setPl((p) => ({ ...p, status }));
    } catch (e) {
      setError(String(e?.message || e));
    } finally { setBusy(false); }
  };
  const setRating = (r) => {
    musicApi.markAlbumRating(pl.path, r)
      .then(() => setPl((p) => ({ ...p, personalRating: r })))
      .catch((e) => alert('Rating failed: ' + (e?.message || e)));
  };

  // Download missing: one job per song not on disk, each the song menu's own
  // Download. A YouTube row's finished download switches the row to the saved
  // file (PlaylistProvider), so it stops counting as missing.
  // ponytail: a plain (off-disk) album row never flips to on-disk after its
  // download -- the row has no file link to find. Link it on album download
  // if such rows turn up (none on 2026-09-27).
  const missing = tracks.map((t, i) => i).filter((i) => !tracks[i].available && (tracks[i].watchUrl || tracks[i].albumPath));
  const myJobs = dlJobs.filter((j) => dlJobIds.includes(j.id));
  const dlBusy = myJobs.some((j) => j.state === 'queued' || j.state === 'downloading');
  const dlDone = myJobs.filter((j) => j.state === 'done').length;
  const startDownload = async () => {
    if (dlBusy) return;
    const ids = [];
    for (const i of missing) {
      const id = await songMenu.download(items[i]);
      if (id) ids.push(id);
    }
    setDlJobIds(ids);
  };
  // Nothing missing and songs on disk: Uninstall. Every on-disk song goes to
  // the recycling bin, album songs included; every row stays and streams
  // instead (user-picked 2026-09-28): an album song by its album, a loose song
  // by the link read_playlist reads off its page.
  // ponytail: one bin item per song; a loose song with no link is kept, since
  // its row could never play again.
  // One per file: a song listed twice is still one file.
  const onDisk = [...new Map(tracks.filter((t) => t.available && t.audioPath).map((t) => [t.audioPath, t])).values()];
  const onUninstall = async () => {
    const n = onDisk.length;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Uninstall “${pl.title}”? Its ${n} downloaded song${n === 1 ? '' : 's'} go to the recycling bin, `
      + `including songs that belong to an album. Every row stays in the playlist.`)) return;
    setBusy(true);
    try {
      for (const t of onDisk) if (t.albumPath || t.watchUrl) await musicApi.trashFile(t.audioPath);
    } catch (e) {
      alert('Uninstall failed: ' + (e?.message || e));
    } finally {
      window.dispatchEvent(new CustomEvent('music-library-changed'));
      setBusy(false);
    }
  };
  const download = (missing.length || dlBusy) ? {
    // Nothing on disk yet = the whole playlist; some = what's missing (the album's Repair).
    label: dlBusy ? `Downloading ${dlDone}/${myJobs.length}` : onDisk.length ? `Download ${missing.length} Missing` : 'Download Playlist',
    rest: dlBusy ? `${dlDone}/${myJobs.length}` : null,
    busy: dlBusy,
    onClick: startDownload,
  } : onDisk.length ? { label: 'Uninstall Playlist', hot: true, busy, onClick: onUninstall }
    : { label: 'Nothing to Download', inert: true };

  const onEdit = async ({ title, coverFile }) => {
    setEditBusy(true);
    setEditErr(null);
    try {
      let target = pl;
      if (title && title !== pl.title) target = await rename(pl, title);
      if (coverFile) target = await setCover(target, coverFile);
      setEditOpen(false);
      if (target.path !== path) navigate('/tools/library/music/playlists/' + encodePath(target.path));
      else load();
    } catch (e) {
      setEditErr(String(e?.message || e));
    } finally {
      setEditBusy(false);
    }
  };

  const onDelete = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete playlist “${pl.title}”? It'll go to the recycling bin — your tracks are kept.`)) return;
    try {
      await deletePlaylist(pl);
      navigate('/tools/library/music/playlists');
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  // The picture: the playlist's own cover, else the collage built from its
  // first sleeves (CollageCover), whose first sleeve is also the backdrop.
  // With neither there is no backdrop, and the page takes the flat header.
  const sleeves = (pl.coverUrls || []).filter(Boolean);
  const own = pl.image ? coverSrc(pl.image, 400, { library: true }) : null;
  const ownFull = pl.image ? coverSrc(pl.image, 0, { library: true }) : null;
  const sleeveFull = (u) => coverSrc(u, 0, { library: true });
  const backdrop = ownFull || (sleeves[0] ? sleeveFull(sleeves[0]) : null);
  const openPicture = () => {
    if (ownFull) lb.show(ownFull, pl.title);
    else if (sleeves[0]) lb.show(sleeveFull(sleeves[0]), pl.title);
  };
  // A collage opens its first sleeve with every sleeve in the viewer's side
  // column, the album's artwork viewer shape.
  const aside = !pl.image && sleeves.length > 1 && (
    <div style={{ width: TILE_MIN, display: 'flex', flexDirection: 'column', gap: POSTER_COL_GAP, paddingBottom: POSTER_DEPTH }}>
      {sleeves.map((u) => (
        <PosterTile key={u} image={coverSrc(u, 250, { library: true })} title={pl.title}
          accent={accent || 'var(--accent)'} aspect="1 / 1"
          active={lb.src === sleeveFull(u)} onClick={() => lb.show(sleeveFull(u), pl.title)} />
      ))}
    </div>
  );

  // The fact line, in the album's order: the top two artists (the first with
  // its photo), the day it was made, the song count, the length summed off the
  // real rows (user-picked 2026-09-27).
  const byArtist = new Map();
  for (const t of tracks) if (t.artist) byArtist.set(t.artist, (byArtist.get(t.artist) || 0) + 1);
  const top = [...byArtist.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const more = top.length - 2;
  const secs = tracks.reduce((t, x) => t + (x.duration || 0), 0);
  const made = pl.created ? new Date(pl.created + 'T00:00').toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const facts = [
    top.length ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <ArtistLink name={top[0]} accent={accent}/>
        {top[1] && <>, <ArtistLink name={top[1]} accent={accent} photo={false}/></>}
        {more > 0 && ` + ${more} more`}
      </span>
    ) : null,
    made,
    `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
    secs ? `${Math.round(secs / 60)}m` : null,
  ].filter(Boolean);

  // Every key a row's listens can carry, whether its file is on disk or not
  // (the album-and-title key is only its streamKey while off disk), so a
  // download or an uninstall never moves the count (user-directed 2026-09-28).
  const trackPlays = plays ? tracks.map((t) => countPlays(plays, [t.audioPath, t.watchUrl, `${t.albumPath}|${t.title}`])) : null;
  const playsDigits = trackPlays ? String(Math.max(0, ...trackPlays)).length : 1;
  const cells = worldCells(world, songs.map((s) => s.id));
  // Every artist on the page, for TrackRow's artist slot to size to.
  const artistSizers = [...new Set(tracks.map((t) => t.artist || '–'))];

  return (
    <RecordPage
      accent={accent}
      backdrop={backdrop}
      picture={own}
      cover={own ? null : <CollageCover image={null} urls={pl.coverUrls} title={pl.title} accent={accent} />}
      onPictureClick={openPicture}
      tag="Playlist"
      title={pl.title}
      facts={facts}
      actions={
        <ActionRun
          accent={accent}
          playLabel="Play Playlist"
          onPlay={() => { if (playable.length) playTracks(items, 0); }}
          download={download}
          status={pl.status}
          rating={pl.personalRating}
          busy={busy}
          onStatus={setStatus}
          onRating={setRating}
          playlistRefs={() => tracks.map(refFromPlaylistTrack)}
          onQueue={() => { if (playable.length) enqueue(playable); }}
          moreItems={[
            { label: 'Edit Details', onClick: () => setEditOpen(true) },
            // Saved Tracks cannot be deleted at all.
            !saved && { label: 'Delete playlist', onClick: onDelete },
          ].filter(Boolean)}
        />
      }
      after={<>
        <ImageLightbox {...lb} accent={accent || 'var(--accent)'} aside={aside} />
        <PlaylistModal
          open={editOpen}
          mode="edit"
          initialTitle={pl.title}
          initialImage={pl.image}
          accent={accent}
          onSubmit={onEdit}
          onClose={() => {
            if (!editBusy) {
              setEditOpen(false);
              setEditErr(null);
            }
          }}
          busy={editBusy}
          error={editErr}
        />
        {songMenu.modalEl}
      </>}
    >
      {tracks.length === 0 && (
        <div style={{ color: 'var(--text-faint)', fontSize: 13, textAlign: 'center', padding: '36px 24px' }}>
          Empty playlist. Add songs with Save to Playlist on any song or album.
        </div>
      )}
      {/* The album's row gap: the film Cast list's (--credit-gap) plus the chip
          lip, which paints outside layout. */}
      <div data-spacing-intent="credit-gap" style={{ display: 'flex', flexDirection: 'column', gap: 'calc(var(--credit-gap) + var(--candy-depth-small))' }}>
        {tracks.map((t, i) => {
          // Stream tracks have no audioPath (null === null would light every
          // stream row) — fall back to album+track identity.
          const playingThis = !!currentTrack && (currentTrack.audioPath
            ? currentTrack.audioPath === t.audioPath
            : currentTrack.albumPath === (t.albumPath || pl.path) && currentTrack.n === t.n);
          const id = songs[i].id;
          return (
            <div key={i + ':' + (t.audioPath || t.watchUrl || t.title)} ref={(el) => { rowRefs.current[i] = el; }}>
              <TrackRow
                track={{ ...t, n: i + 1 }}
                artist={t.artist}
                artistSizers={artistSizers}
                plays={trackPlays?.[i]}
                playsDigits={playsDigits}
                accent={accent}
                playlistRef={refFromPlaylistTrack(t)}
                videoUrl={t.watchUrl || videos[id]}
                world={world[id]}
                worldText={cells.text(id)}
                worldSizers={cells.sizers}
                playing={playingThis && isPlaying}
                onMenu={(e) => rowMenu(e, i)}
                onPlay={() => (playingThis ? toggle() : playFrom(i))}
                onEnqueue={() => enqueue([items[i]])}
                onRemove={() => removeAt(i)}
              />
            </div>
          );
        })}
      </div>
    </RecordPage>
  );
}

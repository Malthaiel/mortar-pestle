// RIGHT pane of the Music page for an album. Feeds the shared record page
// (RecordPage.jsx, the same page a playlist wears): the sleeve, the fact line,
// the action run, the Tracks / Credits / Discography tabs, and the disc-grouped
// tracklist. The ONE album page (user-directed 2026-09-28: "all album pages are
// the same"): a library card by `albumPath`, or a Browse album by `rgMbid`.

import { useEffect, useState } from 'react';
import { musicApi, useMbRefreshTick, useCaaCover } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import { IconRadio, IconMusic, IconGroup } from '@host/components/icons.jsx';
import { libraryAbs } from '@host/api.js';
import { coverSrc, TILE_MIN, albumToQueueItems, squash } from './util.js';
import { usePrefetchStreams } from './streamCache.js';
import { refFromQueueItem } from './PlaylistProvider.jsx';
import { AlbumPerformers, ArtistAlbums } from './MusicCredits.jsx';
import { usePersistedState } from '@host/components/vault-tree/useTreeExpansion.js';
import { useDownloads } from './DownloadProvider.jsx';
import { consumeTrackHighlight } from './searchShared.jsx';
import { useSongMenu } from './contextMenus.js';
import { navigate } from '@host/router.js';
import { POSTER_COL_GAP, POSTER_DEPTH, PosterTile } from '../AnimeDetailHeader.jsx';
import ImageLightbox, { useLightbox } from '../ImageLightbox.jsx';
import { RecordPage, ActionRun, TabRun, TrackRow, ArtistLink, Centered } from './RecordPage.jsx';
import { usePlayCounts, countPlays, useWorldPlays, useTrackVideos, worldCells } from './recordHooks.js';

// The film's tab strip (AnimeMainColumn FILM_TABS), for a record: one section
// under the hairline at a time (user-directed 2026-09-26).
// Icon + word, like Play; "Credits" because "Performers" ran too long
// (user-directed 2026-09-26). Details was removed the same day (user-directed);
// a persisted 'Details' falls back to Tracks through the includes() guard.
// Releases and Artwork tabs were built and removed the same day (user-directed);
// the artwork moved into the sleeve's own viewer.
// A Plays tab went the same way: each song's count is a part of its own row.
// Discography is the artist's other records, moved up from the "More from"
// rail under the header (user-directed 2026-09-26, named over "Albums"),
// last in the strip (user-directed 2026-09-27; second before). Names must not
// shrink left to right: opening a tab shuts the open one's name, so a long name
// left of a shorter one slides the shorter tab wholly out from under a pointer on
// it (its hover shrinks the run off the pointer, the picked tab reopens under it,
// and the pair twitches: filmed 2026-09-27).
const ALBUM_TABS = ['Tracks', 'Credits', 'Discography'];
const TAB_ICON = { Tracks: IconMusic, Credits: IconGroup, Discography: IconRadio };

// The track's own page: an md sibling of the audio file, falling back to the
// pipeline's Tracks folder for a card with no audio on disk. `wikilink` is the
// base filename with no extension.
function openTrackPage(track) {
  if (!track.wikilink) return;
  const albumFolder = track.audioPath ? track.audioPath.split('/').slice(0, -1).join('/') : '';
  const target = albumFolder
    ? albumFolder + '/' + track.wikilink + '.md'
    : 'Knowledge/Music/MusicBrainz Pipeline/Tracks/' + track.wikilink + '.md';
  window.location.hash = '/page/' + target.split('/').map(encodeURIComponent).join('/');
}

const CAA = 'https://coverartarchive.org';

// A Browse album nobody owns yet, shaped like a card with no file behind it: no
// path, every track off disk. streamKey is Browse's stream identity, so the
// playing row, the queue and the listen log key as they always have.
const browseAlbum = (d) => ({
  path: null, providerId: d.releaseGroupMbid, releaseMbid: d.releaseMbid,
  title: d.title, artist: d.artist, year: d.year, releaseType: d.primaryType,
  image: `${CAA}/release-group/${d.releaseGroupMbid}/front-500`,
  tracks: d.tracks.map(t => ({
    n: t.position, disc: t.disc, title: t.title, available: false, audioPath: null,
    duration: t.lengthMs != null ? Math.round(t.lengthMs / 1000) : null,
    streamKey: `${d.releaseGroupMbid}|${t.disc}|${t.position}`,
  })),
});

export default function AlbumDetail({ accent, albumPath, rgMbid }) {
  const [album, setAlbum] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { playAlbumTracks, enqueue, currentTrack, isPlaying, toggle } = useMusicPlayer();
  const { jobs: dlJobs, enqueue: enqueueDownload } = useDownloads();
  const songMenu = useSongMenu(accent);
  const [dlJobId, setDlJobId] = useState(null);
  const [dlError, setDlError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // A Browse album is the owned card when the library has one, else the
    // release group. Re-run on every library change, so an add or a download
    // turns this very page into the owned one in place: no page switch
    // (user-directed 2026-09-28).
    const read = async () => {
      if (!rgMbid) return musicApi.readAlbum(albumPath);
      const own = ((await musicApi.listAlbums()) || []).find(a => a.providerId === rgMbid);
      return own ? musicApi.readAlbum(own.path) : browseAlbum(await musicApi.releaseGroupDetail(rgMbid));
    };
    const load = () => read()
      .then(d => { if (!cancelled) { setAlbum(d); setLoading(false); } })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false); } });
    setLoading(true); setError(null); setAlbum(null);
    load();
    // A finished download (full or repair) re-broadcasts music-library-changed;
    // re-read so track availability flips without leaving the page.
    const onChanged = () => load();
    window.addEventListener('music-library-changed', onChanged);
    return () => { cancelled = true; window.removeEventListener('music-library-changed', onChanged); };
  }, [albumPath, rgMbid]);

  const [tab, setTab] = usePersistedState('library:albumTab', 'Tracks');
  const active = ALBUM_TABS.includes(tab) ? tab : 'Tracks';
  // A song picked from the browser's Songs tab parks its track number for us;
  // we claim it on mount. Re-runs per album, so the highlight can't survive
  // navigating elsewhere.
  const [highlight, setHighlight] = useState(null);
  useEffect(() => { setHighlight(consumeTrackHighlight(albumPath)); }, [albumPath]);
  // Songs keyed by squashed title: the saved world-plays and video answers
  // were stored under that key, so they still show at once.
  const songs = album ? album.tracks.map(t => ({ id: squash(t.title), artist: album.artist, title: t.title })) : [];
  const owned = !!album?.path;
  const store = album && (album.path || 'rg:' + album.providerId);
  const world = useWorldPlays(album ? 'music:worldPlays:' + store : null, songs);
  // One YouTube search for the whole record (~2 s).
  const videos = useTrackVideos(album ? 'music:trackVideos:' + store : null,
    album?.artist && album.title
      ? [{ q: `${album.artist} ${album.title} official video`, artist: album.artist, songs, limit: 20 }]
      : []);
  // The sleeve's viewer: the big picture, and beside it every scanned picture.
  const lb = useLightbox();
  const art = useAlbumArtwork(lb.open ? album?.providerId : null);
  const plays = usePlayCounts();
  // Not-downloaded tracks get their links ahead (first 30), so Play is instant.
  // ponytail: no scroll watch here, an album past 30 tracks is rare.
  usePrefetchStreams(album ? albumToQueueItems(album) : []);

  // A Browse album's sleeve: the release group's front, else its release's,
  // saved to disk once (music_cover), as the old Browse preview drew it.
  // ponytail: 500px serves the backdrop too; ask a bigger size if it reads soft.
  const rgCover = useCaaCover('release-group', album && !owned ? album.providerId : null, 500);
  const relCover = useCaaCover('release', rgCover === null ? album?.releaseMbid : null, 500);
  const caa = rgCover || relCover;
  const coverImgSrc = !album ? null : owned ? coverSrc(album.image, 400, { library: true }) : (caa ? coverSrc(caa) : null);
  // The backdrop (drawn ~900px wide) and the sleeve's viewer take the file itself,
  // not the 400px thumbnail (measured 2026-09-27: a 1500px cover shown as a 400px
  // copy at 904px).
  const fullImg = !album ? null : owned ? coverSrc(album.image, 0, { library: true }) : coverImgSrc;

  if (loading) return <Centered>Loading</Centered>;
  if (error)   return <Centered tone="error">Failed to load: {error}</Centered>;
  if (!album)  return <Centered>Not found</Centered>;

  const img = coverImgSrc;
  const playable = album.tracks.filter(t => t.available);

  // Download / repair — the owned-page path into the same Rust job the Browse
  // preview uses. Visible only when the card knows its release-group id and
  // tracks are missing (metadata-only cards: all of them).
  const dlJob = dlJobId ? dlJobs.find(j => j.id === dlJobId) : null;
  const dlBusy = !!(dlJob && (dlJob.state === 'queued' || dlJob.state === 'downloading'));
  const missing = album.tracks.length - playable.length;
  const dlLabel = (() => {
    if (dlJob) {
      switch (dlJob.state) {
        case 'queued': return 'Queued';
        case 'downloading': return `Downloading ${dlJob.trackIndex || 0}/${dlJob.trackTotal || '?'}`;
        case 'done': return 'Downloaded ✓';
        case 'error': return 'Failed — Retry';
        case 'cancelled': return 'Cancelled — Retry';
        default: return 'Download';
      }
    }
    return playable.length > 0 ? `Repair · ${missing} Missing` : 'Download';
  })();
  // A Browse album downloads the full-size front, as the old preview did.
  const dlCover = !owned ? `${CAA}/release-group/${album.providerId}/front`
    : (album.image && album.image.startsWith('http')) ? album.image : null;
  const startDownload = async () => {
    if (dlBusy || !album.providerId) return;
    setDlError(null);
    try {
      const id = await enqueueDownload({
        rgMbid: album.providerId, title: album.title, artist: album.artist,
        cover: dlCover, onlyMissing: playable.length > 0,
      });
      setDlJobId(id);
    } catch (err) { setDlError(err.message || 'Failed to start download.'); }
  };
  // Add to Library: the metadata-only job the old Browse preview ran, landing
  // the card with the picked status. Its finish re-reads this page in place.
  const addBusy = !owned && dlJobs.some(j => j.rgMbid === album.providerId && j.metadataOnly
    && (j.state === 'queued' || j.state === 'downloading'));
  const addToLibrary = async (status) => {
    if (addBusy) return;
    setDlError(null);
    try {
      await enqueueDownload({
        rgMbid: album.providerId, title: album.title, artist: album.artist,
        cover: dlCover, metadataOnly: true, initialStatus: status,
      });
    } catch (err) { setDlError(err.message || 'Failed to add to library.'); }
  };

  // The fact line, in the film's order and shape. Length is SUMMED off the real
  // tracks rather than trusting the frontmatter "Length" string, which is often
  // absent; that string is only the fallback when no track carries a duration.
  const secs = album.tracks.reduce((t, x) => t + (x.duration || 0), 0);
  const lengthLabel = secs ? `${Math.round(secs / 60)}m` : (album.length || null);
  const nTracks = album.tracks.length;
  const facts = [
    album.artist ? <ArtistLink name={album.artist} accent={accent}/> : null,
    (album.genres && album.genres.length) ? album.genres.slice(0, 2).join(', ') : null,
    album.year || null,
    nTracks ? `${nTracks} track${nTracks === 1 ? '' : 's'}` : null,
    lengthLabel,
  ].filter(Boolean);
  const playFrom = (idx) => playAlbumTracks(album, idx);

  // The film's IMDb / Letterboxd / TMDb run, for a record. MusicBrainz opens
  // the release group itself when the card knows its id; Last.fm's album URL
  // is built from the names (spaces as +); Rate Your Music has no id here, so
  // it opens a release search. "RYM", not the full name: user-picked
  // 2026-09-25 because it is the label that keeps the run inside the sleeve's
  // width (measured 220.5 of 221; "Discogs" overhung it by 28).
  const plus = (s) => encodeURIComponent(s).replace(/%20/g, '+');
  const named = [album.artist, album.title].filter(Boolean).join(' ');
  const sources = [
    album.artist && album.title
      ? { label: 'Last.fm', url: `https://www.last.fm/music/${plus(album.artist)}/${plus(album.title)}` } : null,
    { label: 'RYM', url: `https://rateyourmusic.com/search?searchtype=l&searchterm=${encodeURIComponent(named)}` },
    { label: 'MBrainz', name: 'MusicBrainz', url: album.providerId
      ? `https://musicbrainz.org/release-group/${album.providerId}`
      : `https://musicbrainz.org/search?type=release_group&query=${encodeURIComponent(named)}` },
  ].filter(Boolean);

  // Each song's finished-listen count, over every key an album song's listens
  // can be logged under (MusicPlayerProvider handleEnded): its file, the album
  // page's `albumPath#n`, a playlist row's `albumPath|title` (spelled both with
  // and without the .md: the playlist row's albumPath carries it), Browse's
  // `rgMbid|disc|position`. Old playlist rows logged as `albumPath#<row>` are
  // left out: the row number is not this song's. The count part is as wide as
  // the album's biggest count (in digits), so every row's parts line up.
  // ponytail: assumes a card's n is the disc position Browse logs; if n counts
  // across discs, Browse plays of disc 2+ miss. Map by position if that shows up.
  const trackPlays = plays ? album.tracks.map(t => countPlays(plays, [
    t.audioPath,
    owned && `${album.path}#${t.n}`,
    owned && `${album.path.replace(/\.md$/, '')}|${t.title}`,
    owned && `${album.path}|${t.title}`,
    album.providerId && `${album.providerId}|${t.disc || 1}|${t.n}`,
  ])) : null;
  const playsDigits = trackPlays ? String(Math.max(0, ...trackPlays)).length : 1;
  const cells = worldCells(world, songs.map(s => s.id));
  const queueItem = (t) => ({
    albumPath: album.path, albumTitle: album.title, albumImage: album.image,
    artist: album.artist,
    n: t.n, title: t.title, audioPath: t.audioPath,
    available: t.available, streamable: !t.available,
    wikilink: t.wikilink, duration: t.duration, streamKey: t.streamKey,
  });
  const trackRef = (t) => refFromQueueItem({
    albumPath: album.path, albumTitle: album.title, albumImage: album.image,
    artist: album.artist, wikilink: t.wikilink, audioPath: t.audioPath,
    title: t.title, duration: t.duration,
  });
  const trackRow = (t, idx) => {
    // Every Browse track's albumPath is null, so a Browse album matches on
    // its stream identity instead.
    const playingThis = currentTrack && (owned
      ? currentTrack.albumPath === album.path && currentTrack.n === t.n
      : currentTrack.streamKey === t.streamKey);
    const id = songs[idx].id;
    return (
      <TrackRow
        key={t.n + ':' + t.title}
        track={t}
        plays={trackPlays?.[idx]}
        playsDigits={playsDigits}
        accent={accent}
        highlighted={!!highlight && highlight.n === t.n && (highlight.disc ?? 1) === (t.disc || 1)}
        playlistRef={trackRef(t)}
        videoUrl={videos[id]}
        world={world[id]}
        worldText={cells.text(id)}
        worldSizers={cells.sizers}
        playing={playingThis && isPlaying}
        onMenu={(e) => songMenu.openMenu(e, {
          albumPath: album.path, albumTitle: album.title, albumImage: album.image,
          artist: album.artist, n: t.n, title: t.title,
          audioPath: t.audioPath, wikilink: t.wikilink, duration: t.duration,
          available: t.available, rgMbid: album.providerId || null,
        }, t.wikilink ? [{ label: 'Open track page', onClick: () => openTrackPage(t) }] : [])}
        onPlay={() => (playingThis ? toggle() : playFrom(idx))}
        onEnqueue={() => enqueue([queueItem(t)])}
      />
    );
  };

  const setStatus = async (status) => {
    setBusy(true);
    try {
      await musicApi.markAlbumStatus(album.path, status);
      setAlbum(a => ({ ...a, status }));
      window.dispatchEvent(new CustomEvent('album-updated', { detail: { path: album.path, status } }));
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const setRating = (r) => {
    musicApi.markAlbumRating(album.path, r)
      .then(() => {
        setAlbum(a => ({ ...a, personalRating: r }));
        window.dispatchEvent(new CustomEvent('album-updated', {
          detail: { path: album.path, personalRating: r },
        }));
      })
      .catch(err => alert('Rating failed: ' + err.message));
  };

  const onDelete = async () => {
    const n = playable.length;
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      `Delete album “${album.title}”? Its card${n ? ` and ${n} audio track${n === 1 ? '' : 's'}` : ''} ` +
      `go to the recycling bin — restorable until it's purged. Playlist entries for these tracks show unavailable until you restore.`
    )) return;
    setBusy(true);
    try {
      await musicApi.deleteAlbum(album.path);
      window.dispatchEvent(new CustomEvent('music-library-changed'));
      navigate('/tools/library/music/downloaded');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <RecordPage
      accent={accent}
      backdrop={img ? fullImg : null}
      picture={img}
      onPictureClick={() => lb.show(fullImg, album.title)}
      sources={sources}
      tag={album.releaseType || 'Album'}
      title={album.title}
      facts={facts}
      error={dlError}
      actions={
        <ActionRun
          accent={accent}
          playLabel="Play Album"
          onPlay={() => playAlbumTracks(album, 0)}
          download={album.providerId && (missing > 0 || dlJob) ? {
            label: dlLabel, busy: dlBusy, onClick: startDownload,
            rest: dlJob?.state === 'downloading' ? `${dlJob.trackIndex || 0}/${dlJob.trackTotal || '?'}` : null,
          } : null}
          status={album.status}
          rating={album.personalRating}
          busy={busy}
          onStatus={setStatus}
          onRating={setRating}
          onAdd={owned ? null : addToLibrary}
          addBusy={addBusy}
          playlistRefs={() => album.tracks.map(trackRef)}
          onQueue={() => enqueue(album.tracks.map(queueItem))}
          moreItems={!owned ? [] : [
            album.trackFolder && {
              label: 'Reveal in files',
              onClick: () => musicApi.revealInFiles(libraryAbs(album.trackFolder))
                .catch(err => alert('Reveal failed: ' + err.message)),
            },
            { label: 'Delete album', onClick: onDelete },
          ].filter(Boolean)}
        />
      }
      tabs={<TabRun accent={accent} tabs={ALBUM_TABS} icons={TAB_ICON} active={active} onPick={setTab} />}
      after={<>
        <ArtworkViewer lb={lb} art={art} accent={accent || 'var(--accent)'} />
        {songMenu.modalEl}
      </>}
    >
      {active === 'Credits' && <AlbumPerformers album={album} accent={accent} />}
      {/* Mounted with the page and only hidden, so switching tabs shows the
          last answer at once instead of re-asking and re-painting the covers
          (filmed 2026-09-26: a remount flashed "Loading albums" and blank
          tiles on every visit). */}
      <div hidden={active !== 'Discography'}><ArtistAlbums album={album} accent={accent} /></div>
      {active === 'Tracks' && (() => {
        const groups = new Map();
        album.tracks.forEach((t, idx) => {
          const d = t.disc || 1;
          if (!groups.has(d)) groups.set(d, []);
          groups.get(d).push({ t, idx });
        });
        const discNumbers = [...groups.keys()].sort((a, b) => a - b);
        const multiDisc = discNumbers.length > 1;
        return discNumbers.map((d, di) => (
          // Row gap = the film Cast list's (library.css --credit-gap) plus the
          // chip lip, which paints outside layout -- same formula, same gap.
          // Off the 4px grid on purpose (6px, user-picked 2026-09-24).
          <div key={d} data-spacing-intent="credit-gap" style={{ display: 'flex', flexDirection: 'column', gap: 'calc(var(--credit-gap) + var(--candy-depth-small))' }}>
            {multiDisc && (
              <div style={{
                padding: di === 0 ? '4px 14px 6px' : '14px 14px 6px',
                fontSize: 10, fontFamily: 'var(--font-mono)',
                letterSpacing: '0.12em',                   color: 'var(--text-faint)',
                borderBottom: 'var(--candy-frame) solid var(--border)',
              }}>Disc {d}</div>
            )}
            {groups.get(d).map(({ t, idx }) => trackRow(t, idx))}
          </div>
        ));
      })()}
    </RecordPage>
  );
}

// Every scanned picture of the record (front, back, booklet pages, disc...),
// from the edition with the most of them. Asked for only while the sleeve's
// viewer is open, so a page visit costs MusicBrainz nothing. The saved answer
// shows at once; a changed one repaints live (mbTick). Keyed to the album, so
// the viewer never lists the previous album's pictures.
function useAlbumArtwork(rgMbid) {
  const [art, setArt] = useState(null);
  const mbTick = useMbRefreshTick();
  useEffect(() => {
    if (!rgMbid) return;
    let live = true;
    musicApi.releaseArtwork(rgMbid)
      .then(r => { if (live && r) setArt({ ...r, rgMbid }); })
      .catch(() => {});
    return () => { live = false; };
  }, [rgMbid, mbTick]);
  return art && art.rgMbid === rgMbid ? art : null;
}

// The sleeve's lightbox, with every picture as a column of cover tiles on its
// right (user-picked 2026-09-26, replacing the Artwork tab). Only a front, or
// no MusicBrainz link: the plain big picture, no list. The lit tile is the one
// on show; the sleeve itself counts as the Front.
function ArtworkViewer({ lb, art, accent }) {
  const pics = art?.images || [];
  const shown = pics.findIndex(p => p.full === lb.src);
  const lit = shown >= 0 ? shown : pics.findIndex(p => p.kind === 'Front');
  const aside = pics.length > 1 && (
    // The music grid tile's width; the bottom pad keeps the last tile's ledge
    // inside the scroller.
    <div style={{ width: TILE_MIN, display: 'flex', flexDirection: 'column', gap: POSTER_COL_GAP, paddingBottom: POSTER_DEPTH }}>
      {pics.map((p, i) => (
        <ArtThumb key={p.id} releaseMbid={art.releaseMbid} pic={p} accent={accent}
          active={i === lit} onPick={() => lb.show(p.full, p.kind)} />
      ))}
    </div>
  );
  return <ImageLightbox {...lb} accent={accent} aside={aside} />;
}

function ArtThumb({ releaseMbid, pic, accent, active, onPick }) {
  const path = useCaaCover('release', releaseMbid, 250, pic.id);
  return (
    <PosterTile image={path ? coverSrc(path) : null} title={pic.kind.toLowerCase()}
      accent={accent} aspect="1 / 1" onClick={onPick} active={active} />
  );
}

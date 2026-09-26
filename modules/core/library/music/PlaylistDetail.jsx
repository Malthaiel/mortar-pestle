// One playlist, wearing the film page's header (the same shell the album page
// uses): the cover full-bleed behind it, one fact line, one fused action run --
// a drag-reorderable tracklist (pointer-drag via a per-row grip handle; HTML5
// DnD doesn't fire in the Tauri WebKitGTK webview). Clicking a
// row plays from there; the per-row × removes it from the playlist (never
// touches the underlying track/.opus). Edits persist by re-emitting the whole
// page through the provider. Reloads on `music-playlists-changed` so external
// edits and our own writes stay in sync.

import { Fragment, useEffect, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import { usePlaylists, refFromPlaylistTrack, isSavedTracks } from './PlaylistProvider.jsx';
import { Seg } from '@host/components/ui/index.js';
import PlaylistModal from './PlaylistModal.jsx';
import CollageCover from './CollageCover.jsx';
import { IconPlay, IconLayers, IconBrush } from '@host/components/icons.jsx';
import { encodePath } from '../paths.js';
import { navigate } from '@host/router.js';
import { fmtDuration } from './searchShared.jsx';
import { useSongMenu } from './contextMenus.js';
import { trackToQueueItem, coverSrc } from './util.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { FILM_POSTER_W, FILM_DOT } from '../AnimeDetailHeader.jsx';
import { BODY_COLOR } from '../AnimeMainColumn.jsx';

const DL_FILTER_KEY = 'tools:savedTracksFilter';
const DL_FILTER_OPTIONS = [
  { value: 'both', label: 'Both' },
  { value: 'yes', label: 'Downloaded' },
  { value: 'no', label: 'Not downloaded' },
];

export default function PlaylistDetail({ path, accent }) {
  const [pl, setPl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);
  const [hoverIdx, setHoverIdx] = useState(null);
  // Saved Tracks mixes songs on disk with songs that only stream, so it gets the
  // same downloaded/not-downloaded split the album panel has. Rows are hidden,
  // never re-indexed — reorder/remove keep addressing the real track list.
  const [dlFilter, setDlFilter] = useState(() => {
    try { return localStorage.getItem(DL_FILTER_KEY) || 'both'; } catch { return 'both'; }
  });
  useEffect(() => {
    try { localStorage.setItem(DL_FILTER_KEY, dlFilter); } catch {}
  }, [dlFilter]);
  const reqId = useRef(0);
  const rowRefs = useRef([]);
  const dragRef = useRef({ from: null, to: null });

  const { playTracks, enqueue, currentTrack, isPlaying } = useMusicPlayer();
  const { saveTracks, rename, setCover, deletePlaylist } = usePlaylists();
  const songMenu = useSongMenu(accent);
  const { openContextMenu } = useContextMenu();

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
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const h = () => load();
    window.addEventListener('music-playlists-changed', h);
    return () => window.removeEventListener('music-playlists-changed', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  if (loading) return <Centered>Loading</Centered>;
  if (error) return <Centered tone="error">Failed to load: {error}</Centered>;
  if (!pl) return <Centered>Not found</Centered>;

  const tracks = pl.tracks || [];
  const items = tracks.map((t) => trackToQueueItem(t, pl));
  const saved = isSavedTracks(pl);
  const rowVisible = (i) =>
    !saved || dlFilter === 'both' || (dlFilter === 'yes') === !!items[i]?.available;
  const rowPlayable = (i) => !!(items[i] && (items[i].available || items[i].streamable));
  const playable = items.filter((it) => it.available || it.streamable);

  const playAll = () => {
    if (playable.length) playTracks(items, 0);
  };
  const playFrom = (i) => {
    if (rowPlayable(i)) playTracks(items, i);
  };
  const addToQueue = () => {
    if (playable.length) enqueue(playable);
  };

  // Optimistic local update + persist (reorder / remove). On failure, reload.
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
  const drop = (to) => {
    if (dragIdx == null || dragIdx === to) return;
    const next = tracks.slice();
    const [moved] = next.splice(dragIdx, 1);
    next.splice(to, 0, moved);
    persist(next);
  };

  // Pointer-drag reorder (HTML5 DnD is dead in the WebKitGTK webview). A per-row
  // grip handle starts the drag; we track the pointer against row rects to pick
  // the insertion target, then reuse drop() so the reorder is identical to the
  // old behaviour. dragIdx state stays === `from` for the whole drag, so drop()
  // reads the right source on release.
  const startReorder = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { from: i, to: i };
    setDragIdx(i);
    setOverIdx(i);
    const onMove = (ev) => {
      const y = ev.clientY;
      let target = tracks.length - 1;
      for (let k = 0; k < tracks.length; k++) {
        const r = rowRefs.current[k]?.getBoundingClientRect();
        if (!r) continue;
        if (y < r.top + r.height / 2) { target = k; break; }
      }
      if (target !== dragRef.current.to) {
        dragRef.current.to = target;
        setOverIdx(target);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      drop(dragRef.current.to);
      dragRef.current = { from: null, to: null };
      setDragIdx(null);
      setOverIdx(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

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

  const a = accent || 'var(--accent)';
  // The playlist's own chosen cover when it has one; otherwise the first sleeve
  // its collage is built from, so a collage playlist still gets a backdrop.
  // With neither there is no picture, and .film-detail's top padding is
  // reserved FOR one -- so a pictureless playlist keeps the flat header.
  const backdrop = coverSrc(pl.image || (pl.coverUrls || []).filter(Boolean)[0], 400, { library: true });
  // Summed off the real rows, never a stored total.
  const secs = tracks.reduce((t, x) => t + (x.duration || 0), 0);
  const facts = [
    `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
    secs ? `${Math.round(secs / 60)}m` : null,
  ].filter(Boolean);
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {/* Header: the film page's shell (library.css .film-detail /
          .film-backdrop), used verbatim as the album page uses it. */}
      <div className={backdrop ? 'film-detail' : undefined}
           style={backdrop ? undefined : {
             display: 'flex', gap: 24, padding: '28px 26px 22px',
             borderBottom: 'var(--candy-frame) solid var(--border)', alignItems: 'flex-end',
           }}>
        {backdrop && (
          <div className="film-backdrop is-square" aria-hidden>
            <img src={backdrop} alt=""/>
          </div>
        )}
        {/* One wrapper for both columns: .film-detail centres its children at
            the reading measure, so the flex row has to BE a single child. */}
        <div style={{ display: 'flex', gap: 28 }}>
        <div style={{ width: FILM_POSTER_W, flexShrink: 0 }}>
          <div style={{ width: '100%', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', boxShadow: '0 10px 32px rgba(0,0,0,0.34)', background: 'var(--surface-2)' }}>
            <CollageCover image={pl.image} urls={pl.coverUrls} title={pl.title} accent={accent} />
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: BODY_COLOR, letterSpacing: '0.08em'}}>Playlist</div>

          <h2 style={{
            margin: 0, fontSize: 'calc(28px * var(--film-head))', fontWeight: 700,
            color: 'var(--text)', lineHeight: 1.12, letterSpacing: '-0.015em',
          }}>{pl.title}</h2>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            fontSize: 'calc(12px * var(--film-head))', color: BODY_COLOR,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {facts.map((f, i) => <Fragment key={i}>{i > 0 && FILM_DOT}{f}</Fragment>)}
          </div>

          {/* One fused run, as on the album and film pages. Delete lives in the
              "more" menu and Saved Tracks cannot be deleted at all. */}
          <div className="candy-split" style={{
            position: 'relative', '--cbtn-size': '26px',
            marginTop: 4, alignSelf: 'flex-start',
            ...(accent ? { '--accent': accent } : {}),
          }}>
            <button
              className="candy-btn"
              data-shape="chip"
              data-own-press
              onClick={playAll}
              disabled={playable.length === 0}
            ><span className="candy-face"><IconPlay size={14}/>Play</span></button>
            <button
              className="candy-btn"
              data-shape="chip"
              data-own-press
              onClick={addToQueue}
              disabled={playable.length === 0}
            ><span className="candy-face"><IconLayers size={14}/>Queue</span></button>
            <button
              className="candy-btn"
              data-shape="chip"
              data-own-press
              onClick={() => setEditOpen(true)}
            ><span className="candy-face"><IconBrush size={14}/>Edit</span></button>
            {!saved && (
              <button
                type="button"
                className="candy-btn"
                data-shape="chip"
                data-own-press
                title="More"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  openContextMenu({ x: r.left, y: r.bottom + 4 },
                    [{ label: 'Delete playlist', onClick: onDelete }], { accent });
                }}
              ><span className="candy-face">⋯</span></button>
            )}
          </div>
        </div>
        </div>
      </div>

      {saved && tracks.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 0' }}>
          <Seg options={DL_FILTER_OPTIONS} value={dlFilter} onChange={setDlFilter} accent={accent} />
        </div>
      )}

      {/* Tracklist */}
      <div style={{ padding: '12px 14px 32px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {tracks.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 13, textAlign: 'center', padding: '36px 24px' }}>
            Empty playlist. Add tracks with <b>+ Playlist</b> from the Downloaded tab.
          </div>
        )}
        {tracks.length > 0 && !tracks.some((_, i) => rowVisible(i)) && (
          <div style={{ color: 'var(--text-faint)', fontSize: 13, textAlign: 'center', padding: '36px 24px' }}>
            No tracks match this filter.
          </div>
        )}
        {tracks.map((t, i) => {
          if (!rowVisible(i)) return null;
          // Stream tracks have no audioPath (null === null would light every
          // stream row) — fall back to album+track identity.
          const playingThis = !!currentTrack && (currentTrack.audioPath
            ? currentTrack.audioPath === t.audioPath
            : currentTrack.albumPath === (t.albumPath || pl.path) && currentTrack.n === t.n);
          const dragging = dragIdx === i;
          const dropOver = overIdx === i && dragIdx !== null && dragIdx !== i;
          const hovering = hoverIdx === i;
          return (
            <div
              key={i + ':' + (t.audioPath || t.title)}
              ref={(el) => { rowRefs.current[i] = el; }}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx((o) => (o === i ? null : o))}
              onClick={() => rowPlayable(i) && playFrom(i)}
              onContextMenu={(e) => rowMenu(e, i)}
              title={rowPlayable(i) ? '' : 'audio not downloaded'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 12px',
                borderRadius: 6,
                cursor: rowPlayable(i) ? 'pointer' : 'not-allowed',
                background: playingThis
                  ? `color-mix(in oklch, ${a} 12%, transparent)`
                  : dropOver || hovering
                    ? 'var(--surface-2)'
                    : 'transparent',
                borderTop: dropOver && dragIdx > i ? `2px solid ${a}` : '2px solid transparent',
                borderBottom: dropOver && dragIdx < i ? `2px solid ${a}` : '2px solid transparent',
                opacity: dragging ? 0.4 : rowPlayable(i) ? 1 : 0.5,
                transition: 'background 120ms ease',
              }}
            >
              <span
                onPointerDown={(e) => startReorder(e, i)}
                onClick={(e) => e.stopPropagation()}
                title="Drag to reorder"
                style={{ flexShrink: 0, width: 14, textAlign: 'center', cursor: 'grab', touchAction: 'none', color: 'var(--text-faint)', fontSize: 13, lineHeight: 1, opacity: hovering ? 0.7 : 0, transition: 'opacity 120ms ease' }}
              >
                ⠿
              </span>
              <span style={{ width: 22, textAlign: 'center', flexShrink: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: playingThis ? a : 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
                {playingThis && isPlaying ? '▸' : i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: playingThis ? a : 'var(--text)', fontWeight: playingThis ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[t.artist, t.albumTitle].filter(Boolean).join(' · ')}
                </div>
              </div>
              <span style={{ flexShrink: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{fmtDuration(t.duration)}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeAt(i);
                }}
                title="Remove from playlist"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-faint)',
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 4,
                  borderRadius: 4,
                  flexShrink: 0,
                  opacity: hovering ? 1 : 0,
                  pointerEvents: hovering ? 'auto' : 'none',
                  transition: 'opacity 120ms ease',
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

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
    </div>
  );
}

function Centered({ children, tone }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: tone === 'error' ? 'var(--text)' : 'var(--text-faint)',
        fontSize: 13,
        padding: 40,
      }}
    >
      {children}
    </div>
  );
}

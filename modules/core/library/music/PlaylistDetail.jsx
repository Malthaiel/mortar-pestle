// One playlist: cover + title + actions (Play all / + Queue / Edit / Delete) and
// a drag-reorderable tracklist (pointer-drag via a per-row grip handle; HTML5
// DnD doesn't fire in the Tauri WebKitGTK webview). Clicking a
// row plays from there; the per-row × removes it from the playlist (never
// touches the underlying track/.opus). Edits persist by re-emitting the whole
// page through the provider. Reloads on `music-playlists-changed` so external
// edits and our own writes stay in sync.

import { useEffect, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { useMusicPlayer } from './MusicPlayerProvider.jsx';
import { usePlaylists, refFromPlaylistTrack } from './PlaylistProvider.jsx';
import PlaylistModal from './PlaylistModal.jsx';
import CollageCover from './CollageCover.jsx';

function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}
function navigate(p) {
  window.location.hash = p;
}
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// PlaylistTrack → player queue item. Each track keeps its own album cover/artist
// (playlists span albums), which is why playback uses playTracks, not
// playAlbumTracks.
function trackToQueueItem(t, pl) {
  return {
    albumPath: t.albumPath || pl.path,
    albumTitle: t.albumTitle || pl.title,
    albumImage: t.albumImage || pl.image || null,
    artist: t.artist || '',
    n: t.n,
    title: t.title,
    audioPath: t.audioPath,
    available: t.available,
    wikilink: t.wikilink || null,
    duration: t.duration ?? null,
  };
}

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
  const reqId = useRef(0);
  const rowRefs = useRef([]);
  const dragRef = useRef({ from: null, to: null });

  const { playTracks, enqueue, currentTrack, isPlaying } = useMusicPlayer();
  const { saveTracks, rename, setCover, deletePlaylist } = usePlaylists();

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

  if (loading) return <Centered>Loading…</Centered>;
  if (error) return <Centered tone="error">Failed to load: {error}</Centered>;
  if (!pl) return <Centered>Not found</Centered>;

  const tracks = pl.tracks || [];
  const playable = tracks.filter((t) => t.available);
  const items = tracks.map((t) => trackToQueueItem(t, pl));

  const playAll = () => {
    if (playable.length) playTracks(items, 0);
  };
  const playFrom = (i) => {
    if (tracks[i]?.available) playTracks(items, i);
  };
  const addToQueue = () => {
    const av = items.filter((it) => it.available);
    if (av.length) enqueue(av);
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

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          gap: 24,
          padding: '28px 26px 22px',
          borderBottom: '1px solid var(--border)',
          alignItems: 'flex-end',
        }}
      >
        <div style={{ width: 168, height: 168, flexShrink: 0, borderRadius: 8, overflow: 'hidden', boxShadow: '0 10px 32px rgba(0,0,0,0.34)', background: 'var(--surface-2)' }}>
          <CollageCover image={pl.image} urls={pl.coverUrls} title={pl.title} accent={accent} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Playlist</div>
          <h2 style={{ margin: 0, fontSize: 28, fontWeight: 700, color: 'var(--text)', lineHeight: 1.12, letterSpacing: '-0.015em' }}>{pl.title}</h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {tracks.length} track{tracks.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="candy-btn is-primary"
              data-own-press
              onClick={playAll}
              disabled={playable.length === 0}
              style={{ height: 36, ...(accent ? { '--accent': accent } : {}), ...(playable.length === 0 ? { opacity: 0.4, pointerEvents: 'none' } : {}) }}
            >
              <span className="candy-face" style={{ padding: '0 18px' }}>Play All</span>
            </button>
            <button
              className="candy-btn"
              data-own-press
              onClick={addToQueue}
              disabled={playable.length === 0}
              style={{ height: 36, ...(playable.length === 0 ? { opacity: 0.4, pointerEvents: 'none' } : {}) }}
            >
              <span className="candy-face" style={{ padding: '0 18px' }}>+ Queue</span>
            </button>
            <button className="candy-btn" data-own-press onClick={() => setEditOpen(true)} style={{ height: 36 }}>
              <span className="candy-face" style={{ padding: '0 16px' }}>Edit</span>
            </button>
            <button className="candy-btn is-danger" data-own-press onClick={onDelete} style={{ height: 36 }}>
              <span className="candy-face" style={{ padding: '0 16px' }}>Delete</span>
            </button>
          </div>
        </div>
      </div>

      {/* Tracklist */}
      <div style={{ padding: '12px 14px 32px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {tracks.length === 0 && (
          <div style={{ color: 'var(--text-faint)', fontSize: 13, textAlign: 'center', padding: '36px 24px' }}>
            Empty playlist. Add tracks with <b>+ Playlist</b> from the Downloaded tab.
          </div>
        )}
        {tracks.map((t, i) => {
          const playingThis = !!currentTrack && currentTrack.audioPath === t.audioPath;
          const dragging = dragIdx === i;
          const dropOver = overIdx === i && dragIdx !== null && dragIdx !== i;
          const hovering = hoverIdx === i;
          return (
            <div
              key={i + ':' + (t.audioPath || t.title)}
              ref={(el) => { rowRefs.current[i] = el; }}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx((o) => (o === i ? null : o))}
              onClick={() => t.available && playFrom(i)}
              title={t.available ? '' : 'audio not downloaded'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 12px',
                borderRadius: 6,
                cursor: t.available ? 'pointer' : 'not-allowed',
                background: playingThis
                  ? `color-mix(in oklch, ${a} 12%, transparent)`
                  : dropOver || hovering
                    ? 'var(--surface-2)'
                    : 'transparent',
                borderTop: dropOver && dragIdx > i ? `2px solid ${a}` : '2px solid transparent',
                borderBottom: dropOver && dragIdx < i ? `2px solid ${a}` : '2px solid transparent',
                opacity: dragging ? 0.4 : t.available ? 1 : 0.5,
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
              <span style={{ flexShrink: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{fmtDur(t.duration)}</span>
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
        color: tone === 'error' ? '#e07b7b' : 'var(--text-faint)',
        fontSize: 13,
        padding: 40,
      }}
    >
      {children}
    </div>
  );
}

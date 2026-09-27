// Stream links for not-downloaded tracks, fetched AHEAD of the click and reused
// until they expire, so pressing play finds one waiting instead of showing
// "Finding track" (user-directed 2026-09-26; a resolve measured 2.3-4.6 s).
//
// A googlevideo link names its own death in its `expire` query param (measured
// 360 min out) and is bound to this machine's IP, so it's safe to hold in
// memory for the session, never on disk. The player drops an entry whose link
// fails to load and re-resolves once (MusicPlayerProvider onError).

import { useEffect, useRef } from 'react';
import { invoke } from '@host/api.js';

// Loose YouTube hits carry no album card, so albumPath|n would be "null|null"
// for every one of them — key those by their watch URL instead.
// A Browse-preview track has no album card either, so albumPath|n would be
// "null|3" for every one of them too — those carry their own streamKey.
export const streamKeyOf = (t) => (t ? (t.watchUrl || t.streamKey || `${t.albumPath}|${t.n}`) : '');

// Which shape `music_stream_resolve` gets: an exact YouTube upload, a library
// album card (cached watch URL + writeback), or metadata. A streamKey means n is
// not the album's track number (Browse preview, playlist rows); a playlist row
// still names its album card, and Rust finds the track there by title, so it
// gets the card's remembered video too. No card (Browse) = a search.
export const streamResolveArgs = (t) =>
  t.watchUrl ? { watchUrl: t.watchUrl }
    : t.albumPath && !t.streamKey ? { albumPath: t.albumPath, n: t.n }
      : { albumPath: t.albumPath || null, artist: t.artist, albumTitle: t.albumTitle,
          trackTitle: t.title, durationSec: t.duration || 0 };

// ponytail: a fixed margin so a song started near expiry still finishes; read
// the track's duration instead if 30 min ever proves too short or too long.
const MARGIN_S = 30 * 60;
const entries = new Map(); // key -> { p: Promise<{streamUrl, watchUrl}>, expire: unix s, 0 while pending }
const fresh = (e) => !!e && (e.expire === 0 || e.expire - MARGIN_S > Date.now() / 1000);

export function resolveStream(t) {
  const key = streamKeyOf(t);
  const hit = entries.get(key);
  if (fresh(hit)) return hit.p;
  const e = { expire: 0 };
  e.p = invoke('music_stream_resolve', streamResolveArgs(t)).then(res => {
    const m = /[?&]expire=(\d+)/.exec(res.streamUrl || '');
    e.expire = m ? +m[1] : 1; // no expire param: use once, never reuse
    return res;
  }, err => {
    if (entries.get(key) === e) entries.delete(key);
    throw err;
  });
  entries.set(key, e);
  return e.p;
}

// A resolved, unexpired link is waiting (not merely in flight).
export const hasStream = (t) => { const e = entries.get(streamKeyOf(t)); return !!e && e.expire > 0 && fresh(e); };
export const dropStream = (t) => entries.delete(streamKeyOf(t));

// Background queue: newest request first (the page just opened beats the one
// left behind), 3 resolves at a time so YouTube never sees a burst.
const MAX_RUNNING = 3;
const pending = [];
let running = 0;
export function prefetchStreams(tracks) {
  const want = tracks.filter(t => t && t.streamable && !t.available && !fresh(entries.get(streamKeyOf(t))));
  for (const t of want.reverse()) {
    const k = streamKeyOf(t);
    const i = pending.findIndex(x => streamKeyOf(x) === k);
    if (i >= 0) pending.splice(i, 1);
    pending.unshift(t);
  }
  pump();
}
function pump() {
  while (running < MAX_RUNNING && pending.length) {
    const t = pending.shift();
    if (fresh(entries.get(streamKeyOf(t)))) continue;
    running++;
    resolveStream(t).catch(() => {}).finally(() => { running--; pump(); });
  }
}

// A page's rows: the first 30 at once, then (given the page's row elements,
// indexed like items) each later row as it scrolls into view.
// ponytail: rows a filter reveals later aren't observed until the list changes.
const FIRST = 30;
export function usePrefetchStreams(items, rowsRef) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const sig = items.map(streamKeyOf).join('\n');
  useEffect(() => {
    const list = itemsRef.current;
    prefetchStreams(list.slice(0, FIRST));
    const rows = rowsRef?.current;
    if (!rows || list.length <= FIRST) return;
    const io = new IntersectionObserver(es => {
      const seen = es.filter(e => e.isIntersecting).map(e => itemsRef.current[rows.indexOf(e.target)]);
      if (seen.length) prefetchStreams(seen);
    });
    rows.forEach((el, i) => { if (el && i >= FIRST) io.observe(el); });
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}

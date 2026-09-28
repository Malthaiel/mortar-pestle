// The record page's hooks and helpers, shared by the album and playlist pages
// (RecordPage.jsx is their components). Kept apart from the components because
// a module exporting both a hook and a component does not hot-update.

import { useEffect, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { squash } from './util.js';

// Which tab a gliding pointer opens (now at `x`, last at `px`), starting from the one
// open now (`cur`): the open tab hands over when the pointer crosses the line half an
// icon inside its edge, the same lead at every edge whatever the tab's width
// (user-directed 2026-09-27), or when it is past the edge. Crossed, not inside: a
// pointer that lands in that band has not glided there, and keeps the tab it landed
// on. Rejected the same day: a swap at the midpoint of the two open centres
// ("switches too early"), then a lead only where a slide forced one (small tabs
// waited for the edge). It holds while every name adds more than two leads (else the
// walk would step back); the walk goes one way, so it always ends. Layouts are
// rebuilt from the live parts (shut width = width minus what its name adds right
// now), because live rects lie mid-glide.
function tabUnder(run, x, px, cur) {
  const parts = [...run.children], shut = [], name = [], lap = [];
  for (const p of parts) {
    // A part may carry a short form (.is-rest) that shows while it is shut and
    // swaps for the name as it opens: shut = name closed + short form showing,
    // and opening adds the name's width minus the short form's.
    const lbl = p.querySelector('.split-label:not(.is-rest)'), rest = p.querySelector('.split-label.is-rest');
    const gap = parseFloat(getComputedStyle(lbl.parentElement).columnGap) || 0;
    const adds = (el) => el ? el.getBoundingClientRect().width + parseFloat(getComputedStyle(el).marginLeft) + gap : 0;   // now
    const full = (el) => el ? el.firstElementChild.getBoundingClientRect().width + gap : 0;                               // fully open
    shut.push(p.getBoundingClientRect().width - adds(lbl) - adds(rest) + full(rest));
    name.push(full(lbl) - full(rest));
    lap.push(parseFloat(getComputedStyle(p).marginLeft) || 0);
  }
  const l0 = parts[0].getBoundingClientRect().left - lap[0];
  // Part j's [left, right] in the layout where part k is open.
  const at = (k, j) => {
    let l = l0;
    for (let i = 0; i < j; i++) l += lap[i] + shut[i] + (i === k ? name[i] : 0);
    l += lap[j];
    return [l, l + shut[j] + (j === k ? name[j] : 0)];
  };
  const lead = shut[0] / 2;
  let k = cur;
  while (k + 1 < parts.length && (x >= at(k, k)[1] || (px < at(k, k)[1] - lead && x >= at(k, k)[1] - lead))) k++;
  if (k === cur) while (k > 0 && (x < at(k, k)[0] || (px >= at(k, k)[0] + lead && x < at(k, k)[0] + lead))) k--;
  return k;
}

// The index of the part showing its name in a run whose every part carries a
// .split-label: the hovered one by tabUnder, not by hit-test, else `pick` (the
// picked tab; Play for the action run). The updater form, so a swap not yet
// rendered is still `cur`. A pointer arriving (no hover yet) opens the part under it.
export function useOpenPart(pick) {
  const [hover, setHover] = useState(null);
  const lastX = useRef(null);   // the pointer's last x on the run; null = not on it
  return [hover ?? pick, {
    onPointerMove: (e) => {
      const run = e.currentTarget, x = e.clientX, px = lastX.current;
      const under = [...run.children].indexOf(e.target.closest('.candy-btn'));
      lastX.current = x;
      setHover(h => h != null ? tabUnder(run, x, px ?? x, h) : under >= 0 ? under : pick);
    },
    onPointerLeave: () => { setHover(null); lastX.current = null; },
  }];
}

// Every finished listen, counted per logged key. Read once per page, and again
// each time a song finishes (music-listen-recorded).
export function usePlayCounts() {
  const [counts, setCounts] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => musicApi.listenCounts()
      .then(c => { if (live) setCounts(c || {}); })
      .catch(() => { if (live) setCounts(c => c || {}); });
    load();
    window.addEventListener('music-listen-recorded', load);
    return () => { live = false; window.removeEventListener('music-listen-recorded', load); };
  }, []);
  return counts;
}

// One song's listens: the sum over every key it can be logged under
// (MusicPlayerProvider handleEnded -- audioPath / watchUrl / streamKey /
// albumPath#n). Each page knows its own keys; a repeated key counts once.
export function countPlays(counts, keys) {
  let n = 0;
  for (const k of new Set(keys)) if (k) n += counts[k] || 0;
  return n;
}

// 12.4M, 34K, 812 (user-picked 2026-09-26); the exact number is the hover.
export const compactPlays = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

// Each row's world-plays text, and every distinct one as hidden sizers: each
// row's slot holds them all in one grid cell, so every slot is as wide as the
// widest and the parts line up (12.4M and 812 are not the same width in any font).
export function worldCells(world, ids) {
  const text = (id) => (world[id] ? compactPlays.format(world[id].playcount) : '–');
  return { text, sizers: [...new Set(ids.map(text))] };
}

// Each song's worldwide play count on Last.fm (the user's own key, Settings >
// Library > Music), kept the video part's way: the last answer per page sits in
// localStorage under `storeKey` so the numbers show at once, then every song is
// asked again, one at a time, and repaints as its answer lands. `songs` is
// [{ id, artist, title }]; returns { id: { playcount, url } }. A song Last.fm
// doesn't know, or no key, stays absent (a grey dash).
// ponytail: re-asks every song when the list changes (a removed row); skip
// already-answered ids if a long playlist makes that felt.
export function useWorldPlays(storeKey, songs) {
  const [world, setWorld] = useState({});
  const ids = songs.map(s => s.id).join('\n');
  useEffect(() => {
    let next = {};
    if (storeKey) try { next = JSON.parse(localStorage.getItem(storeKey)) || {}; } catch {}
    setWorld(next);
    if (!storeKey || !songs.length) return;
    let live = true;
    (async () => {
      if (!(await musicApi.lastfmHasApiKey().catch(() => false))) return;
      for (const s of songs) {
        if (!s.artist) continue;
        const r = await musicApi.lastfmTrackPlays(s.artist, s.title).catch(() => undefined);
        if (!live) return;
        if (r === undefined) continue; // no answer this time: keep the saved number
        next = { ...next };
        if (r) next[s.id] = r; else delete next[s.id];
        setWorld(next);
        try { localStorage.setItem(storeKey, JSON.stringify(next)); } catch {}
        // ponytail: a fixed gap keeps one page under Last.fm's ~5 calls/s; move
        // it to a shared gate in lastfm.rs if two pages ever ask at once.
        await new Promise(res => setTimeout(res, 200));
      }
    })();
    return () => { live = false; };
  }, [storeKey, ids]); // eslint-disable-line react-hooks/exhaustive-deps
  return world;
}

// A search turns up fan uploads and other songs. Keep a hit only when the
// artist's own channel posted it (not the "- Topic" channel, which is sound over
// the cover) and its title names one of `songs`. Longest song name wins, so a
// "Karma Police" video is never handed to a song called "Police"; first video
// per song. Returns { song id: watchUrl }.
function trackVideos(hits, artist, songs) {
  const a = squash(artist);
  const names = songs.map(s => ({ id: s.id, n: squash(s.title) }))
    .filter(s => s.n.length >= 3 && s.n !== a)
    .sort((x, y) => y.n.length - x.n.length);
  const out = {};
  if (!a) return out;
  for (const h of hits || []) {
    const up = String(h.uploader || '');
    if (/ - topic$/i.test(up) || !squash(up).includes(a)) continue;
    const hit = names.find(s => squash(h.title).includes(s.n));
    if (hit && !out[hit.id]) out[hit.id] = h.watchUrl;
  }
  return out;
}

// Which songs have a music video. `searches` is [{ q, artist, songs, limit }]:
// the album runs ONE (~2 s), a playlist one per song (its artists differ), one
// after another, repainting as each lands. The last answer is kept in
// localStorage under `storeKey`, so the buttons show at once.
// ponytail: the album's one search can miss some songs' videos; search per
// track there too if that turns out to matter.
export function useTrackVideos(storeKey, searches) {
  const [videos, setVideos] = useState({});
  const sig = searches.map(s => s.q).join('\n');
  useEffect(() => {
    if (!storeKey || !searches.length) { setVideos({}); return; }
    let saved = {}, found = {};
    try { saved = JSON.parse(localStorage.getItem(storeKey)) || {}; } catch {}
    setVideos(saved);
    let live = true;
    (async () => {
      for (const s of searches) {
        const r = await musicApi.searchYoutube(s.q, s.limit).catch(() => null);
        if (!live) return;
        // No answer this time: keep what was saved for these songs.
        if (!r) { for (const x of s.songs) if (saved[x.id]) found = { ...found, [x.id]: saved[x.id] }; continue; }
        found = { ...found, ...trackVideos(r, s.artist, s.songs) };
        if (searches.length > 1) setVideos(v => ({ ...v, ...found }));
      }
      try { localStorage.setItem(storeKey, JSON.stringify(found)); } catch {}
      setVideos(found);
    })();
    return () => { live = false; };
  }, [storeKey, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return videos;
}

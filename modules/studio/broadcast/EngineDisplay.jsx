// EngineDisplay (SP2 SF3) — the native preview region owner.
//
// Renders one div sized to the canvas aspect by pure CSS (aspect-ratio +
// max-width/height + margin auto — the page background IS the letterbox; the
// engine never draws bars), and drives an app-owned child HWND + engine
// obs_display to exactly that rect (BrowserPage.jsx bounds-sync idiom,
// rAF-throttled).
//
// Lifecycle — ONE visibility rule: DESTROY.
//   alive edge (mount with engine up, or engine respawn) → display_create
//   (engine-side upsert) → syncBounds. Cleanup (unmount OR alive→false) →
//   display_destroy (engine part best-effort — it may be dead; the child HWND
//   is hidden + cached app-side). A respawned engine has zero displays; the
//   same alive-edge effect re-creates — that IS the respawn story.
//
// Known limits (documented, deliberate):
// - Z-order: the native region floats above ALL DOM — the settings drawer,
//   popovers, and toasts overlapping the preview rect are occluded. Identical
//   to the in-app browser's content view; no SP2 mitigation.
// - Reload ritual: HMR/F5 never reaches native regions, and F5 kills JS
//   without running this cleanup — the module's register() issues a one-shot
//   display_destroy heal, so after F5 the ghost region clears at registration
//   and the preview returns on the next page mount.
// - StrictMode: the dev double-mount serializes create→destroy→create through
//   the await chain + engine-side upsert; it settles correct.
//
// Aspect hardcoded 16:9 v1: the engine's base canvas is fixed 1920×1080 until
// profiles land (SP10) — snapshot plumbing for one possible value is skipped.

import React, { useCallback, useEffect, useRef } from 'react';

// Per-id strict op ordering. Tauri command tasks run concurrently and do NOT
// preserve invoke-call order, so StrictMode's create→destroy→create burst can
// interleave at the display_host / engine layer (a late destroy killing the
// live display). Every lifecycle invoke for an id rides one promise chain —
// dispatch order = call order, always.
const opChains = new Map();
function chained(id, op) {
  const prev = opChains.get(id) || Promise.resolve();
  const next = prev.then(op, op);
  opChains.set(id, next);
  return next;
}

export default function EngineDisplay({ api, alive, id = 'preview', children }) {
  const holderRef = useRef(null);
  const createdRef = useRef(false);
  const rafRef = useRef(0);

  // rAF-throttled bounds push: collapse resize bursts to one call per frame.
  const syncBounds = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = holderRef.current;
      if (!el || !createdRef.current) return;
      const r = el.getBoundingClientRect();
      chained(id, () => api.invoke('broadcast_display_bounds', {
        id,
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      })).catch((err) => console.warn('[broadcast] display_bounds failed:', err));
    });
  }, [api, id]);

  // Create/destroy on the alive edge (see header).
  //
  // A cancelled in-flight create must NOT self-destroy: displays are id-keyed
  // upserts, so under StrictMode's double-mount the first create's late
  // "cancelled" destroy would land AFTER the second create and kill the LIVE
  // display (observed 2026-07-03: frozen preview + "no display 'preview'" on
  // every bounds sync). The cleanup's destroy plus engine-side upsert already
  // cover every leak case; a raced create just gets replaced. All lifecycle
  // invokes ride the per-id chain so ordering is guaranteed.
  useEffect(() => {
    if (!alive) return undefined;
    let cancelled = false;
    (async () => {
      const el = holderRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      try {
        await chained(id, () => api.invoke('broadcast_display_create', {
          id,
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        }));
        if (cancelled) return;
        createdRef.current = true;
        syncBounds();
      } catch (err) {
        // Engine raced down between the alive edge and the create; the next
        // alive edge retries. Loud in the console — silent swallows made the
        // 2026-07-03 desync undiagnosable.
        console.warn('[broadcast] display_create failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      createdRef.current = false;
      chained(id, () => api.invoke('broadcast_display_destroy', { id }))
        .catch((err) => console.warn('[broadcast] display_destroy failed:', err));
    };
  }, [alive, api, id, syncBounds]);

  // Alignment listeners: window resize + ResizeObserver(holder) + one settle
  // rAF after mount (BrowserPage idiom — covers sidebar collapse, dock
  // show/hide, DPI-change-driven window resizes).
  useEffect(() => {
    if (!alive) return undefined;
    const onResize = () => syncBounds();
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(syncBounds);
    if (holderRef.current) ro.observe(holderRef.current);
    const raf = requestAnimationFrame(syncBounds);
    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      cancelAnimationFrame(raf);
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    };
  }, [alive, syncBounds]);

  // SP3: children = the PreviewInteract event layer. It draws nothing (the
  // native region occludes all DOM); it exists to catch the pointer events
  // that fall through the HTTRANSPARENT child window. position:relative so
  // the layer's inset:0 tracks the region exactly.
  return <div ref={holderRef} className="bcast-preview-region" style={{ position: 'relative' }}>{children}</div>;
}

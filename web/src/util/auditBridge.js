// DEV-only audit→disk bridge (Spacing Correctness System, Move 8).
//
// Every audit run POSTs its payload to the Vite dev-server /__audit sink
// (see web/vite.config.js), which merges it into web/.audit/<label>.json — the
// file Claude READS instead of the user hand-pasting console output. This kills
// the paste ritual that drove the multi-chat spacing saga. Best-effort: swallows
// every error (the endpoint 404s in prod, is absent offline, etc.).
//
// NONCE is set ONCE per page load and SHARED across spacingAudit + candyCenterAudit
// (both import THIS module, so they see the same module-singleton value). That
// sharing is load-bearing, not just DRY: quiet re-audits fire on any DOM churn
// (the scrim clock re-renders every second → a POST ~every 1.4s), so `ts` is
// ALWAYS fresh even when the webview is running STALE pre-edit code. Only a NONCE
// CHANGE proves a reload actually happened — that is the freshness signal Claude
// must check for overlay work (a fresh `ts` alone is vacuous). If the two audits
// carried different nonces, "the page nonce" would be ambiguous and the check
// would break.

import { getCurrentWindow } from '@tauri-apps/api/window';
const NONCE = (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'n' + (typeof performance !== 'undefined' ? performance.now() : 0);

// Per-label files: a single shared file gets clobbered when several webviews
// write (verified failure mode).
//
// The label is the TAURI WINDOW LABEL, not the route. It used to be derived from
// location.hash, and that identity is not stable: a cmd-bridge probe runs in EVERY
// webview, so one session's `location.hash = '#/planner'` rewrote the Player
// Controls window's hash too and it reported as 'main' from then on — silently
// clobbering the real main window's readings with measurements of a 280x158
// window (2026-08-29, cost a dozen probes). The window label cannot be rewritten
// by a route change. Hash stays as the fallback for a plain browser dev session,
// where there is no Tauri window at all.
function auditLabel() {
  try {
    const l = getCurrentWindow()?.label;
    if (l) return l;
  } catch { /* not in Tauri — fall through to the route heuristic */ }
  const h = typeof location !== 'undefined' ? location.hash : '';
  if (h.startsWith('#/player/controls')) return 'player-controls';
  return h.includes('overlay') ? 'overlay-host' : 'main';
}

// WHAT WAS ACTUALLY ON SCREEN (Planner Button Sizing, 2026-08-10). `route` only
// names the page behind the overlays, so a reading taken while the surface under
// edit was SHUT looks exactly like a clean bill of health for it — that is how the
// Planner sizing chat read `route: music/playlists` for an hour and never noticed
// the modal it was editing had never once been measured. Listing the mounted
// modals/popovers makes an off-target reading self-evidently void instead of
// quietly wrong. Classes, not a boolean: the class IS the greppable locator.
function openSurfaces() {
  if (typeof document === 'undefined') return [];
  const sel = '.candy-modal, [role="dialog"], .popover-panel, .ov-panel';
  // height > 0 is NOT enough: closed modals stay mounted at full size behind
  // opacity:0 or visibility:hidden (measured — three of them on a bare page), so
  // a height-only filter reports every dialog in the app as open and the stamp
  // becomes a liar. checkVisibility() is the platform's own answer and folds in
  // display, visibility, opacity and content-visibility in one call.
  return [...document.querySelectorAll(sel)]
    .filter((el) => el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? el.getBoundingClientRect().height > 0)
    .map((el) => (typeof el.className === 'string' && el.className.trim()) || el.tagName.toLowerCase())
    .slice(0, 12);
}

// kind: 'spacing' | 'center' — the sink merges each kind into its own slice of the
// per-label file, so the two audits don't clobber each other within one window.
export function postAudit(kind, data) {
  if (!import.meta.env.DEV || typeof fetch === 'undefined') return;
  try {
    fetch('/__audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind,
        nonce: NONCE,
        ts: Date.now(),
        label: auditLabel(),
        route: typeof location !== 'undefined' ? location.hash : '',
        open: openSurfaces(),
        data,
      }),
    }).catch(() => {});
  } catch { /* best-effort — never let the bridge break an audit run */ }
}

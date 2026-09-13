import { useEffect, useRef, useState, useCallback } from 'react';
import { subscribeBrowserOverlayAttached } from '@host/api.js';
import { useTabStore } from './useTabStore.js';
import * as store from './tabStore.js';
import NewTabPage from './NewTabPage.jsx';
import { useKeybindAction } from '@host/keybinds/useKeybind.js';
import { useModuleSettings, useSettings } from '@host/hooks/useSettings.js';
import { isHostAllowed, replayBlockerToBackend } from './blocker.js';
import VaultKeyButton from './VaultKeyButton.jsx';
import SitePopover from './SitePopover.jsx';
import { useVaultLock } from './useVaultLock.js';
import { useCredsStore } from './useCredsStore.js';
import VaultRoute from './VaultRoute.jsx';
import HistoryRoute from './HistoryRoute.jsx';
import { IconClock, IconShield, IconShieldOff } from '@host/components/icons.jsx';
import { candyCenterOffset } from '@host/util/candy.js';
import { POPOVER_HEIGHT } from './BrowserPopover.jsx';
import HistoryPopover from './HistoryPopover.jsx';
import ShieldPopover from './ShieldPopover.jsx';
import LoadingScreen from './LoadingScreen.jsx';

// Multi-tab in-app browser chrome. Each tab is a long-lived native WebKit view
// living in Rust (one per tab); this component owns the URL bar + the content
// region (`holderRef`) and keeps the ACTIVE native view aligned to it via
// `browser_set_bounds`. A tab whose url is null shows the React New-Tab Page
// instead (native view hidden). The sidebar tab list/rail (TabSidebar/TabRail)
// read the same store. See Mortar & Pestle/Plans/Browser Multi-Tab.md.

// Rust holds one native WebView per tab, and they persist across this
// component's mount/unmount (route changes). `_rustSeeded` recreates the
// restored set in the backend only once per session (remounting must not reload
// every tab); `_nativeTabs` tracks which tab ids actually have a native view, so
// navigation can create one on demand for tabs added AFTER the seed — Ctrl+T,
// the New-Tab "+", or the fresh tab that replaces the last-closed one. Without
// it, those tabs have no native view and navigation silently no-ops to a blank
// page.
let _rustSeeded = false;
const _nativeTabs = new Set();

// Overlay attach/detach invokes flow through one FIFO chain — Tauri command
// tasks can interleave (invoke order ≠ call order), and a stale attach landing
// after a newer attach/detach would strand the live webview in the wrong window.
let _ovOps = Promise.resolve();
function ovOp(api, cmd, args) {
  const run = () => api.invoke(cmd, args);
  const p = _ovOps.then(run, run);
  _ovOps = p.catch(() => {});
  return p;
}

export default function BrowserPage({ api, accent, rest, inOverlay = false, syncRef }) {
  const holderRef = useRef(null);
  const { tabs, activeId } = useTabStore();
  const active = tabs.find(t => t.id === activeId) || tabs[0] || null;
  const [ready, setReady] = useState(_rustSeeded);
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  // While a tab loads, the native view is hidden and LoadingScreen covers the
  // holder; revealReady flips true (showing the view) a beat after the page
  // commits — so WebKit's pre-paint white never shows. Defaults true (idle).
  const [revealReady, setRevealReady] = useState(true);
  // One toolbar popup open at a time: 'vault' | 'history' | 'shield' | null.
  // When open, the native view shrinks DOWN by POPOVER_HEIGHT (insetRef, read by
  // syncBounds) so the popup drops into the vacated strip — page stays visible.
  const [popup, setPopup] = useState(null);
  const insetRef = useRef(0);
  insetRef.current = popup ? POPOVER_HEIGHT : 0;
  const togglePopup = useCallback((id) => setPopup(p => (p === id ? null : id)), []);
  const { status: credStatus } = useCredsStore();
  useVaultLock(credStatus);
  const isVaultRoute = rest === 'vault' || rest.startsWith('vault/');
  const isHistoryRoute = rest === 'history';

  // Browser Overlay Panel state. Main window: while the active tab's webview is
  // reparented into the overlay host, this chrome must not drive the native
  // view (switch/bounds/visibility) — the overlay realm owns it; the detached
  // event re-runs the gated effects, which re-assert. Overlay realm (inOverlay):
  // only mounted while the panel is open+shown, so it always drives, and its
  // unmount sends the webview home.
  const [ovAttached, setOvAttached] = useState(false);
  const ovAttachedRef = useRef(false);
  ovAttachedRef.current = ovAttached;
  useEffect(() => {
    if (inOverlay) return undefined;
    api.invoke('browser_overlay_attached').then((id) => setOvAttached(!!id)).catch(() => {});
    return subscribeBrowserOverlayAttached((id) => setOvAttached(!!id));
  }, [api, inOverlay]);
  const driveNative = inOverlay || !ovAttached;

  const syncBounds = useCallback(() => {
    const el = holderRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const inset = insetRef.current; // shrink the native view down when a popup drops in
    api.invoke('browser_set_bounds', {
      x: Math.round(r.left),
      y: Math.round(r.top + inset),
      width: Math.round(r.width),
      height: Math.round(r.height - inset),
    }).catch(() => {});
  }, [api]);

  // Expose syncBounds to the overlay panel (drag/resize pump): a translate()
  // move changes the holder's viewport rect without firing its ResizeObserver.
  useEffect(() => {
    if (!syncRef) return undefined;
    syncRef.current = syncBounds;
    return () => { syncRef.current = null; };
  }, [syncRef, syncBounds]);

  // Takes the tab id rather than assuming the active tab: the deep-link effect
  // below opens a FRESH tab and must drive that one, and `active` would still be
  // the previous tab on the render where newTab() was called.
  const navigateTab = useCallback((id, url) => {
    if (!id || !url) return;
    setPopup(null);
    store.navigate(id, url);
    (async () => {
      // A tab added after the one-shot seed (a new tab, or the replacement for
      // the last-closed tab) has no native view yet — create it and make it the
      // active native view, so the load below can't silently no-op to a blank
      // page. `browser_new_tab` (url:null here) builds the view without loading;
      // the actual load is the `browser_navigate` that follows.
      if (!_nativeTabs.has(id)) {
        _nativeTabs.add(id);
        try { await api.invoke('browser_new_tab', { id, url: null }); }
        catch (e) { _nativeTabs.delete(id); throw e; }
        await api.invoke('browser_switch_tab', { id });
      }
      await api.invoke('browser_navigate', { id, url });
      syncBounds(); // pre-set bounds while hidden; the visibility effect reveals on commit
    })().catch((e) => {
      // A failed create/nav leaves the tab url-set with no webview; mark it crashed so
      // the crash card shows (its reload re-spawns) instead of an infinite LoadingScreen.
      store.setTabMeta(id, { crashed: String(e?.message || e || 'load failed'), loading: false });
      console.error('[browser] navigate', e);
    });
  }, [api, syncBounds]);

  const navigateActive = useCallback((url) => navigateTab(active?.id, url), [active, navigateTab]);

  // Recreate persisted tabs in the Rust backend once per app session.
  useEffect(() => {
    if (_rustSeeded) { setReady(true); return; }
    _rustSeeded = true;
    let cancelled = false;
    (async () => {
      for (const t of store.getSnapshot().tabs) {
        _nativeTabs.add(t.id);
        try { await api.invoke('browser_new_tab', { id: t.id, url: t.url ?? null }); }
        catch (e) { _nativeTabs.delete(t.id); console.error('[browser] new_tab', e); }
      }
      if (!cancelled) setReady(true);
    })();
    return () => { cancelled = true; };
  }, [api]);

  // Make the active tab the shown native view (or hide it for a New-Tab Page /
  // crash card). The native content views sit ABOVE the React chrome in the GTK
  // overlay, so any React UI in the holder region (New-Tab Page, crash card) is
  // only visible while the native view is hidden.
  const activeKey = active?.id ?? null;
  const activeUrl = active?.url ?? null;
  const activeCrashed = active?.crashed ?? null;
  const activeLoading = !!active?.loading;
  const activeCommitted = active?.committed !== false; // absent ⇒ treated committed

  // Reveal gating: keep the native view hidden (LoadingScreen up) until the page
  // commits, then reveal it ~100ms later so its first frame has painted — no
  // white flash, no blank-doc flash. A finished load reveals at once; a hung
  // load reveals after a safety cap so the loader can't stick forever.
  useEffect(() => {
    if (!activeLoading) { setRevealReady(true); return; }
    if (activeCommitted) {
      const settle = setTimeout(() => setRevealReady(true), 100); // commit → first-paint
      return () => clearTimeout(settle);
    }
    setRevealReady(false);
    const cap = setTimeout(() => setRevealReady(true), 15000); // hung-load safety
    return () => clearTimeout(cap);
  }, [activeLoading, activeCommitted, activeKey]);

  useEffect(() => {
    if (!ready || !activeKey || !driveNative) return;
    let cancelled = false;
    (async () => {
      // Overlay realm: pull the live webview into the overlay window before
      // driving it. Gated on activeUrl so a New-Tab tab (no native view yet)
      // never latch-attaches — by the first navigate the view exists and the
      // reparent is physical. Same-id re-attach is a Rust no-op (DEV reloads
      // the host webview on every show).
      if (inOverlay && activeUrl && !activeCrashed) {
        try { await ovOp(api, 'browser_overlay_attach', { id: activeKey }); }
        catch (e) { console.error('[browser] overlay attach', e); }
        if (cancelled) return;
      }
      try { await api.invoke('browser_switch_tab', { id: activeKey }); } catch { /* tab may be gone */ }
      if (cancelled) return;
      if (activeUrl && !activeCrashed && !isVaultRoute && !isHistoryRoute && revealReady) {
        syncBounds();
        api.invoke('browser_set_visible', { visible: true }).catch(() => {});
        requestAnimationFrame(syncBounds);
      } else {
        api.invoke('browser_set_visible', { visible: false }).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  }, [ready, activeKey, activeUrl, activeCrashed, popup, isVaultRoute, isHistoryRoute, revealReady, api, syncBounds, driveNative, inOverlay]);

  // Keep the active native view aligned on resize/layout while a URL is loaded.
  useEffect(() => {
    if (!ready || !activeUrl || !driveNative) return;
    const onResize = () => syncBounds();
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(syncBounds);
    if (holderRef.current) ro.observe(holderRef.current);
    const raf = requestAnimationFrame(syncBounds);
    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ready, activeUrl, syncBounds, driveNative]);

  // Hide the native view when leaving the browser route entirely. Overlay realm
  // sends the attached webview home instead; a suppressed main chrome must SKIP
  // the hide — browser_set_visible targets the active webview, which is the
  // overlay's live view while attached.
  useEffect(() => () => {
    if (inOverlay) { ovOp(api, 'browser_overlay_detach').catch(() => {}); return; }
    if (ovAttachedRef.current) return;
    api.invoke('browser_set_visible', { visible: false }).catch(() => {});
  }, [api, inOverlay]);

  // Mirror the active tab's URL into the editable address bar.
  useEffect(() => { setDraft(activeUrl ?? ''); setHint(''); setConfirmClear(false); }, [activeKey, activeUrl]);

  // Deep-link: /tools/browser/<url> opens the URL in a NEW tab (user-directed
  // 2026-09-13 — it used to take over whichever tab was active, so following a
  // link from a film page destroyed what you were reading).
  //
  // NOT decoded here: the browser module's own route matcher safeDecodes its
  // capture (index.jsx), which is the convention every module matcher follows —
  // App.jsx matches slots against the RAW route.path. A second pass here would
  // turn a deep-linked literal %41 into an A and silently load a different URL.
  //
  // The ref guard is load-bearing: StrictMode double-invokes effects in dev, and
  // without it one click produced two tabs. It resets on unmount, so leaving the
  // browser and clicking the same link again correctly opens another tab.
  const lastDeepLink = useRef(null);
  useEffect(() => {
    if (!ready || !rest) return;
    if (rest === 'vault' || rest.startsWith('vault/')) return; // reserved for the full vault route (SF4)
    if (rest === 'history') return; // reserved for the full history route
    if (lastDeepLink.current === rest) return;
    lastDeepLink.current = rest;
    navigateTab(store.newTab(), rest);
  }, [ready, rest, navigateTab]);

  // Keyboard: Ctrl+T new tab, Ctrl+Tab next; Ctrl+Shift+Tab prev + Ctrl+1..9
  // jump are handled manually (avoids 9 registry rows + exact-shift matching).
  // settings.keybinds (not undefined) so Settings rebinds apply live — the
  // undefined form silently pinned both actions to their defaults forever.
  const { settings: hostSettings } = useSettings();
  useKeybindAction('browser.new-tab', hostSettings.keybinds, () => { store.newTab(); }, { ignoreEditableTarget: true });
  useKeybindAction('browser.cycle-tab', hostSettings.keybinds, () => { store.cycleTab(1); }, { ignoreEditableTarget: true });
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey && e.key === 'Tab') { e.preventDefault(); store.cycleTab(-1); return; }
      if (!e.shiftKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); store.jumpTo(parseInt(e.key, 10) - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = useCallback((raw) => {
    const typed = String(raw ?? '').trim();
    if (!typed) return;
    setPopup(null);
    const hasScheme = /^https?:\/\//i.test(typed);
    // URL if it has a scheme, or is a single dotted token (a domain) with no
    // whitespace; anything else is a search query → DuckDuckGo.
    const looksLikeUrl = hasScheme || (/\./.test(typed) && !/\s/.test(typed));
    setHint('');
    if (looksLikeUrl) {
      navigateActive(hasScheme ? typed : 'https://' + typed);
    } else {
      navigateActive('https://duckduckgo.com/?q=' + encodeURIComponent(typed));
    }
  }, [navigateActive]);

  const tabId = active?.id;

  // Shield (ad-blocker) — reactive enabled + per-site state from the browser
  // module bag (shared with the Settings → Shield tab via useModuleSettings).
  // The toolbar shield button opens ShieldPopover, which owns the on/off toggles;
  // `replayBlockerToBackend` re-pushes persisted state into the in-memory backend
  // once per session (it resets to defaults each launch).
  const { settings: browserBag } = useModuleSettings('browser');
  useEffect(() => { replayBlockerToBackend(); }, []);
  const blockerEnabled = browserBag.blocker?.enabled !== false;
  const blockerAllow = Array.isArray(browserBag.blocker?.allowlist) ? browserBag.blocker.allowlist : [];
  const curHost = store.hostOf(activeUrl || '');
  const siteAllowed = isHostAllowed(blockerAllow, curHost);
  const shieldActive = blockerEnabled && !!curHost && !siteAllowed;

  const clearData = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true);
      setHint('Clear cookies + cache — signs you out everywhere. Click Clear again to confirm.');
      return;
    }
    setConfirmClear(false);
    api.invoke('browser_clear_data')
      .then(() => {
        if (tabId) { store.setTabMeta(tabId, { loading: true }); api.invoke('browser_reload', { id: tabId }).catch(() => {}); }
        setHint('Signed out — cookies and cache cleared.');
      })
      .catch((e) => { console.error('[browser] clear', e); setHint('Clear failed.'); });
  }, [confirmClear, api, tabId]);

  // Crash card → manual retry: clear the crashed flag (which un-hides the native
  // view via the visibility effect) and reload so WebKit respawns the renderer.
  const reloadCrashed = useCallback(() => {
    if (!tabId) return;
    store.setTabMeta(tabId, { crashed: null, loading: true });
    api.invoke('browser_reload', { id: tabId }).catch(() => {});
  }, [api, tabId]);

  if (isVaultRoute) {
    return <VaultRoute api={api} accent={accent} onClose={() => api.router.navigate('/tools/browser')} />;
  }

  if (isHistoryRoute) {
    return <HistoryRoute api={api} accent={accent} onClose={() => api.router.navigate('/tools/browser')} onOpenUrl={navigateActive} />;
  }

  // Shared inline style for the candy toolbar buttons: lift the rest-state center
  // half the candy depth so the slab clears the shorter URL input (candyCenterOffset),
  // and pass the accent through for the hover/active fill.
  const candyNav = { ...candyCenterOffset(), '--accent': accent };

  // LoadingScreen covers the holder (native view hidden) until the page commits.
  // Past the vault/history early-returns here, so those routes are already out.
  const showLoader = !!activeUrl && !activeCrashed && !revealReady;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={barStyle}>
        <button className="candy-btn" data-shape="icon" data-own-press title="Back"
          disabled={!active?.canBack} style={candyNav}
          onClick={() => tabId && api.invoke('browser_back', { id: tabId }).catch(() => {})}>
          <span className="candy-face">‹</span>
        </button>
        <button className="candy-btn" data-shape="icon" data-own-press title="Forward"
          disabled={!active?.canForward} style={candyNav}
          onClick={() => tabId && api.invoke('browser_forward', { id: tabId }).catch(() => {})}>
          <span className="candy-face">›</span>
        </button>
        <button className="candy-btn" data-shape="icon" data-own-press title="Reload" style={candyNav}
          onClick={() => { if (tabId) { store.setTabMeta(tabId, { loading: true }); api.invoke('browser_reload', { id: tabId }).catch(() => {}); } }}>
          <span className="candy-face">⟳</span>
        </button>
        <button
          className={`candy-btn${shieldActive ? ' is-active' : ''}`} data-shape="icon" data-own-press
          title={
            !curHost ? 'Shield settings'
              : !blockerEnabled ? 'Shield is off globally — click for settings'
                : siteAllowed ? `Shield off for ${curHost} — click for settings`
                  : `Shield on for ${curHost} — click for settings`
          }
          aria-haspopup="dialog" aria-expanded={popup === 'shield'} style={candyNav}
          onClick={() => togglePopup('shield')}
        ><span className="candy-face"><ShieldGlyph off={!shieldActive} /></span></button>
        <button className="candy-btn" data-shape="icon" data-own-press title="History"
          aria-haspopup="dialog" aria-expanded={popup === 'history'} style={candyNav}
          onClick={() => togglePopup('history')}>
          <span className="candy-face"><IconClock size={15} /></span>
        </button>
        <VaultKeyButton
          accent={accent}
          host={curHost}
          open={popup === 'vault'}
          onToggle={() => togglePopup('vault')}
        />
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (hint) setHint(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') go(draft); }}
          placeholder="Search DuckDuckGo or enter a URL"
          spellCheck={false}
          autoComplete="off"
          style={inputStyle}
        />
        <button className="candy-btn" data-shape="text" data-own-press style={candyNav} onClick={() => go(draft)}>
          <span className="candy-face">Go</span>
        </button>
        <button
          className={`candy-btn${confirmClear ? ' is-active' : ''}`} data-shape="text" data-own-press
          title="Sign out & clear browsing data (cookies + cache)" style={candyNav}
          onClick={clearData}
        ><span className="candy-face">{confirmClear ? 'Confirm' : 'Clear'}</span></button>
      </div>
      {hint && <div style={hintStyle} role="status">{hint}</div>}
      {/* The active native WebKit view fills this region (positioned via
          browser_set_bounds). When the active tab has no URL, the New-Tab Page
          renders here instead and the native view is hidden. */}
      <div ref={holderRef} style={{ flex: '1 1 auto', minHeight: 0, position: 'relative', background: 'var(--bg)' }}>
        {!inOverlay && ovAttached && activeUrl && !activeCrashed && (
          <div style={ovNoticeStyle}>This tab is showing in the game overlay.</div>
        )}
        {!activeUrl && <NewTabPage api={api} accent={accent} onNavigate={navigateActive} />}
        {activeUrl && activeCrashed && (
          <CrashedNotice reason={activeCrashed} accent={accent} onReload={reloadCrashed} />
        )}
        {showLoader && <LoadingScreen host={curHost} accent={accent} />}
        {popup === 'vault' && (
          <SitePopover
            api={api}
            accent={accent}
            host={curHost}
            clipboardClearSecs={credStatus?.clipboardClearSecs ?? 30}
            revealRemaskSecs={credStatus?.revealRemaskSecs ?? 20}
            onClose={() => setPopup(null)}
          />
        )}
        {popup === 'history' && (
          <HistoryPopover api={api} accent={accent} onOpenUrl={navigateActive} onClose={() => setPopup(null)} />
        )}
        {popup === 'shield' && (
          <ShieldPopover api={api} accent={accent} host={curHost} onClose={() => setPopup(null)} />
        )}
      </div>
    </div>
  );
}

// Shield glyph for the toolbar toggle; inherits `currentColor` (accent when
// active, muted when off) and shows a plain shield (on) or a crossed one (off).
function ShieldGlyph({ off }) {
  return off ? <IconShieldOff /> : <IconShield />;
}

const barStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: 8,
  flex: '0 0 auto',
  borderBottom: '1px solid var(--border)',
  background: 'var(--surface)',
};

const inputStyle = {
  flex: 1,
  minWidth: 0,
  padding: '6px 10px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  font: 'inherit',
};

// Fills the holder while the active tab's webview lives in the overlay host
// (the reparent leaves this window with nothing to show in the region).
const ovNoticeStyle = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  color: 'var(--text-muted)',
  background: 'var(--bg)',
};

const hintStyle = {
  flex: '0 0 auto',
  padding: '6px 12px',
  fontSize: 12,
  color: 'var(--text)',
  opacity: 0.7,
  background: 'var(--surface)',
  borderBottom: '1px solid var(--border)',
};

// Shown over the (hidden) native view when a tab's renderer process died and
// the one automatic reload didn't bring it back. Offers a manual retry.
function CrashedNotice({ reason, accent, onReload }) {
  // `reason` is either a WebView2 ProcessFailed kind (a real renderer death, which
  // the Rust side already auto-reloaded once) or the literal message from a failed
  // create/navigate — see navigateTab's catch. The second kind used to be flattened
  // into the same generic sentence, which hid "blocked: only https:// public URLs
  // are allowed" behind "stopped responding" and cost a whole debugging session.
  // Renderer kinds keep their friendly wording; anything else shows what actually
  // failed, and drops the reload claim, which is untrue for a navigate that never ran.
  const rendererMsg = reason === 'ExceededMemoryLimit'
    ? "This page used too much memory and was stopped."
    : reason === 'Crashed'
    ? "This page crashed the browser engine."
    : null;
  const msg = rendererMsg
    ? rendererMsg + " It was reloaded once automatically — reload again if it didn't recover."
    : (reason || "This page's renderer stopped unexpectedly.");
  return (
    <div style={crashWrap}>
      <div style={crashCard}>
        <div style={crashTitle}>Page stopped responding</div>
        <p style={crashBody}>{msg}</p>
        <button
          type="button"
          className="candy-btn" data-shape="text" data-own-press
          style={{ '--accent': accent }}
          onClick={onReload}
        ><span className="candy-face">Reload page</span></button>
      </div>
    </div>
  );
}

const crashWrap = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 32,
  background: 'var(--bg)',
};

const crashCard = {
  maxWidth: 420,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 14,
  textAlign: 'center',
};

const crashTitle = { fontSize: 16, fontWeight: 600, color: 'var(--text)' };

const crashBody = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)' };

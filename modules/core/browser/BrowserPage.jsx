import { useEffect, useRef, useState, useCallback } from 'react';
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
import { IconClock } from '@host/components/icons.jsx';
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

export default function BrowserPage({ api, accent, rest }) {
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

  const navigateActive = useCallback((url) => {
    if (!active || !url) return;
    setPopup(null);
    const id = active.id;
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
    })().catch((e) => console.error('[browser] navigate', e));
  }, [active, api, syncBounds]);

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
    if (!ready || !activeKey) return;
    let cancelled = false;
    (async () => {
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
  }, [ready, activeKey, activeUrl, activeCrashed, popup, isVaultRoute, isHistoryRoute, revealReady, api, syncBounds]);

  // Keep the active native view aligned on resize/layout while a URL is loaded.
  useEffect(() => {
    if (!ready || !activeUrl) return;
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
  }, [ready, activeUrl, syncBounds]);

  // Hide the native view when leaving the browser route entirely.
  useEffect(() => () => { api.invoke('browser_set_visible', { visible: false }).catch(() => {}); }, [api]);

  // Mirror the active tab's URL into the editable address bar.
  useEffect(() => { setDraft(activeUrl ?? ''); setHint(''); setConfirmClear(false); }, [activeKey, activeUrl]);

  // Deep-link: /tools/browser/<encoded-url> loads into the active tab.
  useEffect(() => {
    if (!ready || !rest || !active) return;
    if (rest === 'vault' || rest.startsWith('vault/')) return; // reserved for the full vault route (SF4)
    if (rest === 'history') return; // reserved for the full history route
    let url = rest;
    try { url = decodeURIComponent(rest); } catch { /* use raw */ }
    navigateActive(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rest]);

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

// Monochrome shield glyph for the toolbar toggle; inherits `currentColor`
// (accent when active, muted when off) and shows a check (on) or slash (off).
function ShieldGlyph({ off }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z" />
      {off ? <path d="M5.5 5.5l13 13" /> : <path d="M9 12l2 2 4-4" />}
    </svg>
  );
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
  const msg = (reason === 'ExceededMemoryLimit'
    ? "This page used too much memory and was stopped."
    : reason === 'Crashed'
    ? "This page crashed the browser engine."
    : "This page's renderer stopped unexpectedly.")
    + " It was reloaded once automatically — reload again if it didn't recover.";
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

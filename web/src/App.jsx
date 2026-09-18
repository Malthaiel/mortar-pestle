import { useCallback, useEffect, useRef, useState } from 'react';
import { useHashRoute, navigate } from './router.js';
import { useSettings } from './hooks/useSettings.js';
import { useKeybindAction } from './keybinds/useKeybind.js';
import { useProviders, useRouteSlots } from './module-sdk/useModuleRegistry.js';
import { sharedEvents } from './module-sdk/index.js';
import { recordVisit } from './hooks/useRecentPages.js';
import { registerCommandAction } from './command-actions.js';
import { useGlobalTactileSound, useGlobalCandyPressHold } from './hooks/useTactileSound.js';
import { useEventReminders } from './hooks/useEventReminders.js';
import { useFeedbackNotifications } from './hooks/useFeedbackNotifications.js';
import { useSitePush } from './hooks/useSitePush.js';
import { useSiteBookings } from './hooks/useSiteBookings.js';
import AppShell from './components/AppShell.jsx';
import TitleBar from './components/TitleBar.jsx';
import ToolsPage from './pages/ToolsPage.jsx';
import PageView from './pages/PageView.jsx';
import SettingsDrawer from './components/SettingsDrawer.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import KeyboardHintsOverlay from './components/KeyboardHintsOverlay.jsx';
import BreakOverlay from './components/BreakOverlay.jsx';
import ConfettiBurst from './components/ConfettiBurst.jsx';
import WikilinkHoverPreview from './components/WikilinkHoverPreview.jsx';
import WhatsNewOverlay from './components/WhatsNewOverlay.jsx';
import DocsPage from './pages/docs/DocsPage.jsx';
import Dock from './components/dock/Dock.jsx';
// TEMPORARY icon picker host — removed with IconPicker.jsx once icons are baked in.
import { IconPickerHost } from './components/IconPicker.jsx';
import MarkupOverlay from './components/markup/MarkupOverlay.jsx';
import { useMarkupMode } from './components/markup/useMarkupMode.js';
import RecyclingBinModal from './components/RecyclingBinModal.jsx';
import { ActiveModuleProvider } from './hooks/useActiveModule.jsx';
import { NotificationProvider } from './notifications/NotificationProvider.jsx';
import { ContextMenuProvider } from './context-menu/ContextMenuProvider.jsx';
import TransientToastLayer from './notifications/TransientToastLayer.jsx';
import NotificationPanel from './notifications/NotificationPanel.jsx';
import { DownloadsProvider } from './downloads/DownloadsProvider.jsx';
import ProcessesProvider from './processes/ProcessesProvider.jsx';
import ProcessesModal from './processes/ProcessesModal.jsx';
import DownloadsPanel from './downloads/DownloadsPanel.jsx';
import DownloadsManager from './downloads/DownloadsManager.jsx';
import { VaultProvider, useVaults } from './hooks/useVaults.jsx';
import { isPopoutWindow, installPopoutGeometryMemory } from './util/popout.js';
import OverlayHostView from './overlays/OverlayHostView.jsx';
import OverlayToastView from './overlays/OverlayToastView.jsx';
import PlayerControlsView from './overlays/PlayerControlsView.jsx';

// Compose every module-registered provider around the app tree. Order is
// registration order (topological if modules declare `requires`).
function ComposedProviders({ children }) {
  const providers = useProviders();
  return providers.reduceRight(
    (tree, { Component }) => <Component>{tree}</Component>,
    children
  );
}

// A module pop-out window (label `popout-<moduleId>`) renders the SAME MainApp,
// minus the Dock and minus the app-wide background helpers — those are
// singletons and would fire once per open window. Read once: a window's label
// never changes. See util/popout.js.
const POPOUT = isPopoutWindow();
if (POPOUT) installPopoutGeometryMemory();

function readHash() {
  return typeof window !== 'undefined' ? (window.location.hash || '') : '';
}

export default function App() {
  const [hash, setHash] = useState(readHash);
  useEffect(() => {
    const h = () => setHash(readHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  // VaultProvider wraps both routes so the active vault's media root + deep-link
  // name are set in every window (the /player popout is a separate webview).
  // Overlay windows render standalone (no app chrome, no vault context) — keyed
  // off their URL hash, the same self-identifying pattern as the /player popout.
  // The player's controls layer is its own transparent child webview stacked
  // above the mpv picture — standalone like the overlays, no vault context.
  if (hash.startsWith('#/player/controls')) return <PlayerControlsView/>;
  if (hash.startsWith('#/overlay/host')) return <OverlayHostView/>;
  if (hash.startsWith('#/overlay/toast')) return <OverlayToastView/>;
  return (
    <VaultProvider>
      {hash.startsWith('#/player')
        ? <PlayerRouteDispatcher hash={hash}/>
        : <KeyedMainApp/>}
    </VaultProvider>
  );
}

// A vault switch bumps vaultEpoch; keying MainApp on it forces a full remount —
// the hard-reload "clean slate" (tabs/panes/buffers gone, all data re-fetched)
// after the Rust side has repointed vault_root, the manifest, and the watcher.
function KeyedMainApp() {
  const { vaultEpoch } = useVaults();
  return <MainApp key={vaultEpoch}/>;
}

// The /player popout matches a module route (registered by the Video module).
// Renders outside MainApp so it has no sidebar / dock chrome — kiosk mode.
function PlayerRouteDispatcher({ hash }) {
  const routeSlots = useRouteSlots();
  const path = hash.replace(/^#/, '').split('?')[0];
  for (const slot of routeSlots) {
    const params = slot.match(path);
    if (params) return slot.render({ route: path, params });
  }
  return null;
}

function MainApp() {
  useGlobalTactileSound();
  useGlobalCandyPressHold();
  useEventReminders(21, !POPOUT);
  useFeedbackNotifications(!POPOUT);
  const route = useHashRoute();
  const routeSlots = useRouteSlots();

  // ── Page transition direction tracking ─────────────────────────────────────
  const historyStack = useRef([]);
  const [direction, setDirection] = useState('forward');
  const prevPath = useRef(route.path);

  useEffect(() => {
    const currentPath = route.path || '/';
    const previousPath = prevPath.current || '/';
    if (currentPath === previousPath) return;

    const stack = historyStack.current;
    const backIdx = stack.length - 2;
    if (backIdx >= 0 && stack[backIdx] === currentPath) {
      setDirection('backward');
      stack.pop(); // went back
    } else {
      setDirection('forward');
      stack.push(previousPath);
    }
    prevPath.current = currentPath;
  }, [route.path]);
  const { settings, setSetting, setPreviewAccent, resetSettings } = useSettings(route.accentKey);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [hintsOpen, setHintsOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloadsManagerOpen, setDownloadsManagerOpen] = useState(false);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [processesOpen, setProcessesOpen] = useState(false);
  const accent = settings.accentColor;
  // Site Bridge, both directions. Off by default; reads nothing while off.
  useSitePush(!POPOUT && settings.sitePushEnabled === true);
  useSiteBookings(!POPOUT && settings.sitePushEnabled === true);

  // Visit tracking — records every route change to the recent-pages list,
  // surfaced in both the Cmd+K palette and the sidebar recently-visited
  // capsule.
  useEffect(() => {
    if (!route.path || route.path === '/') return;
    const label = deriveVisitLabel(route);
    recordVisit('#' + route.path, label);
  }, [route.path]);

  // SF8: clear any seeded palette query once the palette closes, so the next
  // keyboard/Dock open starts empty (only openCommandPalette(q) seeds it).
  useEffect(() => { if (!paletteOpen) setPaletteQuery(''); }, [paletteOpen]);

  // Global shortcuts read from settings.keybinds (registry-driven). Two host
  // actions: open the palette, toggle the hints overlay. Cmd+K is a global
  // escape hatch — it fires even from inputs; the hints toggle respects input
  // focus per the registry's default behavior.
  const togglePalette = useCallback(() => setPaletteOpen(o => !o), []);
  const toggleHints = useCallback(() => setHintsOpen(o => !o), []);

  useKeybindAction('command-palette.toggle', settings.keybinds, togglePalette, { ignoreEditableTarget: true });
  useKeybindAction('hints.toggle',           settings.keybinds, toggleHints);

  // Markup mode — hover any element for its name + ancestor breadcrumb, click to
  // copy `ComponentName — path/File.jsx:12:4` to the clipboard. Both attributes
  // are stamped on every JSX element by the aos-component-id Vite plugin.
  const { markupOn, toggleMarkup } = useMarkupMode();
  useKeybindAction('markup.toggle', settings.keybinds, toggleMarkup, { ignoreEditableTarget: true });
  const copyMarkupTarget = useCallback((el) => {
    const { aosComponent = 'Unknown', aosSource = '' } = el?.dataset || {};
    navigator.clipboard.writeText(aosSource ? `${aosComponent} — ${aosSource}` : aosComponent);
  }, []);

  // Host-registered palette actions. Modules register their own via
  // registerCommandAction. These are the always-present chrome actions.
  useEffect(() => {
    const unsubs = [
      registerCommandAction({
        id: 'host.settings.open',
        label: 'Open Settings',
        keywords: ['preferences', 'config', 'theme', 'about'],
        run: () => setSettingsOpen(true),
      }),
      registerCommandAction({
        id: 'host.hints.open',
        label: 'Show keyboard shortcuts',
        keywords: ['help', 'keys', 'cheatsheet'],
        shortcut: '?',
        run: () => setHintsOpen(true),
      }),
      registerCommandAction({
        id: 'host.releases.open',
        label: 'Open release history',
        keywords: ['changelog', 'versions', 'updates', 'what\'s new'],
        run: () => navigate('/docs/releases'),
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Modules (e.g. the browser Shield popup) can deep-link into a specific
  // Settings address via the shared event bus. Payload: { path: 'modules/
  // browser/vault' } or an address object { tab, page?, section? } (legacy
  // { tab: oldId } payloads keep working via the registry aliases).
  useEffect(() => sharedEvents.on('host:open-settings', (payload = {}) => {
    setSettingsTab(payload.path ?? (payload.tab ? payload : null));
    setSettingsOpen(true);
  }), []);

  const pageProps = {
    accent,
    settings,
    setSetting,
    sub: route.sub,
  };

  // Module-owned route slots win first. Falls through to the legacy switch
  // for sections still hardcoded (Tools, Page).
  let PageComponent = null;
  for (const slot of routeSlots) {
    const params = slot.match(route.path);
    if (params) {
      PageComponent = slot.render({ route: route.path, params, accent });
      break;
    }
  }
  if (!PageComponent) {
    switch (route.page) {
      case 'tools':           PageComponent = <ToolsPage rest={route.rest} {...pageProps}/>; break;
      case 'page':            PageComponent = <PageView path={route.sub} {...pageProps}/>; break;
      case 'docs':            PageComponent = <DocsPage route={route} accent={accent}/>; break;
      default:                PageComponent = null;
    }
  }

  return (
    <ActiveModuleProvider settings={settings} setSetting={setSetting}>
    <NotificationProvider settings={settings}>
    <ContextMenuProvider
      openCommandPalette={(q) => { setPaletteQuery(typeof q === 'string' ? q : ''); setPaletteOpen(true); }}
      openSettings={() => { setSettingsTab(null); setSettingsOpen(true); }}
      accent={accent}
    >
    <ComposedProviders>
      <DownloadsProvider settings={settings}>
      <ProcessesProvider>
      <TitleBar
        settings={settings}
        accent={accent}
        setSettingsOpen={setSettingsOpen}
        setSettingsTab={setSettingsTab}
        setNotifOpen={setNotifOpen}
        notifOpen={notifOpen}
        setRecycleBinOpen={setRecycleBinOpen}
        setProcessesOpen={setProcessesOpen}
        setDownloadsOpen={setDownloadsOpen}
        downloadsOpen={downloadsOpen}
        setPaletteOpen={setPaletteOpen}
        paletteOpen={paletteOpen}
        setHintsOpen={setHintsOpen}
        hintsOpen={hintsOpen}
      />
      <AppShell
        onOpenSettings={() => setSettingsOpen(true)}
        settingsOpen={settingsOpen}
        accent={accent}
        settings={settings}
      >
        <PageTransition key={route.path || '/'} direction={direction}>
          {PageComponent}
        </PageTransition>
      </AppShell>
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSettingsTab(null); }}
        initialAddress={settingsTab}
        settings={settings}
        setSetting={setSetting}
        resetSettings={resetSettings}
        accent={accent}
        setPreviewAccent={setPreviewAccent}
      />
      <CommandPalette
        open={paletteOpen}
        initialQuery={paletteQuery}
        onClose={() => setPaletteOpen(false)}
        accent={accent}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <KeyboardHintsOverlay
        open={hintsOpen}
        onClose={() => setHintsOpen(false)}
        accent={accent}
        keybinds={settings.keybinds}
      />
      <ProcessesModal
        open={processesOpen}
        onClose={() => setProcessesOpen(false)}
        accent={accent}
      />
      <RecyclingBinModal
        open={recycleBinOpen}
        onClose={() => setRecycleBinOpen(false)}
        accent={accent}
        retentionDays={settings.recycleBinRetentionDays}
        maxItems={settings.recycleBinMaxItems}
      />
      {/* No palette/hints props: those two buttons moved to the titlebar
          2026-09-15, and nothing left in the dock registry reads them. */}
      {!POPOUT && <Dock
        settings={settings}
        setSetting={setSetting}
        accent={accent}
      />}
      <TransientToastLayer/>
      <NotificationPanel open={notifOpen} onClose={() => setNotifOpen(false)} accent={accent}/>
      <DownloadsPanel open={downloadsOpen} onClose={() => setDownloadsOpen(false)} accent="var(--text-muted)"
        onOpenManager={() => { setDownloadsOpen(false); setDownloadsManagerOpen(true); }}/>
      <DownloadsManager open={downloadsManagerOpen} onClose={() => setDownloadsManagerOpen(false)} accent="var(--text-muted)"/>
      <BreakOverlay accent={accent}/>
      <ConfettiBurst accent={accent}/>
      <WikilinkHoverPreview/>
      <WhatsNewOverlay/>
      <IconPickerHost/>
      {markupOn && <MarkupOverlay accent={accent} onPick={copyMarkupTarget}/>}
      </ProcessesProvider>
      </DownloadsProvider>
    </ComposedProviders>
    </ContextMenuProvider>
    </NotificationProvider>
    </ActiveModuleProvider>
  );
}

function PageTransition({ direction, children }) {
  // The enter animation is selected entirely in CSS off body[data-page-tx-style]
  // (set by useSettings) — see styles.css § Page transitions. We only supply the
  // navigation direction; the keyed remount at the render site replays it per route.
  return (
    <div
      className="page-tx"
      data-dir={direction}
      style={{
        flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
}

// Best-effort label for a visited route. Prefers leaf filename for /page/*,
// last segment for /knowledge/<slug>/<folder>, or the route's label.
function deriveVisitLabel(route) {
  if (route.page === 'page' && route.sub) {
    const leaf = route.sub.split('/').pop().replace(/\.md$/, '');
    return leaf || route.sub;
  }
  if (route.page === 'vault' && route.sub) {
    const parts = [route.sub, route.folderPath].filter(Boolean).join('/').split('/');
    return parts[parts.length - 1] || route.label;
  }
  if (route.page === 'planner' && route.sub) return `Planner · ${route.sub}`;
  return route.label || route.path;
}

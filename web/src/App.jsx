import { useCallback, useEffect, useRef, useState } from 'react';
import { useHashRoute, navigate } from './router.js';
import { useSettings } from './hooks/useSettings.js';
import { useKeybindAction } from './keybinds/useKeybind.js';
import { useProviders, useRouteSlots } from './module-sdk/useModuleRegistry.js';
import { sharedEvents } from './module-sdk/index.js';
import { recordVisit } from './hooks/useRecentPages.js';
import { registerCommandAction } from './command-actions.js';
import { useGlobalTactileSound } from './hooks/useTactileSound.js';
import { useEventReminders } from './hooks/useEventReminders.js';
import { useFeedbackNotifications } from './hooks/useFeedbackNotifications.js';
import AppShell from './components/AppShell.jsx';
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
import DesignModeOverlay from './components/design/DesignModeOverlay.jsx';
import PlannerModal from './components/PlannerModal.jsx';
import RecyclingBinModal from './components/RecyclingBinModal.jsx';
import { ActiveModuleProvider } from './hooks/useActiveModule.jsx';
import { NotificationProvider } from './notifications/NotificationProvider.jsx';
import { ContextMenuProvider } from './context-menu/ContextMenuProvider.jsx';
import TransientToastLayer from './notifications/TransientToastLayer.jsx';
import NotificationPanel from './notifications/NotificationPanel.jsx';
import { DownloadsProvider } from './downloads/DownloadsProvider.jsx';
import DownloadsPanel from './downloads/DownloadsPanel.jsx';
import DownloadsManager from './downloads/DownloadsManager.jsx';
import { VaultProvider, useVaults } from './hooks/useVaults.jsx';
import OverlayCaptureView from './overlays/OverlayCaptureView.jsx';
import OverlayScrimView from './overlays/OverlayScrimView.jsx';

// Compose every module-registered provider around the app tree. Order is
// registration order (topological if modules declare `requires`).
function ComposedProviders({ children }) {
  const providers = useProviders();
  return providers.reduceRight(
    (tree, { Component }) => <Component>{tree}</Component>,
    children
  );
}

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
  if (hash.startsWith('#/overlay/capture')) return <OverlayCaptureView/>;
  if (hash.startsWith('#/overlay/scrim')) return <OverlayScrimView/>;
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
  useEventReminders();
  useFeedbackNotifications();
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
  const { settings, setSetting, setPreviewAccent, resetSettings, resolvedTheme } = useSettings(route.accentKey);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [hintsOpen, setHintsOpen] = useState(false);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloadsManagerOpen, setDownloadsManagerOpen] = useState(false);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const accent = settings.accentColor;

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
        resolvedTheme={resolvedTheme}
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
      <PlannerModal
        open={plannerOpen}
        onClose={() => setPlannerOpen(false)}
        accent={accent}
      />
      <RecyclingBinModal
        open={recycleBinOpen}
        onClose={() => setRecycleBinOpen(false)}
        accent={accent}
        retentionDays={settings.recycleBinRetentionDays}
        maxItems={settings.recycleBinMaxItems}
      />
      <Dock
        settings={settings}
        setSetting={setSetting}
        setSettingsOpen={setSettingsOpen}
        settingsOpen={settingsOpen}
        setPaletteOpen={setPaletteOpen}
        paletteOpen={paletteOpen}
        setHintsOpen={setHintsOpen}
        hintsOpen={hintsOpen}
        setPlannerOpen={setPlannerOpen}
        plannerOpen={plannerOpen}
        setNotifOpen={setNotifOpen}
        notifOpen={notifOpen}
        setDownloadsOpen={setDownloadsOpen}
        downloadsOpen={downloadsOpen}
        setRecycleBinOpen={setRecycleBinOpen}
        recycleBinOpen={recycleBinOpen}
        accent={accent}
        resolvedTheme={resolvedTheme}
      />
      <TransientToastLayer/>
      <NotificationPanel open={notifOpen} onClose={() => setNotifOpen(false)} accent={accent}/>
      <DownloadsPanel open={downloadsOpen} onClose={() => setDownloadsOpen(false)} accent="var(--text-muted)"
        onOpenManager={() => { setDownloadsOpen(false); setDownloadsManagerOpen(true); }}/>
      <DownloadsManager open={downloadsManagerOpen} onClose={() => setDownloadsManagerOpen(false)} accent="var(--text-muted)"/>
      <BreakOverlay accent={accent}/>
      <ConfettiBurst accent={accent}/>
      <WikilinkHoverPreview/>
      <WhatsNewOverlay/>
      <DesignModeOverlay settings={settings} setSetting={setSetting} accent={accent}/>
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

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
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
  if (route.page === 'pulse' && route.sub) return `Pulse · ${route.sub}`;
  return route.label || route.path;
}

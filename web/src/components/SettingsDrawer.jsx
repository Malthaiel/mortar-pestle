// Full-screen centered settings modal.
//
// Layout: 960px wide, resizable left rail (default 180px, collapsible to a
// 64px icon-only strip) + content pane on the right. Final 9-tab rail:
// Appearance, Sounds, Navigation, Modules, Agents, Keybinds, Vaults, System
// (+ Dev in dev builds only). Module-contributed settings render as pages
// inside the Modules tab; sub-tab strips and pages are addressed via the
// drawer-level { tab, page, section } address (settings-registry.js).
//
// Backdrop click + Esc close the modal. Reset button in the footer restores
// defaults for the currently-visible scope.

import { useCallback, useEffect, useState, useMemo, useRef, lazy, Suspense } from 'react';
import { useSettingsSlots, useManifests } from '../module-sdk/useModuleRegistry.js';
import { useHashRoute } from '../router.js';
import { SETTINGS_SEARCH_INDEX, searchSettings } from './settings/settings-search-index.js';
import { normalizeAddress, withDefaults, resolveOpenAddress, readLastTab, writeLastTab, TAB_SECTIONS, PAGE_SECTIONS, scopeFor } from './settings/settings-registry.js';
import { useUpdateStatus } from '../hooks/useUpdateStatus.js';
import { SectionBand, Row, StackedRow } from './settings/section-primitives.jsx';
import ModulePage from './settings/ModulePage.jsx';
import AreaReleasesView from '../pages/docs/AreaReleasesView.jsx';
import { moduleIdForArea } from '../hooks/useModuleAreas.js';
import { AREA_PALETTE } from '../hooks/useReleaseQueue.js';
import PulseViewsPage from './settings/PulseViewsPage.jsx';
import SystemTab from './settings/SystemTab.jsx';
import { useModuleEnabledMap } from '../hooks/useModuleEnabled.js';
import { candyGap } from '../util/candy.js';
import ModulesTab from './settings/ModulesTab.jsx';
import { AnimationField } from './settings/AnimationRows.jsx';
import { ANIMATION_KEYS, ANIMATION_PRESETS, ANIMATION_KEY_CONFIG, SETTINGS_DEFAULTS, SANS_OPTIONS, MONO_OPTIONS } from '../hooks/useSettings.js';
import SoundsTab from './settings/SoundsTab.jsx';
import NavigationTab from './settings/NavigationTab.jsx';
import AgentsTab from './settings/AgentsTab.jsx';
import KeybindsTab from './settings/KeybindsTab.jsx';
import VaultsTab from './settings/VaultsTab.jsx';
import ThemePicker from './settings/ThemePicker.jsx';
import { THEME_BY_ID } from '../themes/registry.js';
import SidebarSeam from './SidebarSeam.jsx';
import {
  IconSearch,
  IconSparkles,
  IconLayers,
  IconPackage,
  IconSpeaker,
  IconBrush,
  IconWrench,
  IconKeyboard,
  IconDatabase,
  IconCpu,
  IconTag,
} from './icons.jsx';
import { Seg, OutlinedBtn, Slider, AppWindow, Topbar } from './ui/index.js';
import { AccentGrid, HexInput } from './ui/AccentPicker.jsx';
import EnableToggle from './ui/EnableToggle.jsx';
import PatternSwatchPicker from './ui/PatternSwatchPicker.jsx';

const TABS = [
  { id: 'appearance', label: 'Appearance',  icon: IconSparkles },
  { id: 'sounds',     label: 'Sounds',      icon: IconSpeaker },
  { id: 'navigation', label: 'Navigation',  icon: IconLayers },
  { id: 'modules',    label: 'Modules',     icon: IconPackage },
  { id: 'releases',   label: 'Releases',    icon: IconTag },
  { id: 'agents',     label: 'Agents',      icon: IconBrush },
  { id: 'keybinds',   label: 'Keybinds',    icon: IconKeyboard },
  { id: 'vaults',     label: 'Vaults',      icon: IconDatabase },
  { id: 'system',     label: 'System',      icon: IconWrench },
  // Dev tab. Shown in dev builds, OR in a prod build made with VITE_DEV_TOOLS=1
  // (so the RPM can host the Dev Server control panel). Both sub-expressions must
  // stay exact-form — only those are define-replaced, so a flagless prod build
  // still constant-folds the entry AND the lazy chunk away.
  ...((import.meta.env.DEV || import.meta.env.VITE_DEV_TOOLS === '1') ? [{ id: 'dev', label: 'Dev', icon: IconCpu }] : []),
];

// The .catch keeps a broken dev chunk from rejecting through Suspense with no
// boundary above it — that unmounts the entire React tree (black app).
const DevTab = (import.meta.env.DEV || import.meta.env.VITE_DEV_TOOLS === '1')
  ? lazy(() => import('./settings/DevTab.jsx').catch((e) => {
      console.error('[dev-tab] chunk failed', e);
      return { default: () => <div style={{ padding: 16 }}>Dev tab failed to load — see console.</div> };
    }))
  : null;

// Option arrays for the motion + press/depth scalars relocated out of the
// retired Animations tab (Appearance hosts most; Navigation hosts tree reveal).
const ANIM_PRESET_OPTIONS = [
  { value: 'full',    label: 'Full' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'quiet',   label: 'Quiet' },
];
const HOVER_PRESS_OPTIONS = [
  { value: '100', label: '100%' },
  { value: '75',  label: '75%'  },
  { value: '50',  label: '50%'  },
  { value: '25',  label: '25%'  },
  { value: 'off', label: 'Off'  },
];
const DEPTH_OPTIONS = [
  { value: '3', label: '3px' },
  { value: '5', label: '5px' },
  { value: '7', label: '7px' },
  { value: '9', label: '9px' },
];
const MUSIC_TILE_DEPTH_OPTIONS = [
  { value: 'large', label: 'Large' },
  { value: 'small', label: 'Small' },
];
const SURFACE_DEPTH_OPTIONS = [
  { value: 'off',    label: 'Off'    },
  { value: 'low',    label: 'Low'    },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High'   },
];
const FOLLOW_DRAG_OPTIONS = [
  { value: 'none',   label: 'None'   },
  { value: 'light',  label: 'Light'  },
  { value: 'medium', label: 'Medium' },
  { value: 'heavy',  label: 'Heavy'  },
];
const SCROLL_SMOOTHNESS_OPTIONS = [
  { value: 'off',    label: 'Off'    },
  { value: 'light',  label: 'Light'  },
  { value: 'medium', label: 'Medium' },
  { value: 'heavy',  label: 'Heavy'  },
];
const RAIL_COLLAPSED       = 64;
const RAIL_EXPANDED_DEFAULT = 180;
const RAIL_EXPANDED_MIN     = 120;
const RAIL_EXPANDED_MAX     = 320;
const RAIL_COLLAPSE_TRIGGER = 90;
const RAIL_SNAP_TARGETS     = [140, 180, 220, 260, 300];
const RAIL_PRESETS = [
  { label: 'Compact', value: 140 },
  { label: 'Default', value: 180 },
  { label: 'Wide',    value: 260 },
];
const STORAGE_RAIL_WIDTH    = 'settings:railWidth';
const STORAGE_RAIL_COLLAPSED = 'settings:railCollapsed';

function readStoredWidth() {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_RAIL_WIDTH), 10);
    if (Number.isFinite(v) && v >= RAIL_EXPANDED_MIN && v <= RAIL_EXPANDED_MAX) return v;
  } catch {}
  return RAIL_EXPANDED_DEFAULT;
}

function readStoredCollapsed() {
  try { return localStorage.getItem(STORAGE_RAIL_COLLAPSED) === '1'; } catch { return false; }
}

function writeStoredCollapsed(v) {
  try { localStorage.setItem(STORAGE_RAIL_COLLAPSED, v ? '1' : '0'); } catch {}
}

// Mirror of App.jsx's editable-target guard so '/' doesn't hijack typing.
function isEditableTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export default function SettingsDrawer({ open, onClose, settings, setSetting, setPreviewAccent, resetSettings, accent, resolvedTheme, initialAddress }) {
  // Drawer-level navigation address: { tab, page, section }. Sub-tab strips
  // and module pages are controlled from here so deep links, search jumps,
  // and the context-aware open all land on exact surfaces.
  const [addr, setAddr] = useState(() => withDefaults({ tab: 'appearance' }));
  const navigateTo = useCallback((next) => setAddr(withDefaults(next)), []);
  const moduleTabs = useSettingsSlots();
  const manifests = useManifests();
  const route = useHashRoute();

  // Search state (Feature 2) — refs/state MUST be above the early return.
  const [query, setQuery] = useState('');
  const [selResult, setSelResult] = useState(0);
  const searchRef = useRef(null);
  const contentRef = useRef(null);
  const wasOpen = useRef(false);

  // Rail state — MUST be before early return
  const [railWidth, setRailWidth] = useState(readStoredWidth);
  const [railCollapsed, setRailCollapsed] = useState(readStoredCollapsed);

  // "Keybinds →" card links open the Keybinds tab pre-filtered to one group;
  // transient UI state, cleared on dismiss or when leaving the tab.
  const [keybindsFilter, setKeybindsFilter] = useState(null);
  useEffect(() => {
    if (addr.tab !== 'keybinds' && keybindsFilter) setKeybindsFilter(null);
  }, [addr.tab, keybindsFilter]);

  // Update-available badge on the System rail tab (and the dock gear).
  const { available: updateAvailable } = useUpdateStatus();
  const showUpdateDot = !!updateAvailable && settings?.dev?.autoCheckUpdates !== false;

  // Module settings pages, keyed by module id: each module's registered
  // settings-tab render, plus host-provided pages for modules that register
  // none (pulse → Pulse Views).
  const pagesByModuleId = useMemo(() => {
    const map = {};
    for (const pt of moduleTabs) if (!map[pt.moduleId]) map[pt.moduleId] = pt;
    if (!map.pulse) map.pulse = { id: 'pulse-views', moduleId: 'pulse', label: 'Pulse Views', render: PulseViewsPage };
    return map;
  }, [moduleTabs]);
  const enabledMap = useModuleEnabledMap();

  // Scroll an anchored row into view and flash it after a navigation. The
  // 150ms retry covers async surfaces (lazy pages, sub-tab panels) that
  // mount a beat after the double-rAF.
  const flashAnchor = useCallback((anchor) => {
    const tryFlash = () => {
      const el = contentRef.current?.querySelector(`[data-search-anchor="${anchor}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('settings-search-flash');
      setTimeout(() => el.classList.remove('settings-search-flash'), 1200);
      return true;
    };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!tryFlash()) setTimeout(tryFlash, 150);
    }));
  }, []);

  // Context-aware open target for modules without a settings page — their
  // cards carry the module-card-<id> anchor.
  const flashModuleCard = useCallback((id) => flashAnchor(`module-card-${id}`), [flashAnchor]);

  // Resolve the landing address on each open: explicit deep link → the
  // current route's settings surface (module page, card flash, or override)
  // → last-visited tab. Search only auto-focuses on context-less opens.
  useEffect(() => {
    if (open && !wasOpen.current) {
      const validIds = new Set(TABS.map(t => t.id));
      const explicit = normalizeAddress(initialAddress, validIds);
      const ctx = !explicit
        ? resolveOpenAddress({
            route: route?.path,
            manifests,
            enabledMap,
            hasPage: (id) => !!pagesByModuleId[id],
          })
        : null;
      const last = readLastTab();
      setAddr(explicit || ctx?.addr || withDefaults({ tab: validIds.has(last) ? last : 'appearance' }));
      setQuery('');
      setSelResult(0);
      if (ctx?.highlight) flashModuleCard(ctx.highlight);
      if (!explicit && !ctx) requestAnimationFrame(() => searchRef.current?.focus());
    }
    wasOpen.current = open;
  }, [open, route?.path, manifests, enabledMap, pagesByModuleId, initialAddress, flashModuleCard]);

  // Remember the last-visited top-level tab for context-less reopens.
  useEffect(() => { if (open) writeLastTab(addr.tab); }, [open, addr.tab]);

  // Esc clears a non-empty query first, then closes; '/' focuses search.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (query.trim()) { e.preventDefault(); setQuery(''); return; }
        onClose();
        return;
      }
      if (e.key === '/' && !isEditableTarget(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, query]);

  const handleCollapse = () => {
    setRailCollapsed(true);
    writeStoredCollapsed(true);
  };

  const handleUncollapse = () => {
    setRailCollapsed(false);
    writeStoredCollapsed(false);
  };

  // ── Search (Feature 2) ──────────────────────────────────────────────────
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => (searching ? searchSettings(SETTINGS_SEARCH_INDEX, query, settings) : []),
    [searching, query, settings],
  );
  const tabLabelById = useMemo(() => {
    const m = {};
    for (const t of TABS) m[t.id] = t.label;
    for (const t of moduleTabs) m[t.id] = t.label;
    m.pulse = m.pulse || 'Pulse Views';
    return m;
  }, [moduleTabs]);

  // Keep the result selection in range as results change (mirrors CommandPalette).
  useEffect(() => {
    if (selResult >= results.length) setSelResult(Math.max(0, results.length - 1));
  }, [results.length, selResult]);

  // Scroll the selected result into view within the list.
  useEffect(() => {
    if (!searching) return;
    const el = contentRef.current?.querySelector(`[data-res-idx="${selResult}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [selResult, searching]);

  // Jump: switch to the owning tab, scroll the row in, flash-highlight it.
  const jumpToResult = useCallback((entry) => {
    if (!entry) return;
    // Route legacy module-tab ids through the registry aliases so old index
    // entries land on the module pages that replaced their rail tabs.
    navigateTo(normalizeAddress({ tab: entry.tabId, page: entry.page ?? null, section: entry.section ?? null })
      || { tab: entry.tabId, page: entry.page ?? null, section: entry.section ?? null });
    setQuery('');
    setSelResult(0);
    flashAnchor(entry.anchor);
  }, [navigateTo, flashAnchor]);

  // "Modules › Browser › Password Vault" for result rows. Page crumb from the
  // manifest/page label; section crumb only when it differs from the strip's
  // default (the default would be noise on every row).
  const breadcrumbFor = useCallback((entry) => {
    const a = normalizeAddress({ tab: entry.tabId, page: entry.page ?? null, section: entry.section ?? null })
      || { tab: entry.tabId, page: entry.page ?? null, section: entry.section ?? null };
    const parts = [tabLabelById[a.tab] || a.tab];
    if (a.page) parts.push(manifests[a.page]?.name || pagesByModuleId[a.page]?.label || a.page);
    const strip = a.page ? PAGE_SECTIONS[a.page] : TAB_SECTIONS[a.tab];
    if (a.section && strip && a.section !== strip.default) {
      const s = strip.sections.find(x => x.id === a.section);
      if (s) parts.push(s.label);
    }
    return parts.join(' › ');
  }, [tabLabelById, manifests, pagesByModuleId]);

  if (!open) return null;

  const visibleTabs = TABS;
  const activeTab = visibleTabs.find(t => t.id === addr.tab) ? addr.tab : 'appearance';

  // Footer Reset is scoped to the visible sub-tab (RESET_SCOPES); disabled
  // while searching and on surfaces without a scope (module pages, keybinds…).
  const resetScope = searching ? null : scopeFor(addr);
  const handleReset = () => {
    if (!resetScope) return;
    if (resetScope.bag) {
      const fields = {};
      for (const f of resetScope.fields) fields[f] = SETTINGS_DEFAULTS[resetScope.bag][f];
      setSetting(resetScope.bag, fields);
    } else {
      resetSettings(resetScope.keys);
    }
  };

  return (
    <AppWindow
      open={open}
      onClose={onClose}
      accent={accent}
      title="Settings"
      width={960}
      height="min(680px, 85vh)"
      escToClose={false}
      headerContent={(
        <div style={{ display: 'flex', justifyContent: 'center', minWidth: 0 }}>
          <SettingsSearchPill
            inputRef={searchRef}
            value={query}
            onChange={(v) => { setQuery(v); setSelResult(0); }}
            resultCount={results.length}
            onArrow={(dir) => setSelResult(s => {
              if (results.length === 0) return 0;
              return dir === 'down'
                ? Math.min(results.length - 1, s + 1)
                : Math.max(0, s - 1);
            })}
            onEnter={() => jumpToResult(results[selResult])}
          />
        </div>
      )}
      footer={(
        <>
          <OutlinedBtn small onClick={handleReset} disabled={!resetScope}>
            {resetScope ? `Reset ${resetScope.label}` : 'Reset'}
          </OutlinedBtn>
          <OutlinedBtn small onClick={onClose}>Done</OutlinedBtn>
        </>
      )}
      bodyStyle={{ padding: 0, overflowY: 'hidden', display: 'flex' }}
    >
      {/* Rail */}
          <div
            style={{
              width: railCollapsed ? RAIL_COLLAPSED : railWidth,
              padding: railCollapsed ? '14px 6px' : '14px 10px',
              borderRight: '1px solid var(--border)',
              flexShrink: 0,
              display: 'flex', flexDirection: 'column', gap: candyGap(8),
              background: 'var(--surface-2)',
              overflowX: 'hidden',
              overflowY: 'auto',
              transition: 'width 200ms cubic-bezier(0.16, 1, 0.3, 1), padding 200ms ease',
            }}
          >
            {visibleTabs.map((t) => {
              const Icon = t.icon;
              return (
                <TabButton
                  key={t.id}
                  active={t.id === activeTab}
                  accent={accent}
                  onClick={() => { setQuery(''); navigateTo({ tab: t.id }); }}
                  icon={Icon}
                  iconOnly={railCollapsed}
                  updateDot={t.id === 'system' && showUpdateDot}
                >{t.label}</TabButton>
              );
            })}
          </div>

          <SidebarSeam
            width={railWidth}
            onWidthChange={setRailWidth}
            accent={accent}
            defaultWidth={RAIL_EXPANDED_DEFAULT}
            minWidth={RAIL_EXPANDED_MIN}
            maxWidth={RAIL_EXPANDED_MAX}
            snapTargets={RAIL_SNAP_TARGETS}
            collapseThreshold={RAIL_COLLAPSE_TRIGGER}
            collapsed={railCollapsed}
            onCollapse={handleCollapse}
            onUncollapse={handleUncollapse}
            presets={RAIL_PRESETS}
            storageKey={STORAGE_RAIL_WIDTH}
            ariaLabel="Resize settings rail"
          />

          {/* Content pane */}
          <div ref={contentRef} style={{
            flex: 1, minWidth: 0,
            padding: '22px 26px',
            overflowY: 'auto',
            position: 'relative',
          }}>
            {searching ? (
              <SearchResultsView
                results={results}
                selected={selResult}
                breadcrumbFor={breadcrumbFor}
                accent={accent}
                onHover={setSelResult}
                onPick={jumpToResult}
              />
            ) : (
              <>
                {activeTab === 'appearance' && <AppearanceTab settings={settings} setSetting={setSetting} setPreviewAccent={setPreviewAccent} accent={accent} resolvedTheme={resolvedTheme}/>}
                {activeTab === 'sounds'     && <SoundsTab     settings={settings} setSetting={setSetting} accent={accent}/>}
                {activeTab === 'navigation' && <NavigationTab settings={settings} setSetting={setSetting} accent={accent} section={addr.section} onSectionChange={(id) => navigateTo({ tab: 'navigation', section: id })}/>}
                {activeTab === 'modules' && (addr.page && (manifests[addr.page] || pagesByModuleId[addr.page])
                  ? <ModulePage
                      manifest={manifests[addr.page]}
                      pageEntry={pagesByModuleId[addr.page] || null}
                      enabled={enabledMap[addr.page] !== false}
                      settings={settings} setSetting={setSetting} accent={accent}
                      section={addr.section}
                      onSectionChange={(id) => navigateTo({ tab: 'modules', page: addr.page, section: id })}
                      onBack={() => navigateTo({ tab: 'modules' })}
                    />
                  : <ModulesTab accent={accent} section={addr.section}
                      onSectionChange={(id) => navigateTo({ tab: 'modules', section: id })}
                      onOpenModule={(id, section) => { const target = manifests[id]?.settingsTarget; if (target && !section) navigateTo(withDefaults(target)); else navigateTo({ tab: 'modules', page: id, section }); }}
                      onOpenKeybinds={(group) => { setKeybindsFilter(group); navigateTo({ tab: 'keybinds' }); }}/>)}
                {activeTab === 'releases' && <ReleasesTab accent={accent} section={addr.section} onSectionChange={(id) => navigateTo({ tab: 'releases', section: id })}/>}
                {activeTab === 'agents'     && <AgentsTab     settings={settings} setSetting={setSetting} accent={accent} section={addr.section} onSectionChange={(id) => navigateTo({ tab: 'agents', section: id })}/>}
                {activeTab === 'keybinds'   && <KeybindsTab   settings={settings} setSetting={setSetting} accent={accent} initialFilter={keybindsFilter} onClearFilter={() => setKeybindsFilter(null)}/>}
                {activeTab === 'vaults'     && <VaultsTab     accent={accent}/>}
                {activeTab === 'system'     && <SystemTab     settings={settings} setSetting={setSetting} accent={accent} section={addr.section} onSectionChange={(id) => navigateTo({ tab: 'system', section: id })}/>}
                {(import.meta.env.DEV || import.meta.env.VITE_DEV_TOOLS === '1') && DevTab && activeTab === 'dev' && (
                  <Suspense fallback={null}><DevTab accent={accent}/></Suspense>
                )}
              </>
            )}
          </div>
      </AppWindow>
  );
}

// ── Releases tab ─────────────────────────────────────────────────────────────

// Standalone home for release Areas that aren't backed by a module (Dock,
// Design, Music, Pomodoro, Shield, Release Pipeline, Settings, System,
// General). Module-backed Areas live on their module's Releases sub-page; this
// tab's strip is the module-LESS subset of the Area palette, built live from
// the manifest registry. Each tile renders the shared per-Area history view.
function ReleasesTab({ accent, section, onSectionChange }) {
  const manifests = useManifests();
  const areas = useMemo(
    () => AREA_PALETTE.filter(a => !moduleIdForArea(a, manifests)),
    [manifests],
  );
  const active = section && areas.includes(section)
    ? section
    : (areas.includes('General') ? 'General' : areas[0]);
  return (
    <div>
      <Topbar
        tiles={areas.map(a => ({ id: a, label: a }))}
        activeId={active}
        accent={accent}
        onSelect={onSectionChange}
        style={{ padding: '0 0 12px', background: 'transparent', marginBottom: 16 }}
      />
      <AreaReleasesView key={active} area={active} accent={accent}/>
    </div>
  );
}

// ── Tab navigation ──────────────────────────────────────────────────────────

function TabButton({ active, accent, onClick, icon: Icon, children, iconOnly = false, updateDot = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={iconOnly ? children : undefined}
      data-own-press
      className={`candy-btn${active ? ' is-active' : ''}`}
      data-shape="row"
      style={{ ...(accent ? { '--accent': accent } : {}), position: 'relative' }}
    >
      {updateDot && (
        <span aria-hidden title="Update available" style={{
          position: 'absolute', top: 6, right: 6, width: 7, height: 7,
          borderRadius: '50%', background: accent || 'var(--accent, #c0392b)',
          boxShadow: '0 0 0 2px var(--surface-2)',
          animation: 'newBadgePulse 2.5s ease-in-out infinite',
          pointerEvents: 'none', zIndex: 2,
        }}/>
      )}
      <span
        className="candy-face"
        style={iconOnly ? { padding: '8px 6px', justifyContent: 'center' } : undefined}
      >
        {Icon && <Icon size={18}/>}
        {!iconOnly && (
          <span style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>{children}</span>
        )}
      </span>
    </button>
  );
}

// ── Header search pill + results view (Feature 2) ───────────────────────────

function SettingsSearchPill({ inputRef, value, onChange, resultCount, onArrow, onEnter }) {
  return (
    <div style={{ position: 'relative', width: 'min(100%, 300px)' }}>
      <span aria-hidden style={{
        position: 'absolute', left: 10, top: 0, bottom: 0,
        display: 'flex', alignItems: 'center',
        color: 'var(--text-faint)', pointerEvents: 'none',
      }}><IconSearch size={14}/></span>
      <input
        ref={inputRef}
        type="text"
        className="candy-input"
        value={value}
        placeholder="Search settings…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); onArrow('down'); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); onArrow('up'); }
          else if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
          // Esc intentionally bubbles to the window listener (clear-then-close).
        }}
        style={{
          width: '100%',
          padding: '7px 28px 7px 30px',
          fontSize: 12,
          color: 'var(--text)',
          fontFamily: 'var(--font-body)',
          outline: 'none',
        }}
      />
      {resultCount > 0 && (
        <span style={{
          position: 'absolute', right: 10, top: 0, bottom: 0,
          display: 'flex', alignItems: 'center',
          fontSize: 10, fontFamily: 'var(--font-mono)',
          color: 'var(--text-faint)', pointerEvents: 'none',
        }}>{resultCount}</span>
      )}
    </div>
  );
}

function SearchResultsView({ results, selected, breadcrumbFor, accent, onHover, onPick }) {
  const accentColor = accent || 'var(--text)';
  if (results.length === 0) {
    return (
      <div style={{
        padding: '14px 16px', fontSize: 12, color: 'var(--text-muted)',
        background: 'var(--surface-2)', border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-md)',
      }}>No settings match.</div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
        marginBottom: 8,
      }}>Search results · {results.length}</div>
      {results.map((e, i) => {
        const sel = i === selected;
        return (
          <button
            key={e.id}
            type="button"
            data-res-idx={i}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(e)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, padding: '9px 12px', textAlign: 'left', cursor: 'pointer',
              border: `1px solid ${sel ? `color-mix(in oklch, ${accentColor} 45%, var(--border))` : 'transparent'}`,
              background: sel ? `color-mix(in oklch, ${accentColor} 10%, var(--surface))` : 'transparent',
              borderRadius: 'var(--radius-md)',
              transition: 'background 80ms ease, border-color 80ms ease',
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)', minWidth: 0 }}>{e.label}</span>
            <span style={{
              fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
              color: 'var(--text-faint)', flexShrink: 0,
            }}>{breadcrumbFor(e)}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Section primitives moved to settings/section-primitives.jsx ─────────────

// ── Tabs ────────────────────────────────────────────────────────────────────

// DownloadsTab moved into settings/SystemTab.jsx (System → Downloads sub-tab).

function AppearanceTab({ settings, setSetting, setPreviewAccent, accent, resolvedTheme }) {
  // Motion master + preset, relocated from the retired Animations tab. The
  // preset writes the whole animations bag; the master reads on if any animation
  // is on, and toggling it flips the full ↔ quiet presets (mirrors the old tab).
  const animPreset = settings.animationsPreset || 'full';
  const animMasterOn = ANIMATION_KEYS.some((k) => {
    const v = (settings.animations || {})[k];
    return ANIMATION_KEY_CONFIG[k] ? v !== 'off' : v !== false;
  });
  const applyAnimPreset = (name) => {
    const bag = ANIMATION_PRESETS[name];
    if (bag) setSetting({ animations: { ...bag }, animationsPreset: name });
  };
  return (
    <>
      <SectionBand title="Color mode">
        <Row label="Mode" anchor="set-themeMode">
          <Seg
            value={settings.themeMode}
            options={[
              { value: 'light',  label: 'Light' },
              { value: 'dark',   label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
            onChange={v => setSetting('themeMode', v)}
            accent={accent}
          />
        </Row>
      </SectionBand>
      <SectionBand title="Themes" anchor="set-themePreset">
        <StackedRow label="Preset">
          <ThemePicker settings={settings} setSetting={setSetting} setPreviewAccent={setPreviewAccent} resolvedTheme={resolvedTheme} />
        </StackedRow>
      </SectionBand>
      <SectionBand title="Accent" anchor="set-accentColor">
        <StackedRow label="Preset" hint="Picks the global accent used across chrome.">
          <AccentGrid value={settings.accentColor} onChange={c => setSetting('accentColor', c)} defaultColor={THEME_BY_ID[settings.themePreset]?.defaultAccent}/>
        </StackedRow>
        <Row label="Custom">
          <HexInput value={settings.accentColor} onChange={c => setSetting('accentColor', c)} accent={accent}/>
        </Row>
      </SectionBand>
      <SectionBand title="Density & shape">
        <Row label="Density" anchor="set-density">
          <Seg
            value={settings.density}
            options={[
              { value: 'compact',     label: 'Compact' },
              { value: 'cozy',        label: 'Cozy' },
              { value: 'comfortable', label: 'Comfort' },
            ]}
            onChange={v => setSetting('density', v)}
            accent={accent}
          />
        </Row>
        <Row label="Radius" anchor="set-radiusScale">
          <Seg
            value={settings.radiusScale}
            options={[
              { value: 'sharp',   label: 'Sharp' },
              { value: 'default', label: 'Default' },
              { value: 'rounded', label: 'Round' },
              { value: 'pill',    label: 'Pill' },
            ]}
            onChange={v => setSetting('radiusScale', v)}
            accent={accent}
          />
        </Row>
      </SectionBand>
      <SectionBand title="Fonts">
        <Row label="Body" anchor="set-fontBody">
          <Seg
            value={settings.fontBody}
            options={SANS_OPTIONS}
            onChange={v => setSetting('fontBody', v)}
            accent={accent}
          />
        </Row>
        <Row label="Headings" anchor="set-fontHeading">
          <Seg
            value={settings.fontHeading}
            options={SANS_OPTIONS}
            onChange={v => setSetting('fontHeading', v)}
            accent={accent}
          />
        </Row>
        <Row label="Mono" anchor="set-fontMono">
          <Seg
            value={settings.fontMono}
            options={MONO_OPTIONS}
            onChange={v => setSetting('fontMono', v)}
            accent={accent}
          />
        </Row>
        <Row label="Candy" anchor="set-fontCandy">
          <Seg
            value={settings.fontCandy}
            options={SANS_OPTIONS}
            onChange={v => setSetting('fontCandy', v)}
            accent={accent}
          />
        </Row>
      </SectionBand>
      <SectionBand title="Sidebar pattern">
        <StackedRow label="Texture" anchor="set-sidebarPattern" hint="A faint line texture painted behind the left + right sidebars. Hover a tile to preview it live on the rails; click to apply. Pure-CSS, so it stays crisp at any rail width and in both themes.">
          <PatternSwatchPicker value={settings.sidebarPattern || 'grid'} onChange={v => setSetting('sidebarPattern', v)} accent={accent} />
        </StackedRow>
      </SectionBand>
      <SectionBand title="Motion">
        <Row label="All animations">
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <EnableToggle
              enabled={animMasterOn}
              accent={accent}
              onChange={() => applyAnimPreset(animMasterOn ? 'quiet' : 'full')}
              title="Master switch — flip all animations on/off"
            />
            <Seg value={animPreset} options={ANIM_PRESET_OPTIONS} onChange={applyAnimPreset} accent={accent}/>
          </div>
        </Row>
        <AnimationField keys={['drawer-modal', 'theme-transition', 'spring-press']} settings={settings} setSetting={setSetting} accent={accent}/>
        <StackedRow label="Scroll smoothness" anchor="set-scrollSmoothness" hint="Eases mouse-wheel scrolling so each notch glides to its target instead of jumping. Trackpads, the editor, and the terminal always scroll natively; OS 'reduce motion' disables it.">
          <Seg value={settings.scrollSmoothness || 'medium'} options={SCROLL_SMOOTHNESS_OPTIONS} onChange={v => setSetting('scrollSmoothness', v)} accent={accent}/>
        </StackedRow>
        <StackedRow label="Preview follow drag" anchor="set-previewFollowDrag" hint="How much the hover-preview card lags behind your cursor as it trails it. None snaps instantly; higher = more drag. Honors the master animations toggle.">
          <Seg value={settings.previewFollowDrag || 'light'} options={FOLLOW_DRAG_OPTIONS} onChange={v => setSetting('previewFollowDrag', v)} accent={accent}/>
        </StackedRow>
      </SectionBand>
      <SectionBand title="Press & depth">
        <StackedRow label="Hover press strength" anchor="set-hoverPressIntensity" hint="How far candy buttons (brand pills, dock icons, transport, tabs, every chip) depress when hovered. 100% = full press, off = no movement.">
          <Seg value={settings.hoverPressIntensity || '50'} options={HOVER_PRESS_OPTIONS} onChange={v => setSetting('hoverPressIntensity', v)} accent={accent}/>
        </StackedRow>
        <StackedRow label="Large button depth" anchor="set-largeButtonDepth" hint="Brand pills, Planner start, Settings tabs, form primitives, chips, segments, rows, CTAs. Default 7px.">
          <Seg value={settings.largeButtonDepth || '7'} options={DEPTH_OPTIONS} onChange={v => setSetting('largeButtonDepth', v)} accent={accent}/>
        </StackedRow>
        <StackedRow label="Small button depth" anchor="set-smallButtonDepth" hint="Dock icons, music transport, Planner reset/skip circles, accent swatches, keycaps, collapsed brand pill. Default 5px.">
          <Seg value={settings.smallButtonDepth || '5'} options={DEPTH_OPTIONS} onChange={v => setSetting('smallButtonDepth', v)} accent={accent}/>
        </StackedRow>
        <StackedRow label="Music tile depth" anchor="set-musicTileDepth" hint="The right-sidebar music player tile's candy press depth. Large inherits Large button depth; Small inherits Small so the tile matches its nested transport circles.">
          <Seg value={settings.musicTileDepth || 'large'} options={MUSIC_TILE_DEPTH_OPTIONS} onChange={v => setSetting('musicTileDepth', v)} accent={accent}/>
        </StackedRow>
        <StackedRow label="Surface depth" anchor="set-surfaceDepth" hint="The static drop-shadow under non-button surfaces — modals, cards, panels, settings sections, inputs. Independent of the button depths. Default Medium.">
          <Seg value={settings.surfaceDepth || 'medium'} options={SURFACE_DEPTH_OPTIONS} onChange={v => setSetting('surfaceDepth', v)} accent={accent}/>
        </StackedRow>
      </SectionBand>
    </>
  );
}

// NavigationTab (Dock / Left Sidebar / Right Sidebar / General sub-tabs) moved
// to settings/NavigationTab.jsx.

// SystemTab (Build + Updates + Downloads + Recycling Bin) moved to
// settings/SystemTab.jsx; the Vault status strip moved to settings/VaultsTab.jsx.

// PulseViewsTab moved to settings/PulseViewsPage.jsx — it now renders as the
// pulse module's settings page under Settings → Modules.

// AccentGrid + HexInput now live in ui/AccentPicker.jsx (shared with the
// Planner Settings tab + planner event modal); imported at the top.

// Slider primitive now lives in ui/Slider.jsx (shared with AgentsTab).


// Full-screen centered settings modal.
//
// Layout: 960px wide, resizable left rail (default 260px) + content pane on the
// right. The rail is the shared candy tree (SettingsNav): Appearance, Sounds,
// Navigation, Modules, Releases, Agents, Keybinds, Vaults, System (+ Dev in dev
// builds only), with every sub-section and module-contributed page as tree
// rows (Settings Tree Navigation, 2026-09-28 — no sub-tab strips, no icon-only
// collapse). Everything is addressed via the drawer-level { tab, page, section }
// address (settings-registry.js); the tree's toolbar field is the settings search.
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
import SystemTab from './settings/SystemTab.jsx';
import { useModuleEnabledMap } from '../hooks/useModuleEnabled.js';
import ModulesTab from './settings/ModulesTab.jsx';
import { AnimationField } from './settings/AnimationRows.jsx';
import { ANIMATION_KEYS, ANIMATION_PRESETS, ANIMATION_KEY_CONFIG, SETTINGS_DEFAULTS, cornerPercent } from '../hooks/useSettings.js';
import SoundsTab from './settings/SoundsTab.jsx';
import NavigationTab from './settings/NavigationTab.jsx';
import AgentsTab from './settings/AgentsTab.jsx';
import KeybindsTab from './settings/KeybindsTab.jsx';
import VaultsTab from './settings/VaultsTab.jsx';
import ThemePicker from './settings/ThemePicker.jsx';
import { THEME_BY_ID } from '../themes/registry.js';
import ResizeSeam, { DRAG_EASE } from './ui/ResizeSeam.jsx';
import SettingsNav from './settings/SettingsNav.jsx';
import {
  IconLayers,
  IconPackage,
  IconSpeaker,
  IconBrush,
  IconWrench,
  IconKeyboard,
  IconDatabase,
  IconCpu,
  IconTag,
  IconPalette,
} from './icons.jsx';
import { Seg, OutlinedBtn, Slider, AppWindow } from './ui/index.js';
import { AccentGrid, HexInput } from './ui/AccentPicker.jsx';
import EnableToggle from './ui/EnableToggle.jsx';
import PatternSwatchPicker from './ui/PatternSwatchPicker.jsx';
import { eyebrowStyle } from './ui/Eyebrow.jsx';

const TABS = [
  { id: 'appearance', label: 'Appearance',  icon: IconPalette },
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
// Starts at the old Wide (user-directed 2026-09-28: the tree rail truncates at
// 180), so the ladder shifted up one: old Default is Compact, max is Wide.
const RAIL_EXPANDED_DEFAULT = 260;
const RAIL_EXPANDED_MIN     = 120;
const RAIL_EXPANDED_MAX     = 320;
// The presets ARE the snap set — ResizeSeam derives it from them.
const RAIL_PRESETS = [
  { label: 'Compact', value: 180 },
  { label: 'Default', value: RAIL_EXPANDED_DEFAULT },
  { label: 'Wide',    value: RAIL_EXPANDED_MAX },
];
// v2: drops every width saved before the default moved, so the new one shows.
const STORAGE_RAIL_WIDTH    = 'settings:railWidth:v2';

function readStoredWidth() {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_RAIL_WIDTH), 10);
    if (Number.isFinite(v) && v >= RAIL_EXPANDED_MIN && v <= RAIL_EXPANDED_MAX) return v;
  } catch {}
  return RAIL_EXPANDED_DEFAULT;
}

// Mirror of App.jsx's editable-target guard so '/' doesn't hijack typing.
function isEditableTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export default function SettingsDrawer({ open, onClose, settings, setSetting, setPreviewAccent, resetSettings, accent, initialAddress }) {
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
  // This rail's width transition is always on (it animates a preset snap), so
  // a drag used to inherit its 200ms and lagged noticeably heavier than every
  // other seam. It runs on ResizeSeam's shared clock while dragging.
  const [railResizing, setRailResizing] = useState(false);

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
  // none. (The pulse → Pulse Views fallback retired with the Planner
  // Consolidation; those rows now live in the Planner module's own tab.)
  const pagesByModuleId = useMemo(() => {
    const map = {};
    for (const pt of moduleTabs) if (!map[pt.moduleId]) map[pt.moduleId] = pt;
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

  // Resolve the landing address on each open: explicit deep link → the
  // current route's settings surface (module page or override)
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
          })
        : null;
      const last = readLastTab();
      setAddr(explicit || ctx?.addr || withDefaults({ tab: validIds.has(last) ? last : 'appearance' }));
      setQuery('');
      setSelResult(0);
      if (!explicit && !ctx) requestAnimationFrame(() => searchRef.current?.focus());
    }
    wasOpen.current = open;
  }, [open, route?.path, manifests, enabledMap, initialAddress]);

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
    // A scope may carry a bag, flat keys, or both — reset every part it names.
    if (resetScope.bag) {
      const fields = {};
      for (const f of resetScope.fields) fields[f] = SETTINGS_DEFAULTS[resetScope.bag][f];
      setSetting(resetScope.bag, fields);
    }
    if (resetScope.keys) resetSettings(resetScope.keys);
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
      {/* Rail — the settings tree. The tree scrolls itself; the rail only sizes. */}
          <div
            style={{
              width: railWidth,
              borderRight: 'var(--candy-frame) solid var(--border)',
              flexShrink: 0,
              display: 'flex', flexDirection: 'column', minHeight: 0,
              background: 'var(--surface-2)',
              overflow: 'hidden',
              transition: railResizing ? `width ${DRAG_EASE}` : 'width 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <SettingsNav
              tabs={visibleTabs}
              addr={{ ...addr, tab: activeTab }}
              onNavigate={(target) => { setQuery(''); navigateTo(target); }}
              pagesByModuleId={pagesByModuleId}
              settings={settings}
              accent={accent}
              updateDot={showUpdateDot}
              onOpenKeybinds={(group) => { setQuery(''); setKeybindsFilter(group); navigateTo({ tab: 'keybinds' }); }}
              query={query}
              onQueryChange={(v) => { setQuery(v); setSelResult(0); }}
              onSearchKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const down = e.key === 'ArrowDown';
                  setSelResult(s => (results.length === 0 ? 0
                    : down ? Math.min(results.length - 1, s + 1) : Math.max(0, s - 1)));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  jumpToResult(results[selResult]);
                }
                // Esc: the field clears itself; the window listener then closes on the next one.
              }}
              searchRef={searchRef}
              results={results}
            />
          </div>

          <ResizeSeam
            width={railWidth}
            onWidthChange={setRailWidth}
            accent={accent}
            defaultWidth={RAIL_EXPANDED_DEFAULT}
            minWidth={RAIL_EXPANDED_MIN}
            maxWidth={RAIL_EXPANDED_MAX}
            onDragStart={() => setRailResizing(true)}
            onDragEnd={() => setRailResizing(false)}
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
                {activeTab === 'appearance' && <AppearanceTab settings={settings} setSetting={setSetting} setPreviewAccent={setPreviewAccent} accent={accent}/>}
                {activeTab === 'sounds'     && <SoundsTab     settings={settings} setSetting={setSetting} accent={accent}/>}
                {activeTab === 'navigation' && <NavigationTab settings={settings} setSetting={setSetting} accent={accent} section={addr.section}/>}
                {activeTab === 'modules' && (addr.page && (manifests[addr.page] || pagesByModuleId[addr.page])
                  ? <ModulePage
                      manifest={manifests[addr.page]}
                      pageEntry={pagesByModuleId[addr.page] || null}
                      enabled={enabledMap[addr.page] !== false}
                      settings={settings} setSetting={setSetting} accent={accent}
                      section={addr.section}
                      onSectionChange={(id) => navigateTo({ tab: 'modules', page: addr.page, section: id })}
                    />
                  : <ModulesTab accent={accent} section={addr.section}/>)}
                {activeTab === 'releases' && <ReleasesTab accent={accent} section={addr.section}/>}
                {activeTab === 'agents'     && <AgentsTab     settings={settings} setSetting={setSetting} accent={accent} section={addr.section}/>}
                {activeTab === 'keybinds'   && <KeybindsTab   settings={settings} setSetting={setSetting} accent={accent} initialFilter={keybindsFilter} onClearFilter={() => setKeybindsFilter(null)}/>}
                {activeTab === 'vaults'     && <VaultsTab     accent={accent}/>}
                {activeTab === 'system'     && <SystemTab     settings={settings} setSetting={setSetting} accent={accent} section={addr.section}/>}
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

// Standalone home for release Areas that aren't backed by a module (Look and
// Feel, Window, Dock & Sidebars, Settings & Everything Else, Smaller fixes and
// polish, General). Module-backed Areas live on their module's Releases sub-page; this
// tab's Areas (rows in the Settings tree) are the module-LESS subset of the Area palette, built live from
// the manifest registry. Each tile renders the shared per-Area history view.
function ReleasesTab({ accent, section }) {
  const manifests = useManifests();
  const areas = useMemo(
    () => AREA_PALETTE.filter(a => !moduleIdForArea(a, manifests)),
    [manifests],
  );
  const active = section && areas.includes(section)
    ? section
    : (areas.includes('General') ? 'General' : areas[0]);
  return <AreaReleasesView key={active} areas={[active]} accent={accent}/>;
}

// ── Search results view (Feature 2) ─────────────────────────────────────────

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
      <div style={{ ...eyebrowStyle, marginBottom: 8 }}>Search results · {results.length}</div>
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

function AppearanceTab({ settings, setSetting, setPreviewAccent, accent }) {
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
      <SectionBand title="Themes" anchor="set-themePreset">
        <StackedRow label="Preset">
          <ThemePicker settings={settings} setSetting={setSetting} setPreviewAccent={setPreviewAccent} />
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
        {/* Corners — one app-wide roundness knob. 0 = square, 100 = every shape
            as round as it goes. Live: the range input fires on drag, so the whole
            app (this drawer included) reshapes under the finger. */}
        <Row label="Corners" anchor="set-radiusScale">
          <Slider
            value={cornerPercent(settings.radiusScale)} min={0} max={100} step={1} unit="%"
            onChange={v => setSetting('radiusScale', v)}
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
        <AnimationField keys={['drawer-modal', 'theme-transition', 'spring-press', 'liquid-hover']} settings={settings} setSetting={setSetting} accent={accent}/>
        <StackedRow label="Preview follow drag" anchor="set-previewFollowDrag" hint="How much the hover-preview card lags behind your cursor as it trails it. None snaps instantly; higher = more drag. Honors the master animations toggle.">
          <Seg value={settings.previewFollowDrag || 'light'} options={FOLLOW_DRAG_OPTIONS} onChange={v => setSetting('previewFollowDrag', v)} accent={accent}/>
        </StackedRow>
      </SectionBand>
      <SectionBand title="Tooltips">
        <StackedRow label="Show tooltips" anchor="set-showTooltips" hint="Labels that pop up when you hover a button. Off = nothing pops up.">
          <EnableToggle enabled={settings.showTooltips !== false} accent={accent} onChange={v => setSetting('showTooltips', v)} title="Show tooltips"/>
        </StackedRow>
      </SectionBand>
      <SectionBand title="Press & depth">
        <StackedRow label="Hover press strength" anchor="set-hoverPressIntensity" hint="How far candy buttons (brand pills, dock icons, transport, tabs, every chip) depress when hovered. 100% = full press, off = no movement.">
          <Seg value={settings.hoverPressIntensity || '50'} options={HOVER_PRESS_OPTIONS} onChange={v => setSetting('hoverPressIntensity', v)} accent={accent}/>
        </StackedRow>
        <StackedRow label="Press speed" anchor="set-pressSpeed" hint="How fast candy buttons press down and spring back, app-wide. 150ms is the slowest; drag lower for a snappier, quicker press.">
          <Slider value={settings.pressSpeed || 70} min={40} max={150} step={10} unit="ms" onChange={v => setSetting('pressSpeed', v)} accent={accent}/>
        </StackedRow>
        <StackedRow label="Press hold" anchor="set-pressHold" hint="How long a candy button stays pressed down before springing back up (separate from press speed). Higher = a longer, more deliberate press dwell.">
          <Slider value={settings.pressHold ?? 70} min={40} max={150} step={10} unit="ms" onChange={v => setSetting('pressHold', v)} accent={accent}/>
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

// PulseViewsTab is gone (Planner Consolidation). Its rows — time format, hour
// height, hour gutter, workout streak — moved into the Planner module's own
// SettingsTab, which owns every surface they affect.

// AccentGrid + HexInput now live in ui/AccentPicker.jsx (shared with the
// Planner Settings tab + planner event modal); imported at the top.

// Slider primitive now lives in ui/Slider.jsx (shared with AgentsTab).


// Primary left nav. Single-content surface driven by useActiveModule():
// brand button at top, the currently-selected module's renderSecondary in
// the body.
//
// Sidebar expansion is decoupled from module selection. The brand-pill toggles
// a `sidebarExpanded` boolean (persisted in localStorage) — collapsing keeps
// the active module selected (dock indicator stays lit, route stays put), just
// shrinks the surface to a 56 px rail. The active module's renderSecondary
// stays MOUNTED at the full saved width inside an absolutely-positioned
// wrapper; the outer container clips it via `overflow: hidden` when collapsed,
// so re-expanding is instant + state is preserved (scroll, expanded folders,
// search input). Hold Shift to peek the expanded layout from a collapsed rail.
//
// Brand-pill click semantics:
//   - Expanded: collapse to 56 px rail; module stays selected.
//   - Collapsed: re-expand with the same module's content.
//
// Module selection lives in useActiveModule; the dock owns its own ordering
// under the unified `dock.order` setting (see components/dock/Dock.jsx).

import { useEffect, useMemo, useState } from 'react';
import { useHashRoute } from '../router.js';
import { useKeybindHold } from '../keybinds/useKeybind.js';
import { useRecentPages } from '../hooks/useRecentPages.js';
import { useRootCounts } from '../hooks/useRootCounts.js';
import { useUpdateStatus } from '../hooks/useUpdateStatus.js';
import { useActiveModule } from '../hooks/useActiveModule.jsx';
import { useSidebarSwap } from '../hooks/useSidebarSwap.js';
import { useManifests, useLeftSidebarSlots, usePageSidebars } from '../module-sdk/useModuleRegistry.js';
import SidebarToggleButton from './SidebarToggleButton.jsx';
import SidebarSeam from './SidebarSeam.jsx';
import SidebarEmptyState from './SidebarEmptyState.jsx';
import RailStack from './sidebar/RailStack.jsx';
import VersionChip from './sidebar/VersionChip.jsx';

const RAIL_WIDTH        = 56;
const EXPANDED_DEFAULT  = 280;
const EXPANDED_MIN      = 200;
const EXPANDED_MAX      = 520;
const COLLAPSE_TRIGGER  = 140;
const SNAP_TARGETS      = [240, 280, 320, 360, 400];
const PRESETS = [
  { label: 'Compact', value: 220 },
  { label: 'Default', value: 280 },
  { label: 'Wide',    value: 400 },
];
const STORAGE_WIDTH_KEY = 'sidebar:width';

// Width thresholds at which sidebar content gains additional surfaces.
const TAGLINE_THRESHOLD  = 360;
const HERO_THRESHOLD     = 440;

function readInitialWidth() {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_WIDTH_KEY), 10);
    if (Number.isFinite(v) && v >= EXPANDED_MIN && v <= EXPANDED_MAX) return v;
  } catch {}
  return EXPANDED_DEFAULT;
}

export default function Sidebar({ accent, settings }) {
  const [width, setWidth] = useState(readInitialWidth);
  const [isResizing, setIsResizing] = useState(false);
  const route = useHashRoute();
  const rootCounts = useRootCounts();
  const manifests = useManifests();
  const rawSlots = useLeftSidebarSlots();
  const pageSidebars = usePageSidebars();
  // A non-module page (e.g. Docs) can claim the sidebar for its route. When it
  // does, it takes priority over the active module below; leaving the route
  // drops back to the (untouched) active module — displace-then-restore.
  const pageSidebar = route.page ? pageSidebars[route.page] : null;
  const slotsByModuleId = useMemo(() => {
    const map = {};
    for (const s of rawSlots) map[s.moduleId] = s;
    return map;
  }, [rawSlots]);
  const {
    activeModuleId, activeModule,
    sidebarExpanded, setSidebarExpanded, toggleSidebarExpanded,
  } = useActiveModule();
  const dockModules = settings?.dock?.modules || {};

  // Modifier-hold-to-peek. Modifier key (default Shift) is sourced from
  // settings.keybinds via the registry; user can rebind from Settings ▸ Keybinds.
  const shiftPeek = useKeybindHold('sidebar.peek-left', settings?.keybinds);

  const effectiveExpanded = sidebarExpanded || shiftPeek;

  const handleBrandClick = () => {
    toggleSidebarExpanded();
  };

  const renderedWidth = effectiveExpanded ? width : RAIL_WIDTH;
  const seamMounted = effectiveExpanded;
  // The SwapContainer is rendered at full saved width inside an absolutely
  // positioned wrapper, so it stays mounted even when the outer sidebar clips
  // to the 56 px rail. Only skip mounting entirely when there's nothing to
  // show (no module and the user hasn't peeked the rail open).
  const bodyMounted = !!activeModuleId || !!pageSidebar || effectiveExpanded;

  return (
    <div style={{
      position: 'relative',
      width: renderedWidth,
      flexShrink: 0,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      transition: isResizing ? 'none' : 'width 180ms ease',
      zIndex: 50,
    }}>
      {/* Full-rail background-texture backdrop, mirrored from the right rail
          (flipped gradient angle/origin). z-index:-1 sits it behind all rail
          content; hidden when collapsed. */}
      {effectiveExpanded && (
        <div className="sidebar-pattern-mirror" aria-hidden="true" style={{
          position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none',
        }}/>
      )}
      <SidebarHeader
        expanded={effectiveExpanded}
        accent={accent}
        onToggle={handleBrandClick}
        settings={settings}
        sidebarWidth={renderedWidth}
      />

      <div style={{
        flex: 1, minHeight: 0,
        position: 'relative',
        display: 'flex', flexDirection: 'column',
      }}>
        {bodyMounted && (
          <>
            <div style={{
              position: 'absolute',
              top: 0, bottom: 0, left: 0,
              width,
              display: 'flex', flexDirection: 'column',
              borderTop: '1px solid var(--border)',
              marginTop: 4,
              opacity: effectiveExpanded ? 1 : 0,
              pointerEvents: effectiveExpanded ? 'auto' : 'none',
              transition: isResizing ? 'none' : 'opacity 180ms ease',
            }}>
              {pageSidebar ? (
                <PageSecondary pageSidebar={pageSidebar} route={route} accent={accent} />
              ) : (
                <SwapContainer
                  activeModuleId={activeModuleId}
                  manifests={manifests}
                  slotsByModuleId={slotsByModuleId}
                  route={route}
                  accent={accent}
                  sidebarWidth={width}
                  rootCounts={rootCounts}
                  slideDuration={dockModules.slideDuration ?? 260}
                />
              )}
            </div>
            {(pageSidebar || activeModuleId) && (
              <div style={{
                position: 'absolute',
                top: 0, bottom: 0, left: 0,
                width: RAIL_WIDTH,
                display: 'flex', flexDirection: 'column',
                borderTop: '1px solid var(--border)',
                marginTop: 4,
                opacity: effectiveExpanded ? 0 : 1,
                pointerEvents: effectiveExpanded ? 'none' : 'auto',
                transition: isResizing ? 'none' : 'opacity 180ms ease',
              }}>
                {pageSidebar ? (
                  <RailStack
                    slot={pageSidebar.renderRail ? { renderRail: pageSidebar.renderRail } : null}
                    manifest={{ name: pageSidebar.label }}
                    accent={accent}
                  />
                ) : (
                  <RailStack
                    slot={slotsByModuleId[activeModuleId]}
                    manifest={manifests[activeModuleId]}
                    accent={accent}
                  />
                )}
              </div>
            )}
            <div style={{
              position: 'absolute',
              bottom: 0, left: 0,
              width: RAIL_WIDTH,
              display: 'flex', justifyContent: 'center',
              opacity: effectiveExpanded ? 0 : 1,
              pointerEvents: effectiveExpanded ? 'none' : 'auto',
              transition: isResizing ? 'none' : 'opacity 180ms ease',
            }}>
              <VersionChip />
            </div>
          </>
        )}
      </div>

      {seamMounted && (
        <div style={{
          position: 'absolute',
          top: 0, bottom: 0, right: 0,
          display: 'flex',
          zIndex: 70,
        }}>
          <SidebarSeam
            width={width}
            onWidthChange={setWidth}
            accent={accent}
            defaultWidth={EXPANDED_DEFAULT}
            minWidth={EXPANDED_MIN}
            maxWidth={EXPANDED_MAX}
            snapTargets={SNAP_TARGETS}
            collapseThreshold={COLLAPSE_TRIGGER}
            onCollapse={() => setSidebarExpanded(false)}
            onDragStart={() => setIsResizing(true)}
            onDragEnd={() => setIsResizing(false)}
            presets={PRESETS}
            storageKey={STORAGE_WIDTH_KEY}
            edgeRingSide="right"
            ariaLabel="Resize sidebar"
          />
        </div>
      )}

    </div>
  );
}

function SidebarHeader({ expanded, accent, onToggle, settings, sidebarWidth }) {
  const showTagline = expanded && sidebarWidth > TAGLINE_THRESHOLD;
  const button = <SidebarToggleButton accent={accent} expanded={expanded} onToggle={onToggle} showTagline={showTagline}/>;
  return (
    <div style={{
      position: 'relative',
      padding: 0,
      height: 'var(--brand-section-h)',
      display: 'flex',
      alignItems: 'flex-start',
      flexShrink: 0,
    }}>
      {button}
      <BrandUpdateDot accent={accent} settings={settings} />
    </div>
  );
}

function BrandUpdateDot({ accent, settings }) {
  const { available } = useUpdateStatus();
  if (!available) return null;
  if (settings?.dev?.autoCheckUpdates === false) return null;
  const accentColor = accent || 'var(--accent, #c0392b)';
  return (
    <span
      aria-hidden="true"
      title="Update available — open Settings → System to install"
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: accentColor,
        boxShadow: `0 0 0 2px var(--surface), 0 0 0 3px color-mix(in oklch, ${accentColor} 55%, transparent)`,
        animation: 'newBadgePulse 2.5s ease-in-out infinite',
        pointerEvents: 'none',
        zIndex: 60,
      }}
    />
  );
}

// Page sidebar surface. Non-module pages (e.g. Docs) registered via
// registerPageSidebar render their secondary content here. Deliberately
// bypasses SwapContainer/useSidebarSwap (no module id to key the swap on) and
// the module hero card — a plain scroll column matching SwapLayer's overflow.
function PageSecondary({ pageSidebar, route, accent }) {
  return (
    <div style={{
      flex: 1, minHeight: 0,
      display: 'flex', flexDirection: 'column',
      overflowY: 'auto', overflowX: 'hidden',
    }}>
      {pageSidebar.renderSecondary?.({ route, accent })}
    </div>
  );
}

// Layered module-swap surface. Driven by useSidebarSwap (two stable slots,
// each keeps its module mounted across the role transition). Empty case
// (no active module) bypasses the slot model and renders SidebarEmptyState
// directly — no animation, since the sidebar's own collapse/expand handles
// the visual transition.
function SwapContainer({ activeModuleId, manifests, slotsByModuleId, route, accent, sidebarWidth, rootCounts, slideDuration }) {
  const { slots, outMs, inMs, overlapMs } = useSidebarSwap({
    activeModuleId,
    slideDuration,
  });

  if (!activeModuleId && !slots.A && !slots.B) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <SecondaryBody
          manifest={null}
          slot={null}
          route={route}
          accent={accent}
          sidebarWidth={sidebarWidth}
          rootCounts={rootCounts}
        />
      </div>
    );
  }

  return (
    <div style={{
      position: 'relative',
      flex: 1, minHeight: 0,
      overflow: 'hidden',
    }}>
      {['A', 'B'].map(key => {
        const swapSlot = slots[key];
        if (!swapSlot) return null;
        return (
          <SwapLayer
            key={key}
            slot={swapSlot}
            outMs={outMs}
            inMs={inMs}
            overlapMs={overlapMs}
          >
            <SecondaryBody
              manifest={manifests[swapSlot.moduleId]}
              slot={slotsByModuleId[swapSlot.moduleId]}
              route={route}
              accent={accent}
              sidebarWidth={sidebarWidth}
              rootCounts={rootCounts}
            />
          </SwapLayer>
        );
      })}
    </div>
  );
}

function SwapLayer({ slot, outMs, inMs, overlapMs, children }) {
  const { role } = slot;
  const enteringDelay = role === 'entering' && overlapMs < outMs ? Math.max(0, outMs - overlapMs) : 0;
  const animation = (() => {
    if (role === 'static') return 'none';
    const prefix = 'sidebarSwapUp';
    if (role === 'entering') {
      return `${prefix}In ${inMs}ms cubic-bezier(0.4, 0, 0.2, 1) ${enteringDelay}ms 1 normal both`;
    }
    return `${prefix}Out ${outMs}ms cubic-bezier(0.4, 0, 0.2, 1) 0ms 1 normal forwards`;
  })();
  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      overflowX: 'hidden',
      transformOrigin: 'top center',
      backfaceVisibility: 'hidden',
      willChange: role === 'static' ? 'auto' : 'transform',
      animation,
      pointerEvents: role === 'exiting' ? 'none' : 'auto',
    }}>
      {children}
    </div>
  );
}

function SecondaryBody({ manifest, slot, route, accent, sidebarWidth, rootCounts }) {
  if (!manifest) {
    return <SidebarEmptyState activeModule={null} accent={accent}/>;
  }
  const renderSecondary = slot?.renderSecondary;
  return (
    <>
      {sidebarWidth > HERO_THRESHOLD && (
        <SecondaryHeroCard activeModule={manifest} rootCounts={rootCounts} accent={accent}/>
      )}
      {renderSecondary
        ? renderSecondary({ route, accent })
        : <SidebarEmptyState activeModule={manifest} accent={accent}/>}
    </>
  );
}

function SecondaryHeroCard({ activeModule, rootCounts }) {
  const { recent } = useRecentPages(40);
  const label = activeModule.name || activeModule.label || '';
  const count = rootCounts?.[label];
  const lastVisit = recent.find(r => {
    const decoded = (() => { try { return decodeURIComponent(r.path); } catch { return r.path; } })();
    return decoded.includes(`/page/${label}/`);
  });
  const visitedAgo = lastVisit ? humanizeRecent(lastVisit.visitedAt) : null;
  return (
    <div className="candy-card" style={{
      margin: '8px 12px 4px',
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      textAlign: 'center',
      animation: 'fadeIn 0.2s ease',
    }}>
      <div style={{
        fontSize: 8, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.12em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 700, opacity: 0.9,
      }}>Section</div>
      <div style={{
        fontSize: 14, fontWeight: 700, color: 'var(--text)',
        letterSpacing: '-0.005em',
      }}>{label}</div>
      <div style={{
        fontSize: 10.5, fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)', display: 'flex', gap: 10,
        marginTop: 2,
      }}>
        {typeof count === 'number' && <span>{count.toLocaleString()} pages</span>}
        {visitedAgo && (
          <>
            {typeof count === 'number' && <span style={{ color: 'var(--text-faint)' }}>·</span>}
            <span>last visit {visitedAgo}</span>
          </>
        )}
      </div>
    </div>
  );
}

function humanizeRecent(ts) {
  if (!ts) return null;
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const seconds = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

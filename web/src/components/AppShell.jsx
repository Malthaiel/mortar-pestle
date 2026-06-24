import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { navigate, useHashRoute } from '../router.js';
import { useWidgetSlots, useOverlays } from '../module-sdk/useModuleRegistry.js';
import { useSidebarOrder, applyOrder, emitSidebarOrderChange } from '../hooks/useSidebarOrder.js';
import Sidebar from './Sidebar.jsx';
import Breadcrumb from './Breadcrumb.jsx';
import DraggableSidebarList from './DraggableSidebarList.jsx';
import ToolkitToggleButton from './ToolkitToggleButton.jsx';
import RightRailStack from './sidebar/RightRailStack.jsx';
import SidebarSeam from './SidebarSeam.jsx';
import { useToolkitExpanded } from '../hooks/useToolkitExpanded.js';
import { useKeybindHold } from '../keybinds/useKeybind.js';

const WIDGET_ORDER_KEY = 'widgets:order';

const TOOLKIT_RAIL_WIDTH      = 56;
const TOOLKIT_WIDTH_DEFAULT   = 300;
const TOOLKIT_WIDTH_MIN       = 240;
const TOOLKIT_WIDTH_MAX       = 480;
const TOOLKIT_SNAP_TARGETS    = [260, 300, 340, 380, 420];
const TOOLKIT_PRESETS = [
  { label: 'Compact', value: 260 },
  { label: 'Default', value: 300 },
  { label: 'Wide',    value: 400 },
];
const STORAGE_TOOLKIT_WIDTH = 'toolkit:width:v1';

function readInitialToolkitWidth() {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_TOOLKIT_WIDTH), 10);
    if (Number.isFinite(v) && v >= TOOLKIT_WIDTH_MIN && v <= TOOLKIT_WIDTH_MAX) return v;
  } catch {}
  return TOOLKIT_WIDTH_DEFAULT;
}

const ROOT_DEFAULTS = {};

const LEGACY_REDIRECTS = [
  { match: /^\/pomodoro\/(timer|analytics|notes)\/?$/, to: () => '/pulse/calendar' },
  { match: /^\/pomodoro\/?$/,                          to: '/pulse/calendar' },
  { match: /^\/pulse\/timer\/?$/,                      to: '/pulse/calendar' },
  { match: /^\/pulse\/analytics\/?$/,                  to: '/pulse/calendar' },
  { match: /^\/pulse\/notes\/?$/,                      to: '/pulse/calendar' },
  { match: /^\/vital-systems\/vault\/?$/,              to: '/infrastructure/update-queue' },
  { match: /^\/vital-systems\/projects\/?$/,           to: '/pulse/today' },
  { match: /^\/vital-systems(\/.*)?$/,                 to: (m) => '/pulse' + (m[1] || '/today') },
];

function applyLegacyRedirect(path) {
  for (const r of LEGACY_REDIRECTS) {
    const m = path.match(r.match);
    if (m) return typeof r.to === 'function' ? r.to(m) : r.to;
  }
  return null;
}

export default function AppShell({ children, onOpenSettings, settingsOpen, accent, settings }) {
  const rawWidgets = useWidgetSlots();
  const overlays = useOverlays();
  const { order: savedRightOrder } = useSidebarOrder(WIDGET_ORDER_KEY);
  const [localRightOrder, setLocalRightOrder] = useState(null);
  const rightOrderToUse = localRightOrder ?? savedRightOrder;
  // Widgets are keyed/ordered by slot id, not module id — a module may register
  // several widgets (the planner registers four). The two pre-pivot persisted
  // ids ('library', 'planner') stay valid: slot id == module id for both.
  const rightSlots = applyOrder(rawWidgets, rightOrderToUse, s => s.id);
  const { expanded: toolkitExpanded, toggle: toggleToolkit } = useToolkitExpanded();
  // Right-sidebar hold-to-peek. Modifier key sourced from settings.keybinds
  // (default Alt). When the user is already toggled-open, hold is a no-op.
  const peekRight = useKeybindHold('sidebar.peek-right', settings?.keybinds);
  const peekActive = peekRight && !toolkitExpanded;
  const effectiveToolkitExpanded = toolkitExpanded || peekActive;
  const [toolkitWidth, setToolkitWidth] = useState(readInitialToolkitWidth);
  const [isResizingToolkit, setIsResizingToolkit] = useState(false);

  const route = useHashRoute();
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (redirectedRef.current) return;

    const legacyTarget = applyLegacyRedirect(route.path || '');
    if (legacyTarget) {
      redirectedRef.current = true;
      navigate(legacyTarget);
      setTimeout(() => { redirectedRef.current = false; }, 0);
      return;
    }

    if (route.page && ROOT_DEFAULTS[route.page] && !route.sub) {
      redirectedRef.current = true;
      navigate(ROOT_DEFAULTS[route.page]);
      setTimeout(() => { redirectedRef.current = false; }, 0);
      return;
    }

    if (!route.page) {
      redirectedRef.current = true;
      navigate('/vault');
      setTimeout(() => { redirectedRef.current = false; }, 0);
    }
  }, [route.page, route.sub]);

  const accentColor = accent || 'var(--text)';

  return (
    <div style={{
      display: 'flex',
      // Reserve the flush bottom dock's height app-wide: the sidebars, content
      // pane, and every page scroller end at the dock's top edge, so nothing
      // hides behind the bar and the browser's native view sits flush above it.
      height: 'calc(100vh - var(--dock-height))',
      width: '100vw',
      background: 'var(--bg)', color: 'var(--text)', overflow: 'hidden',
    }}>
      <Sidebar
        accent={accent}
        onOpenSettings={onOpenSettings}
        settingsActive={settingsOpen}
        settings={settings}
      />
      <div style={{
        flex: 1, minWidth: 0, minHeight: 0,
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
        position: 'relative', zIndex: 1,
      }}>
        <Breadcrumb route={route} accent={accent}/>
        {children}
      </div>
      {rightSlots.length > 0 && effectiveToolkitExpanded && (
        <SidebarSeam
          width={toolkitWidth}
          onWidthChange={setToolkitWidth}
          accent={accentColor}
          defaultWidth={TOOLKIT_WIDTH_DEFAULT}
          minWidth={TOOLKIT_WIDTH_MIN}
          maxWidth={TOOLKIT_WIDTH_MAX}
          snapTargets={TOOLKIT_SNAP_TARGETS}
          presets={TOOLKIT_PRESETS}
          storageKey={STORAGE_TOOLKIT_WIDTH}
          ariaLabel="Resize right sidebar"
          edgeRingSide="right"
          inverted
          onDragStart={() => setIsResizingToolkit(true)}
          onDragEnd={() => setIsResizingToolkit(false)}
        />
      )}
      {rightSlots.length > 0 && (
        <div style={{
          width: effectiveToolkitExpanded ? toolkitWidth : TOOLKIT_RAIL_WIDTH,
          flexShrink: 0,
          position: 'relative',
          isolation: 'isolate',
          borderLeft: '1px solid var(--border)',
          background: 'var(--surface)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          transition: isResizingToolkit ? 'none' : 'width 180ms ease',
        }}>
          {/* Full-rail background-texture backdrop (one origin for the radial
              arcs motif; fixed, doesn't scroll). Hidden on the collapsed rail. */}
          {effectiveToolkitExpanded && (
            <div className="sidebar-pattern" aria-hidden="true" style={{
              position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none',
            }}/>
          )}
          <div style={{
            padding: 0,
            height: 'var(--brand-section-h)',
            display: 'flex',
            alignItems: 'flex-start',
            flexShrink: 0,
          }}>
            <ToolkitToggleButton
              accent={accentColor}
              expanded={effectiveToolkitExpanded}
              onToggle={toggleToolkit}
            />
          </div>
          {effectiveToolkitExpanded ? (
            <DraggableSidebarList
              items={rightSlots}
              keyExtractor={(slot) => slot.moduleId + ':' + slot.id}
              // 10px breathing room above the first module (below the toggle-
              // header divider). No inter-tile gap — tiles sit flush, so the
              // un-animated flex gap can't "pop in" when a drop-glide ends.
              style={{ flex: 1, minHeight: 0, paddingTop: 10 }}
              getItemStyle={(slot) => {
                const fw = slot.flexWeight;
                return {
                  flex: fw === 0 || fw === '0' ? '0 0 auto' : (fw ?? 1),
                  minHeight: 0,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  // No divider between expanded module tiles — the 10px container
                  // gap separates them; a border read as extra push-apart.
                };
              }}
              renderItem={(slot) => slot.render()}
              onReorder={(from, to) => {
                const ids = rightSlots.map(s => s.id);
                if (to === from || to === from + 1) return;
                const adjustedTo = from < to ? to - 1 : to;
                const next = ids.slice();
                const [moved] = next.splice(from, 1);
                next.splice(adjustedTo, 0, moved);
                setLocalRightOrder(next);
                api.setSidebarOrder(WIDGET_ORDER_KEY, next)
                  .then(() => {
                    emitSidebarOrderChange(WIDGET_ORDER_KEY);
                    window.dispatchEvent(new CustomEvent('agentic:sidebar-row-persisted', {
                      detail: { key: WIDGET_ORDER_KEY, id: moved },
                    }));
                  })
                  .catch(() => {});
              }}
            />
          ) : (
            <RightRailStack rightSlots={rightSlots} accent={accentColor}/>
          )}
        </div>
      )}
      {overlays.map(({ Component, moduleId }) => <Component key={moduleId}/>)}
    </div>
  );
}


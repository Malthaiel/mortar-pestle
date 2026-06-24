// Modules settings tab. Four tier tiles (Core / Studio / Widget / Community)
// bucket every module into exactly one home: studio-tier → Studio; widget-only
// modules (no route / left-sidebar / overlay surface) → Widget; everything
// else → Core; Community is reserved for the future third-party registry.
// Each module renders as a card: icon, name, version, tier badge, manifest
// description, bundle size (build-emitted module-sizes.json; "—" in dev), an
// Install/Uninstall action (the modules.<id>.enabled flag relabeled — module
// settings and data are always preserved), and a settings cog (page
// navigation lands with module pages).
//
// Uninstalling a dirty module still confirms first; Install is immediate.
// Drag-reorder persists per tier via sidebar-order key 'modules:tier-<tier>'.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useManifests } from '../../module-sdk/useModuleRegistry.js';
import { useDragReorder } from '../../module-sdk/useDragReorder.js';
import { useSidebarOrder, applyOrder, emitSidebarOrderChange } from '../../hooks/useSidebarOrder.js';
import { useDropPulse, SIDEBAR_ROW_PULSE_STYLE } from '../../hooks/useDropPulse.js';
import {
  useModuleEnabledMap,
  useDirtyModules,
  setModuleEnabled,
} from '../../hooks/useModuleEnabled.js';
import * as hostIcons from '../icons.jsx';
import { IconGrip, IconSettings, IconTag } from '../icons.jsx';
import { Topbar } from '../ui/index.js';
import { TAB_SECTIONS, tierOf } from './settings-registry.js';
import { getFullRegistry } from '../../keybinds/registry.js';
import ToolsPanel from './ToolsPanel.jsx';

// Build-emitted per-module bundle sizes. Dev has no build, so every card
// shows "—" there; packaged builds fetch module-sizes.json from the bundle.
function useModuleSizes() {
  const [sizes, setSizes] = useState(null);
  useEffect(() => {
    // EXACT form — define-replaced, so the fetch only ships in prod bundles.
    if (import.meta.env.DEV) return;
    fetch('module-sizes.json')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setSizes(d?.sizes || null))
      .catch(() => {});
  }, []);
  return sizes;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `~${Math.round(n / 1024)} KB`;
  return `~${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ModulesTab({ accent, section, onSectionChange, onOpenModule, onOpenKeybinds }) {
  const active = section || TAB_SECTIONS.modules.default;
  return (
    <div>
      <Topbar
        tiles={TAB_SECTIONS.modules.sections.map(s => ({ id: s.id, label: s.label }))}
        activeId={active}
        accent={accent}
        onSelect={onSectionChange}
        style={{ padding: '0 0 12px', background: 'transparent', marginBottom: 16 }}
      />
      {active === 'community' ? <CommunityPanel/>
        : active === 'tools' ? <ToolsPanel accent={accent}/>
        : <TierPanel key={active} tier={active} accent={accent} onOpenModule={onOpenModule} onOpenKeybinds={onOpenKeybinds}/>}
    </div>
  );
}

function TierPanel({ tier, accent, onOpenModule, onOpenKeybinds }) {
  const manifests = useManifests();
  const enabledMap = useModuleEnabledMap();
  const dirty = useDirtyModules();
  const sizes = useModuleSizes();
  const orderKey = `modules:tier-${tier}`;
  const { order: savedOrder } = useSidebarOrder(orderKey);
  const [localOrder, setLocalOrder] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null);

  const tierModules = useMemo(() => {
    const arr = Object.values(manifests).filter(m => tierOf(m) === tier);
    arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [manifests, tier]);

  const ordered = useMemo(
    () => localOrder || applyOrder(tierModules, savedOrder, m => m.id),
    [tierModules, savedOrder, localOrder],
  );

  const handleReorder = useCallback((fromIndex, toIndex) => {
    const next = ordered.slice();
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item);
    setLocalOrder(next);
    api.setSidebarOrder(orderKey, next.map(m => m.id))
      .then(() => {
        emitSidebarOrderChange(orderKey);
        window.dispatchEvent(new CustomEvent('agentic:sidebar-row-persisted', {
          detail: { key: orderKey, id: item.id },
        }));
      })
      .catch(() => {});
  }, [ordered, orderKey]);

  const pulsingModuleId = useDropPulse(orderKey);
  const { dragIndex, dropTarget, rowProps, containerProps } = useDragReorder({ onReorder: handleReorder });

  const handleSetEnabled = useCallback((moduleId, nextEnabled) => {
    if (!nextEnabled && dirty.has(moduleId)) {
      setConfirmTarget(moduleId);
      return;
    }
    setModuleEnabled(moduleId, nextEnabled);
  }, [dirty]);

  if (tierModules.length === 0) {
    return <TierEmptyState tier={tier}/>;
  }

  return (
    <>
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        {...containerProps}
      >
        {ordered.map((m, i) => {
          const pulsing = pulsingModuleId === m.id;
          return (
            <div
              key={m.id}
              style={{
                animation: pulsing ? SIDEBAR_ROW_PULSE_STYLE : undefined,
                borderRadius: pulsing ? 8 : undefined,
              }}
            >
              <ModuleCard
                manifest={m}
                enabled={enabledMap[m.id] !== false}
                size={sizes?.[m.id]}
                dragging={dragIndex === i}
                dropTopHere={dropTarget?.index === i && dropTarget.side === 'top'}
                dropBottomHere={dropTarget?.index === i && dropTarget.side === 'bottom'}
                accent={accent}
                onSetEnabled={(v) => handleSetEnabled(m.id, v)}
                onOpenSettings={() => onOpenModule?.(m.id)}
                onOpenReleases={() => onOpenModule?.(m.id, 'releases')}
                onOpenKeybinds={() => onOpenKeybinds?.(m.name)}
                {...rowProps(i)}
              />
            </div>
          );
        })}
      </div>

      {confirmTarget && (
        <ConfirmUninstall
          manifest={manifests[confirmTarget]}
          accent={accent}
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => {
            setModuleEnabled(confirmTarget, false);
            setConfirmTarget(null);
          }}
        />
      )}
    </>
  );
}

function TierEmptyState({ tier }) {
  const box = {
    padding: '14px 16px',
    background: 'var(--surface-2)',
    border: '1px dashed var(--border)',
    borderRadius: 'var(--radius-md)',
    fontSize: 12, lineHeight: 1.5,
    color: 'var(--text-muted)',
  };
  if (tier === 'widget') {
    return (
      <div style={box}>
        Standalone widgets are right-sidebar tiles that ship without a full module
        around them. None exist yet — the first ones arrive with the widget
        marketplace.{' '}
        <span style={{ color: 'var(--text-faint)' }}>
          Modules that contribute widgets (Planner, Library) live under Core.
        </span>
      </div>
    );
  }
  if (tier === 'studio') {
    return <div style={box}>No Studio modules in this build.</div>;
  }
  return (
    <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '6px 0' }}>
      (no modules in this tier)
    </div>
  );
}

function CommunityPanel() {
  return (
    <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '6px 0' }}>TBD</div>
  );
}

function ModuleCard({
  manifest, enabled, size, dragging,
  dropTopHere, dropBottomHere, accent,
  onSetEnabled, onOpenSettings, onOpenReleases, onOpenKeybinds,
  onDragStart, onDragOver, onDrop, onDragEnd,
}) {
  const [hover, setHover] = useState(false);
  const accentColor = accent || 'var(--text)';
  const Icon = manifest.iconKey ? hostIcons[manifest.iconKey] : null;
  // "Keybinds →" appears only when the registry has a group named after this
  // module (modules register keybinds under their display name).
  const hasKeybinds = useMemo(() => getFullRegistry().some(e => e.group === manifest.name), [manifest.name]);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="candy-section"
      data-module-card={manifest.id}
      data-search-anchor={`module-card-${manifest.id}`}
      style={{
        position: 'relative',
        display: 'flex', alignItems: 'flex-start', gap: 12,
        padding: '13px 15px',
        cursor: 'grab',
        opacity: dragging ? 0.55 : (enabled ? 1 : 0.55),
        transition: 'opacity 80ms ease',
      }}
    >
      <span style={{
        width: 16, alignSelf: 'center',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-faint)',
        opacity: hover || dragging ? 1 : 0.3,
        cursor: 'grab',
        transition: 'opacity 120ms ease',
        flexShrink: 0,
      }}>
        <IconGrip size={14}/>
      </span>

      <span style={{
        width: 34, height: 34, borderRadius: 'var(--radius-md)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface-2)', color: 'var(--text-muted)',
        flexShrink: 0, alignSelf: 'center',
      }}>
        {Icon
          ? <Icon size={18}/>
          : <span style={{ fontSize: 13, fontWeight: 600 }}>{manifest.name[0]}</span>}
      </span>

      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{
            fontSize: 13.5, fontWeight: 600, color: 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{manifest.name}</span>
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-faint)', flexShrink: 0,
          }}>v{manifest.version}</span>
          <TierBadge tier={manifest.tier} accent={accentColor}/>
        </span>
        {manifest.description && (
          <span style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)' }}>
            {manifest.description}
          </span>
        )}
        <span style={{
          fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
          color: 'var(--text-faint)',
        }}>
          Size: {fmtBytes(size)}{!enabled && ' · not installed'}
        </span>
        {hasKeybinds && (
          <button
            type="button"
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            onClick={onOpenKeybinds}
            style={{
              alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0,
              fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
              color: accentColor, cursor: 'pointer',
            }}
          >Keybinds →</button>
        )}
      </span>

      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, alignSelf: 'center' }}>
        <CardIconBtn
          title="Releases"
          accent={accentColor}
          onClick={onOpenReleases}
        >
          <IconTag size={15}/>
        </CardIconBtn>
        <CardIconBtn
          title="Module settings"
          accent={accentColor}
          onClick={onOpenSettings}
        >
          <IconSettings size={15}/>
        </CardIconBtn>
        <CardActionBtn
          accent={accentColor}
          label={enabled ? 'Uninstall' : 'Install'}
          emphasize={!enabled}
          onClick={() => onSetEnabled(!enabled)}
        />
      </span>

      {dropTopHere && <DropIndicator side="top" accent={accentColor}/>}
      {dropBottomHere && <DropIndicator side="bottom" accent={accentColor}/>}
    </div>
  );
}

// Buttons inside a draggable card opt out of HTML5 drag arming so a press
// never starts a card drag.
function CardActionBtn({ label, accent, onClick, emphasize }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      data-own-press
      draggable={false}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      className={'candy-btn' + (emphasize ? ' is-active' : '')}
      data-shape="row"
      style={{ '--accent': accent, width: 'auto', flexShrink: 0 }}
    >
      <span className="candy-face" style={{
        justifyContent: 'center',
        padding: '6px 12px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
      }}>{label}</span>
    </button>
  );
}

function CardIconBtn({ title, accent, disabled, onClick, children }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      data-own-press
      disabled={disabled}
      title={title}
      draggable={false}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      className="candy-btn"
      data-shape="row"
      style={{ '--accent': accent, width: 'auto', flexShrink: 0 }}
    >
      <span className="candy-face" style={{ justifyContent: 'center', padding: '7px 9px' }}>
        {children}
      </span>
    </button>
  );
}

function TierBadge({ tier, accent }) {
  const palette = {
    core:    { bg: 'var(--surface-2)', fg: 'var(--text-muted)' },
    free:    { bg: 'var(--surface-2)', fg: 'var(--text-muted)' },
    studio:  { bg: `color-mix(in oklch, ${accent} 18%, transparent)`, fg: accent },
  };
  const { bg, fg } = palette[tier] || palette.core;
  return (
    <span style={{
      fontSize: 9, fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '2px 6px',
      borderRadius: 'var(--radius-sm)',
      background: bg,
      color: fg,
      flexShrink: 0,
    }}>{tier}</span>
  );
}

function DropIndicator({ side, accent }) {
  return (
    <span aria-hidden style={{
      position: 'absolute',
      left: 8, right: 8,
      top: side === 'top' ? -1 : 'auto',
      bottom: side === 'bottom' ? -1 : 'auto',
      height: 2,
      background: accent,
      borderRadius: 1,
      boxShadow: `0 0 0 3px color-mix(in oklch, ${accent} 22%, transparent)`,
      pointerEvents: 'none',
    }}/>
  );
}

function ConfirmUninstall({ manifest, accent, onCancel, onConfirm }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div onClick={onCancel} style={{
        position: 'absolute', inset: 0,
        background: 'rgba(0,0,0,0.52)',
      }}/>
      <div style={{
        position: 'relative',
        width: 380,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: '20px 22px',
        boxShadow: 'var(--shadow-card)',
      }}>
        <div style={{
          fontSize: 14, fontWeight: 600,
          color: 'var(--text)',
          marginBottom: 8,
        }}>Uninstall {manifest?.name || 'module'}?</div>
        <div style={{
          fontSize: 12, lineHeight: 1.5,
          color: 'var(--text-muted)',
          marginBottom: 18,
        }}>
          This module is currently active — uninstalling now will discard its
          in-progress state. Settings and data stay on disk; Install brings it back.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              appearance: 'none',
              padding: '6px 14px',
              fontSize: 12,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            onClick={onConfirm}
            style={{
              appearance: 'none',
              padding: '6px 14px',
              fontSize: 12,
              borderRadius: 'var(--radius-md)',
              border: 0,
              background: accent,
              color: '#ffffff',
              cursor: 'pointer',
            }}
          >Uninstall</button>
        </div>
      </div>
    </div>
  );
}

// Secondary-nav rail rendered inside the primary Sidebar's hover-overlay.
//
// Layout: a single vertical scrolling column of caption-treated groups whose
// items are 32px rows with leading status dot, accent-tinted when selected.
// Used to be a two-pane layout (left rail + right content pane); after the
// secondary-sidebar merge the content pane is just the main route area, so
// SidebarNav no longer wraps children — it's nav only.
//
// Group collapse modes (controlled by global `sidebarGroupMode` setting):
//   - 'expanded'    — every group shows items, header is non-interactive
//   - 'accordion'   — one group expanded at a time; initial = defaultExpandedKey
//   - 'independent' — all groups collapsed initially; per-key toggle

import { useEffect, useState } from 'react';
import { navigate } from '../router.js';
import { useSidebarGroupMode } from '../hooks/useSidebarGroupMode.js';
import { useContextMenu } from '../context-menu/useContextMenu.js';
import { buildFileItemMenu } from '../context-menu/defaultMenus.js';
import { IconChevronRight } from './icons.jsx';

const CAPTION_STYLE = {
  fontSize: 9,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  userSelect: 'none',
};

export function SidebarNav({
  pages,
  groups,
  selectedPath,
  sectionLabel,
  accent,
  onSelect,
  onItemContextMenu,
  onGroupContextMenu,
  defaultExpandedKey,
}) {
  const accentColor = accent || 'var(--text)';
  const mode = useSidebarGroupMode();
  const { openContextMenu } = useContextMenu();

  // SF9: default right-click handler for every sidebar row, shared across all
  // section navs (Knowledge / Infrastructure / Pulse / Docs). Consumers may pass
  // an explicit onItemContextMenu to override. Real vault files/folders (a
  // derivable vaultPath) get the app file menu; route-only entries (Pulse views,
  // Docs TOC, Update Queue) return early and fall through to the generic chrome
  // menu. Either way the native WebKit menu never appears.
  const handleItemContextMenu = onItemContextMenu || ((e, item) => {
    const vaultPath = item?.vaultPath
      || (item?.path && !item.path.startsWith('/') ? item.path : null);
    if (!vaultPath) return;
    const isFolder = item.kind === 'subfolder' || !!item._isFolder;
    openContextMenu(e, buildFileItemMenu({ vaultPath, isFolder, href: itemHash(item) }));
  });

  const handleSelect = (page) => {
    if (onSelect) onSelect(page);
    else navigate('/page/' + encodePagePath(page.path));
  };

  const displayedGroups = groups && groups.length > 0
    ? groups
    : [{ label: null, items: pages || [] }];

  const allKeyed = displayedGroups.every(g => g.key);
  const effectiveMode = allKeyed ? mode : 'expanded';

  const [accordionKey, setAccordionKey] = useState(defaultExpandedKey || null);
  useEffect(() => {
    if (effectiveMode === 'accordion' && defaultExpandedKey) {
      setAccordionKey(defaultExpandedKey);
    }
  }, [defaultExpandedKey, effectiveMode]);

  const [independentMap, setIndependentMap] = useState({});

  const isExpanded = (g) => {
    if (effectiveMode === 'expanded') return true;
    if (effectiveMode === 'accordion') return accordionKey === g.key;
    return !!independentMap[g.key];
  };

  const onHeaderClick = (g) => {
    if (effectiveMode === 'expanded' || !g.key) return;
    if (effectiveMode === 'accordion') {
      setAccordionKey(g.key);
    } else {
      setIndependentMap(prev => ({ ...prev, [g.key]: !prev[g.key] }));
    }
  };

  const headerClickable = effectiveMode !== 'expanded';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      flex: 1, minHeight: 0,
      overflowY: 'auto', overflowX: 'hidden',
      padding: '6px 0 16px',
      // Left-sidebar candy buttons (rows + headers) run 15% shallower than the
      // global candy depth. Descendants consume this via --candy-depth; routing
      // through a separate token avoids a self-referential cycle and keeps the
      // Settings → Animations depth picker working (this tracks it at 85%).
      '--candy-depth-nav': 'calc(var(--candy-depth) * 0.85)',
    }}>
      {sectionLabel && (
        <div style={{ ...CAPTION_STYLE, padding: '4px 18px 10px', textAlign: 'center' }}>
          {sectionLabel}
        </div>
      )}
      {displayedGroups.map((g, gi) => {
        const hasItems = g.items && g.items.length > 0;
        if (!hasItems) return null;
        const expanded = isExpanded(g);

        return (
          <div key={g.key || g.label || gi} style={{
            padding: '2px 0 14px',
            display: 'flex', flexDirection: 'column',
            gap: 14,
          }}>
            {g.label && (
              <GroupHeader
                label={g.label}
                expanded={expanded}
                clickable={headerClickable}
                showCaret={effectiveMode !== 'expanded'}
                onClick={() => onHeaderClick(g)}
                onContextMenu={onGroupContextMenu ? (e) => onGroupContextMenu(e, g) : undefined}
              />
            )}
            {expanded && g.items.map((p) => (
              <SidebarNavItem
                key={p.path}
                item={p}
                selected={p.path === selectedPath}
                accent={accentColor}
                onClick={() => handleSelect(p)}
                onItemContextMenu={handleItemContextMenu}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function GroupHeader({ label, expanded, clickable, showCaret, onClick, onContextMenu }) {
  // Wrapping span carries onContextMenu so a right-click works even in
  // 'expanded' mode where the inner button is disabled (disabled buttons drop
  // events). pointer-events:none on the disabled button lets the event reach
  // the span; when clickable, the event bubbles up from the button.
  return (
    <span onContextMenu={onContextMenu} style={{ alignSelf: 'center', display: 'inline-flex' }}>
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      data-own-press
      className="candy-btn"
      data-shape="chip"
      style={{
        cursor: clickable ? 'pointer' : 'default',
        // Candy depth scaled to the nav token set on the scroll parent (shallower).
        '--cbtn-depth': 'var(--candy-depth-nav)',
        ...(clickable ? null : { pointerEvents: 'none' }),
      }}
    >
      <span className="candy-face" style={{
        textTransform: 'uppercase',
        // Height −15%: vertical padding 5px→3px (horizontal 10px stays from chip CSS).
        paddingTop: 3, paddingBottom: 3,
      }}>
        {showCaret && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 12, height: 12,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transformOrigin: '50% 50%',
            transition: 'transform 140ms ease',
            flexShrink: 0,
          }}>
            <IconChevronRight/>
          </span>
        )}
        <span>{label}</span>
      </span>
    </button>
    </span>
  );
}

function SidebarNavItem({ item, selected, accent, onClick, onItemContextMenu }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onItemContextMenu ? (e) => onItemContextMenu(e, item) : undefined}
      data-own-press
      className={`candy-btn${selected ? ' is-active' : ''}`}
      data-shape="row"
      style={{
        width: 'calc(100% - 12px)',
        margin: '0 6px',
        // Candy depth scaled to match the nav token set on the scroll parent.
        '--candy-depth': 'var(--candy-depth-nav)',
        ...(accent ? { '--accent': accent } : {}),
      }}
    >
      <span
        className="candy-face"
        style={{
          justifyContent: 'center', textAlign: 'center',
          // Height −15%: vertical padding 9px→6px (horizontal 12px from the row recipe).
          paddingTop: 6, paddingBottom: 6,
          ...(item.mono ? { fontFamily: 'var(--font-mono)' } : {}),
        }}
      >
        <span style={{
          flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {item.title || item.name}
        </span>
        {item.trailing && (
          <span style={{
            flexShrink: 0,
            display: 'inline-flex', alignItems: 'center',
            fontSize: 11,
          }}>{item.trailing}</span>
        )}
      </span>
    </button>
  );
}

// Encode a vault-relative path for use in a `/page/<path>` URL, preserving
// the '/' separators (encodeURIComponent would escape them).
export function encodePagePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// Convert a sidebar item to its navigable hash. Route-style paths (starting
// with '/') are used as-is; vault page paths get the '/page/' prefix + encoding.
// Mirrors the onSelect handlers in the section Nav components.
export function itemHash(item) {
  return item.path.startsWith('/') ? item.path : '/page/' + encodePagePath(item.path);
}

// Find the sidebar item matching a stored selection key (a `selectedPath`).
// Tolerates trailing-'.md' drift between selectedPath and item.path. Returns
// null when the key no longer maps to any current item (deleted/renamed page),
// which is exactly the signal callers use to fall back to the section's default.
export function findItemByKey(groups, key) {
  if (!key) return null;
  const norm = (s) => s.replace(/\.md$/, '');
  for (const g of (groups || [])) {
    for (const it of (g.items || [])) {
      if (it.path === key || norm(it.path) === norm(key)) return it;
    }
  }
  return null;
}

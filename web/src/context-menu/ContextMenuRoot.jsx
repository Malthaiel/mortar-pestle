// Portaled renderer for the app-wide context menu. Forked from the original
// components/ui/ContextMenu.jsx (viewport-clamp + capture-phase Esc/click-outside
// close) and extended across the App-Wide Context Menu sub-features: flat rows
// with a check/radio glyph slot + optional shortcut (SF0), icons + standing-red
// danger (SF1), separators + section headers (SF2), roving keyboard navigation
// with disabled-item skipping (SF3), and fly-out submenus (SF4).
//
// Submenus use a CENTRALIZED model: the root component owns `openPath` (the
// chain of parent-row indices whose children are open) + `activeIndex` (the
// cursor within the DEEPEST level). One focus owner, one keyboard handler — the
// nested panels are presentational portals that report pointer events upward.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { candyGap } from '../util/candy.js';

const MIN_WIDTH = 200;
const MAX_WIDTH = 320;
const PAD = 8;
const HOVER_INTENT = 120; // ms before a hover opens/closes a submenu

let _menuSeq = 0;

const isSep = (it) => !!(it && (it.sep || it.divider));
const isHeader = (it) => !!(it && (it.header || it.section));
const hasKids = (it) => !!(it && it.children && it.children.length);
const isNavigable = (it) => !!it && !isSep(it) && !isHeader(it) && !it.disabled;
const firstNavigable = (arr) => {
  for (let i = 0; i < arr.length; i++) if (isNavigable(arr[i])) return i;
  return -1;
};

// Walk `items` down a path of parent-row indices to the items at that level.
function levelItemsFor(items, path) {
  let cur = items;
  for (const idx of path) {
    const parent = cur[idx];
    if (!hasKids(parent)) return cur; // stale path — stop where it breaks
    cur = parent.children;
  }
  return cur;
}

export default function ContextMenuRoot({ point, items = [], opts = {}, onClose }) {
  const [openPath, setOpenPath] = useState([]); // parent indices, one per open submenu
  const [activeIndex, setActiveIndex] = useState(-1); // cursor within the deepest level
  const accent = opts.accent || 'var(--accent)';
  const menuId = useMemo(() => `ctx-menu-${++_menuSeq}`, []);

  const panelEls = useRef(new Map()); // depth -> panel element (containment + focus)
  const rowEls = useRef(new Map()); // "depth:index" -> row element (submenu anchor)
  const hoverTimer = useRef(0);
  const typeBuf = useRef({ str: '', t: 0 });

  // Resolve the open levels from items + openPath. levels[0] is the root menu;
  // each later entry records the parent row that spawned it (for positioning).
  const levels = useMemo(() => {
    const out = [{ items, parentDepth: -1, parentIndex: -1 }];
    let cur = items;
    for (let d = 0; d < openPath.length; d++) {
      const idx = openPath[d];
      const parent = cur[idx];
      if (!hasKids(parent)) break;
      cur = parent.children;
      out.push({ items: cur, parentDepth: d, parentIndex: idx });
    }
    return out;
  }, [items, openPath]);

  const deepest = levels.length - 1;
  const deepestItems = levels[deepest].items;
  const navIndices = useMemo(
    () => deepestItems.map((it, i) => (isNavigable(it) ? i : -1)).filter((i) => i >= 0),
    [deepestItems],
  );

  // Latest state for the capture-phase Escape handler (avoids stale closures).
  const stateRef = useRef({ openPath, activeIndex });
  stateRef.current.openPath = openPath;
  stateRef.current.activeIndex = activeIndex;

  // A fresh menu (new items or new anchor point) resets the open path + cursor.
  useEffect(() => {
    setOpenPath([]);
    setActiveIndex(-1);
  }, [items, point && point.x, point && point.y]);

  // Take focus on the ROOT panel on open so arrow keys land here; restore on close.
  useEffect(() => {
    const prev = typeof document !== 'undefined' ? document.activeElement : null;
    const el = panelEls.current.get(0);
    if (el) {
      try { el.focus({ preventScroll: true }); }
      catch (e) { try { el.focus(); } catch (e2) {} }
    }
    return () => {
      clearTimeout(hoverTimer.current);
      try { prev && prev.focus && prev.focus({ preventScroll: true }); } catch (e) {}
    };
  }, []);

  // Close on Escape / outside click — capture phase so a parent's stopPropagation
  // can't swallow it. Escape closes the deepest submenu first, then the whole menu.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      const op = stateRef.current.openPath;
      if (op.length > 0) { setOpenPath(op.slice(0, -1)); setActiveIndex(op[op.length - 1]); }
      else onClose && onClose();
    }
    function onDown(e) {
      for (const el of panelEls.current.values()) {
        if (el && el.contains(e.target)) return; // click landed inside some panel
      }
      onClose && onClose();
    }
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  function moveActive(dir) {
    if (!navIndices.length) return;
    const cur = navIndices.indexOf(activeIndex);
    const next = cur === -1
      ? (dir > 0 ? 0 : navIndices.length - 1)
      : (cur + dir + navIndices.length) % navIndices.length;
    setActiveIndex(navIndices[next]);
  }

  function edgeActive(dir) {
    if (!navIndices.length) return;
    setActiveIndex(dir > 0 ? navIndices[0] : navIndices[navIndices.length - 1]);
  }

  function openSubmenu() {
    const it = deepestItems[activeIndex];
    if (!hasKids(it)) return;
    const next = [...openPath, activeIndex];
    setOpenPath(next);
    setActiveIndex(firstNavigable(it.children));
  }

  function closeSubmenu() {
    if (!openPath.length) return;
    const parentIdx = openPath[openPath.length - 1];
    setOpenPath(openPath.slice(0, -1));
    setActiveIndex(parentIdx);
  }

  function activate() {
    const it = deepestItems[activeIndex];
    if (!it) return;
    if (hasKids(it)) { openSubmenu(); return; }
    if (isNavigable(it)) { it.onClick && it.onClick(); onClose && onClose(); }
  }

  function typeAhead(ch) {
    const now = Date.now();
    const buf = typeBuf.current;
    buf.str = (now - buf.t > 600 ? '' : buf.str) + ch.toLowerCase();
    buf.t = now;
    const from = navIndices.indexOf(activeIndex);
    const order = navIndices.slice(from + 1).concat(navIndices.slice(0, from + 1));
    const hit = order.find((i) => String(deepestItems[i].label || '').toLowerCase().startsWith(buf.str));
    if (hit !== undefined) setActiveIndex(hit);
  }

  function onKeyDown(e) {
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveActive(1); }
    else if (k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveActive(-1); }
    else if (k === 'Home') { e.preventDefault(); e.stopPropagation(); edgeActive(1); }
    else if (k === 'End') { e.preventDefault(); e.stopPropagation(); edgeActive(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); openSubmenu(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); closeSubmenu(); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); e.stopPropagation(); activate(); }
    else if (k === 'Tab') { e.preventDefault(); e.stopPropagation(); onClose && onClose(); }
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.stopPropagation(); typeAhead(k); }
    // Escape falls through to the capture-phase window listener above.
  }

  // Hover-intent: opening/closing a submenu waits ~120ms so a fast diagonal sweep
  // toward an open child doesn't snap it shut. The cursor highlight is immediate
  // when hovering the current deepest level.
  function onRowHover(d, i, kids) {
    clearTimeout(hoverTimer.current);
    if (d === deepest) setActiveIndex(i);
    hoverTimer.current = setTimeout(() => {
      const base = openPath.slice(0, d); // close anything deeper than this level
      if (kids) {
        const next = [...base, i];
        setOpenPath(next);
        setActiveIndex(firstNavigable(levelItemsFor(items, next)));
      } else {
        setOpenPath(base);
        setActiveIndex(i);
      }
    }, HOVER_INTENT);
  }

  function onRowClick(d, i, it) {
    clearTimeout(hoverTimer.current);
    if (hasKids(it)) {
      const next = [...openPath.slice(0, d), i];
      setOpenPath(next);
      setActiveIndex(firstNavigable(it.children));
      return;
    }
    it.onClick && it.onClick();
    onClose && onClose();
  }

  function registerRowEl(d, i, el) {
    const key = `${d}:${i}`;
    if (el) rowEls.current.set(key, el);
    else rowEls.current.delete(key);
  }
  function reportPanelEl(d, el) {
    if (el) panelEls.current.set(d, el);
    else panelEls.current.delete(d);
  }

  if (!point) return null;

  return levels.map((level, depth) => {
    const anchorEl = depth === 0
      ? null
      : rowEls.current.get(`${level.parentDepth}:${level.parentIndex}`) || null;
    return (
      <MenuPanel
        key={depth}
        depth={depth}
        items={level.items}
        point={depth === 0 ? point : undefined}
        anchorEl={anchorEl}
        header={depth === 0 ? opts.header : undefined}
        accent={accent}
        menuId={menuId}
        activeIndex={depth === deepest ? activeIndex : -1}
        openIndex={openPath[depth] != null ? openPath[depth] : -1}
        interactive={depth === 0}
        onKeyDown={depth === 0 ? onKeyDown : undefined}
        onRowHover={onRowHover}
        onRowClick={onRowClick}
        registerRowEl={registerRowEl}
        reportPanelEl={reportPanelEl}
      />
    );
  });
}

function MenuPanel({
  depth, items, point, anchorEl, header, accent, menuId,
  activeIndex, openIndex, interactive,
  onKeyDown, onRowHover, onRowClick, registerRowEl, reportPanelEl,
}) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999, ready: false });

  // Report this panel's element up for click-outside containment + root focus.
  useEffect(() => {
    reportPanelEl(depth, ref.current);
    return () => reportPanelEl(depth, null);
  }, [depth]);

  // Position: root anchors at the click point (viewport-clamped); a submenu flies
  // out from its parent row's right edge, edge-flipping leftward when it'd overflow.
  useLayoutEffect(() => {
    if (!ref.current) return;
    const my = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (point) {
      let left = point.x;
      let top = point.y;
      if (left + my.width + PAD > vw) left = Math.max(PAD, vw - my.width - PAD);
      if (top + my.height + PAD > vh) top = Math.max(PAD, vh - my.height - PAD);
      setPos({ left, top, ready: true });
    } else if (anchorEl) {
      const row = anchorEl.getBoundingClientRect();
      const panel = anchorEl.closest('[role="menu"]');
      const pr = panel ? panel.getBoundingClientRect() : row;
      let left = pr.right - 4; // slight overlap with the parent panel
      let top = row.top - 4; // align with the parent row, minus panel padding
      if (left + my.width + PAD > vw) left = pr.left - my.width + 4; // flip left
      if (left < PAD) left = PAD;
      if (top + my.height + PAD > vh) top = Math.max(PAD, vh - my.height - PAD);
      setPos({ left, top, ready: true });
    }
  }, [point && point.x, point && point.y, anchorEl, items]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="ctx-menu"
      tabIndex={interactive ? -1 : undefined}
      aria-activedescendant={interactive && activeIndex >= 0 ? `${menuId}-${depth}-${activeIndex}` : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        // Right-clicking the menu itself shouldn't re-trigger the suppressor.
        e.preventDefault();
        if (e.nativeEvent) e.nativeEvent.__agenticCtxHandled = true;
      }}
      style={{
        position: 'fixed',
        left: pos.left, top: pos.top,
        minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH,
        // Backdrop pinned to the dock's slate bg (#151411) per user request — not
        // var(--bg) — so the popup reads as part of the dock chrome.
        background: '#151411',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md, 8px)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.32), 0 2px 8px rgba(0,0,0,0.18)',
        padding: 4,
        zIndex: 9999,
        opacity: pos.ready ? 1 : 0,
        transition: 'opacity 90ms ease',
        outline: 'none',
        ['--accent']: accent,
      }}
    >
      {header && <MenuHeader label={header} first />}
      {/* Candy rows cast a --candy-depth downward shadow outside layout — a flat
          margin gets eaten. candyGap() adds the depth so ~base px stays visible
          and tracks the user's depth picker; paddingBottom clears the last row's
          slab so it doesn't spill past the menu's bottom edge. See util/candy.js. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: candyGap(3), paddingBottom: 'var(--candy-depth)' }}>
        {items.map((it, i) => {
          if (isSep(it)) return <MenuSep key={i} />;
          if (isHeader(it)) return <MenuHeader key={i} label={it.header || it.label} inline newSection={i > 0} />;
          const kids = hasKids(it);
          return (
            <MenuRow
              key={i}
              it={it}
              id={`${menuId}-${depth}-${i}`}
              accent={accent}
              active={i === activeIndex || i === openIndex}
              hasChildren={kids}
              onHover={() => onRowHover(depth, i, kids)}
              onClick={() => onRowClick(depth, i, it)}
              registerEl={(el) => registerRowEl(depth, i, el)}
            />
          );
        })}
      </div>
    </div>,
    document.body
  );
}

function MenuHeader({ label, first, inline, newSection }) {
  return (
    <div style={{
      padding: inline ? '0 10px' : (first ? '2px 10px 4px' : '8px 10px 4px'),
      fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.14em',
      textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
      // Inline headers cast no candy shadow: cancel the depth-gap below so the
      // label hugs its rows, and add a little space above a mid-menu header so a
      // fresh section reads without a separator.
      ...(inline ? {
        marginTop: newSection ? 5 : 0,
        marginBottom: 'calc(-1 * var(--candy-depth))',
      } : null),
    }}>{label}</div>
  );
}

function MenuSep() {
  // A hairline casts no candy shadow, so cancel the stack's depth-gap below it to
  // keep the line visually centered between its neighbors.
  return (
    <div role="separator" style={{
      height: 1, background: 'var(--border-soft)', margin: '0 6px',
      marginBottom: 'calc(-1 * var(--candy-depth))',
    }} />
  );
}

function MenuRow({ it, id, accent, active, hasChildren, onHover, onClick, registerEl }) {
  const disabled = !!it.disabled;
  const glyph = it.kind === 'radio' ? (it.checked ? '•' : '') : (it.checked ? '✓' : '');
  // icon may be a component (e.g. IconTrash) or a ready node; render either.
  const Icon = it.icon;
  const lead = Icon ? (typeof Icon === 'function' ? <Icon size={14} /> : Icon) : glyph;
  const cls = 'candy-btn'
    + (it.danger ? ' is-danger' : '')
    + (active && !disabled ? ' is-active' : '');
  return (
    <button
      ref={registerEl}
      type="button"
      role="menuitem"
      id={id}
      disabled={disabled}
      aria-disabled={disabled}
      aria-haspopup={hasChildren ? 'menu' : undefined}
      data-own-press
      className={cls}
      data-shape="row"
      data-variant="menu"
      onMouseEnter={onHover}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onClick();
      }}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <span className="candy-face">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{
            width: 14, flexShrink: 0, display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center',
            color: Icon ? undefined : accent, fontSize: 12,
          }}>{lead}</span>
          <span style={{ flex: 1, minWidth: 0 }}>{it.label}</span>
          {hasChildren ? (
            <span aria-hidden style={{
              marginLeft: 12, fontSize: 11, lineHeight: 1,
              color: 'var(--text-faint)',
            }}>▸</span>
          ) : it.shortcut ? (
            <span style={{
              marginLeft: 12, fontSize: 10, fontFamily: 'var(--font-mono)',
              color: 'var(--text-faint)', letterSpacing: '0.04em',
            }}>{it.shortcut}</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

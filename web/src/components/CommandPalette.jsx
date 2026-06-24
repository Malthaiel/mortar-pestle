// Cmd+K (Ctrl+K on non-Mac) command palette.
//
// Three sections:
//   - RECENT: last 5 pages visited (from useRecentPages)
//   - PAGES:  fuzzy search across the entire vault manifest (api.searchAllPages)
//   - ACTIONS: module- and host-registered commands ("Toggle Planner",
//              "Open Settings", "Edit layout", "About", …)
//
// Recent is only shown when the query is empty. As soon as the user types,
// it's replaced by the pages section. Actions always show — typing also
// filters them.
//
// Keyboard:
//   Cmd+K (Ctrl+K) — open
//   Esc           — close
//   ↑ ↓           — move selection
//   ↵             — invoke selected
//
// The palette uses a portal-free centered overlay (matches SettingsDrawer
// pattern). Z-index 1100 so it sits above Settings (1000).

import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { useRecentPages } from '../hooks/useRecentPages.js';
import { getCommandActions, subscribeCommandActions } from '../command-actions.js';
import { IconCommand } from './icons.jsx';

const PAGE_FETCH_DEBOUNCE = 120;

function encodePagePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function pageHashFor(result) {
  return '#/page/' + encodePagePath(result.path);
}

export default function CommandPalette({ open, onClose, accent, onOpenSettings, initialQuery }) {
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState([]);
  const [selected, setSelected] = useState(0);
  const [actions, setActions] = useState(() => getCommandActions());
  const { recent } = useRecentPages(5);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Refresh actions when modules re-register.
  useEffect(() => subscribeCommandActions(() => setActions(getCommandActions())), []);

  // Reset on each open. SF8: seed from initialQuery (e.g. a "Search vault"
  // selection) when provided, else clear.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery || '');
    setSelected(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, initialQuery]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchAllPages(query, 20)
        .then(res => { if (!cancelled) setPages(res.results || []); })
        .catch(() => { if (!cancelled) setPages([]); });
    }, PAGE_FETCH_DEBOUNCE);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, open]);

  const filteredActions = filterActions(actions, query);
  const showRecent = !query.trim();
  const items = buildItems({ showRecent, recent, pages, actions: filteredActions, onOpenSettings });

  // Keep selected in range as items change.
  useEffect(() => {
    if (selected >= items.length) setSelected(Math.max(0, items.length - 1));
  }, [items.length, selected]);

  const invokeItem = (item) => {
    if (!item) return;
    if (item.kind === 'page' || item.kind === 'recent') {
      const href = item.kind === 'recent' ? item.path : pageHashFor(item);
      window.location.hash = href.startsWith('#') ? href.slice(1) : href;
    } else if (item.kind === 'action') {
      try { item.run(); } catch (err) { console.warn('[palette] action failed:', err); }
    }
    onClose();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(items.length - 1, s + 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected(s => Math.max(0, s - 1)); return; }
    if (e.key === 'Enter')     { e.preventDefault(); invokeItem(items[selected]); return; }
  };

  // Scroll selected into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-pal-idx="${selected}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [selected, open]);

  if (!open) return null;

  const accentColor = accent || 'var(--text)';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      paddingTop: '12vh',
    }}>
      <div onClick={onClose} className="candy-backdrop"/>
      <div role="dialog" aria-label="Command palette" className="candy-modal" style={{
        position: 'relative',
        width: 580, maxHeight: '70vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        animation: 'fadeIn 0.16s ease',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 16px',
          borderBottom: '1px solid var(--border-soft)',
        }}>
          <span style={{ color: 'var(--text-faint)', display: 'inline-flex' }}>
            <IconCommand size={16}/>
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page or run a command…"
            style={{
              flex: 1,
              border: 'none', outline: 'none',
              background: 'transparent', color: 'var(--text)',
              fontSize: 15, fontFamily: 'var(--font-body)',
            }}
          />
          <span style={{
            fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--text-faint)',
            border: '1px solid var(--border-2)',
            borderRadius: 4, padding: '2px 6px',
          }}>Esc</span>
        </div>

        <div ref={listRef} style={{
          flex: 1, overflowY: 'auto',
          padding: '6px 8px 10px',
        }}>
          {items.length === 0 && (
            <div style={{
              padding: '24px 16px', textAlign: 'center',
              color: 'var(--text-faint)', fontSize: 12,
            }}>No matches</div>
          )}
          {renderGrouped(items, selected, accentColor, invokeItem)}
        </div>
      </div>
    </div>
  );
}

function filterActions(actions, query) {
  const q = query.trim().toLowerCase();
  if (!q) return actions;
  return actions.filter(a =>
    a.label.toLowerCase().includes(q) ||
    (a.keywords || []).some(k => k.toLowerCase().includes(q))
  );
}

function buildItems({ showRecent, recent, pages, actions }) {
  const items = [];
  if (showRecent && recent.length > 0) {
    for (const r of recent) items.push({ ...r, kind: 'recent' });
  }
  for (const p of pages) items.push({ ...p, kind: 'page' });
  for (const a of actions) items.push({ ...a, kind: 'action' });
  return items;
}

function renderGrouped(items, selected, accent, invokeItem) {
  const groups = [];
  let cur = null;
  items.forEach((item, i) => {
    const group = item.kind === 'recent' ? 'Recent'
                : item.kind === 'page' ? 'Pages'
                : 'Actions';
    if (!cur || cur.label !== group) {
      cur = { label: group, items: [] };
      groups.push(cur);
    }
    cur.items.push({ item, index: i });
  });
  return groups.map((g, gi) => (
    <div key={gi}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600,
        padding: '8px 14px 4px',
      }}>{g.label}</div>
      {g.items.map(({ item, index }) => (
        <PaletteRow
          key={item.kind + ':' + (item.path || item.id || index)}
          item={item}
          dataIdx={index}
          active={index === selected}
          accent={accent}
          onClick={() => invokeItem(item)}
        />
      ))}
    </div>
  ));
}

function PaletteRow({ item, dataIdx, active, accent, onClick }) {
  const isAction = item.kind === 'action';

  // Sub-feature 4 creative add: score-based visual ranking. The Rust
  // `search_pages` command emits a `score` field (5 = title exact … 1 =
  // path contains). Drive type weight + tint + accent stripe from it so
  // the palette communicates match quality without an extra label.
  // Active row always wins visually (accent fill + 600 weight).
  const score = !isAction && item.kind === 'page' ? (item.score || 0) : 0;
  const titleFontWeight = active
    ? 600
    : score >= 4 ? 600
    : 500;
  const titleColor = !active && score === 1 ? 'var(--text-muted)' : 'var(--text)';
  const showStripe = !active && score === 5;
  const showAliasChip = !active && score === 2;

  return (
    <button
      type="button"
      data-pal-idx={dataIdx}
      onClick={onClick}
      data-own-press
      className={`candy-btn${active ? ' is-active' : ''}`}
      data-shape="row"
      data-variant="palette"
      style={{ '--accent': accent }}
    >
      <span className="candy-face">
      {showStripe && (
        <span aria-hidden style={{
          position: 'absolute',
          left: 0, top: 4, bottom: 4,
          width: 2,
          background: accent,
          borderTopRightRadius: 2, borderBottomRightRadius: 2,
        }}/>
      )}
      <span aria-hidden style={{
        width: 6, height: 6, borderRadius: '50%',
        background: active ? accent : 'var(--text-faint)',
        opacity: active ? 1 : 0.55,
        flexShrink: 0,
        boxShadow: active ? `0 0 0 3px color-mix(in oklch, ${accent} 22%, transparent)` : 'none',
      }}/>
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          <span style={{
            fontSize: 13, fontWeight: titleFontWeight, color: titleColor,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{item.label || item.title}</span>
          {showAliasChip && (
            <span aria-label="matched by alias" style={{
              fontSize: 9, fontFamily: 'var(--font-mono)',
              letterSpacing: '0.06em', textTransform: 'uppercase',
              padding: '1px 5px', borderRadius: 3,
              border: `1px solid color-mix(in oklch, ${accent} 32%, transparent)`,
              color: `color-mix(in oklch, ${accent} 80%, var(--text-muted))`,
              flexShrink: 0,
            }}>alias</span>
          )}
        </span>
        {!isAction && item.folder && (
          <span style={{
            fontSize: 10.5, color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{item.folder}</span>
        )}
        {isAction && item.hint && (
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{item.hint}</span>
        )}
      </span>
      {isAction && item.shortcut && (
        <span style={{
          fontSize: 10, fontFamily: 'var(--font-mono)',
          color: 'var(--text-faint)',
          border: '1px solid var(--border-2)',
          borderRadius: 4, padding: '1px 6px',
        }}>{item.shortcut}</span>
      )}
      </span>
    </button>
  );
}

// Toolbar History popup: a quick-peek flat list of recent visits (newest first)
// with inline search across all history, plus a link to the full history page.
// Reuses tabStore's history log + the favicon-from-Pinned/Recent lookup that the
// full HistoryRoute uses. Rendered as a top drop-panel by BrowserPage; clicking a
// row loads it in the active tab and closes the popup.

import { useMemo, useState } from 'react';
import * as store from './tabStore.js';
import { hostOf } from './tabStore.js';
import { useTabStore } from './useTabStore.js';
import { IconGlobe, IconSearch } from '@host/components/icons.jsx';
import { candyGap } from '@host/util/candy.js';
import BrowserPopover from './BrowserPopover.jsx';

const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function HistoryPopover({ api, accent, onClose, onOpenUrl }) {
  const [query, setQuery] = useState('');
  const { pinned, recent } = useTabStore();
  const entries = useMemo(() => store.getHistory().slice(), []); // snapshot, newest first

  const faviconFor = useMemo(() => {
    const m = new Map();
    for (const it of [...(recent || []), ...(pinned || [])]) {
      if (it.url && it.favicon && !m.has(it.url)) m.set(it.url, it.favicon);
    }
    return m;
  }, [pinned, recent]);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? entries.filter(e => (e.title || '').toLowerCase().includes(q) || (e.url || '').toLowerCase().includes(q))
      : entries;
  }, [entries, query]);

  const openUrl = (url) => { if (!url) return; onOpenUrl(url); onClose(); };
  const openFull = () => { api.router.navigate('/tools/browser/history'); onClose(); };

  return (
    <BrowserPopover title="History" onClose={onClose} scroll={false}>
      <style>{ROW_CSS}</style>
      <div style={searchWrap}>
        <IconSearch size={15} />
        <input style={searchInput} placeholder="Search history…" value={query} autoFocus
          onChange={e => setQuery(e.target.value)} spellCheck={false} autoComplete="off" />
      </div>
      <div style={list}>
        {matched.length === 0 ? (
          <p style={emptyStyle}>{entries.length === 0 ? 'No history yet. Sites you visit will appear here.' : 'No matches.'}</p>
        ) : matched.map(e => (
          <button key={e.url + e.ts} type="button" className="aos-hp-row" style={row} title={e.url} onClick={() => openUrl(e.url)}>
            <span style={favWrap}>
              {faviconFor.get(e.url)
                ? <img src={faviconFor.get(e.url)} width={16} height={16} alt="" style={{ borderRadius: 3 }} onError={(ev) => { ev.currentTarget.style.display = 'none'; }} />
                : <IconGlobe size={15} />}
            </span>
            <span style={rowTitle}>{e.title || hostOf(e.url)}</span>
            <span style={rowUrl}>{hostOf(e.url)}</span>
            <span style={rowTime}>{fmtTime(e.ts)}</span>
          </button>
        ))}
      </div>
      <button type="button" className="candy-btn" data-shape="text" data-own-press
        onClick={openFull} style={{ flex: '0 0 auto', width: 'calc(100% - 24px)', margin: `8px 12px ${candyGap(16)}`, '--accent': accent }}>
        <span className="candy-face">View full history</span>
      </button>
    </BrowserPopover>
  );
}

const searchWrap = {
  flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, margin: '12px 12px 8px',
  padding: '0 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text-muted)',
};
const searchInput = { flex: 1, minWidth: 0, padding: '7px 0', border: 'none', background: 'transparent', color: 'var(--text)', font: 'inherit', outline: 'none' };
const list = { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px' };
const row = { width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', border: 'none', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', font: 'inherit', textAlign: 'left' };
const favWrap = { flexShrink: 0, width: 16, height: 16, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' };
const rowTitle = { flex: '0 1 auto', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 };
const rowUrl = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-faint)' };
const rowTime = { flexShrink: 0, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' };
const emptyStyle = { textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, marginTop: 36 };

const ROW_CSS = `.aos-hp-row:hover { background: var(--hover); }`;

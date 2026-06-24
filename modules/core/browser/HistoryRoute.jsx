// Full-page browsing-history surface, rendered by BrowserPage when the route is
// /tools/browser/history (the native web view is hidden while it shows). Reads
// the capped history log from tabStore, groups visits by day, supports search +
// per-entry delete + clear-all, and a pause-recording toggle. Clicking a row
// loads it in the active tab. Favicons are best-effort (looked up from
// Pinned/Recent, which cache them) since the history log stores none — keeping
// it well under the localStorage quota at ~1000 entries.

import { useMemo, useState } from 'react';
import * as store from './tabStore.js';
import { hostOf } from './tabStore.js';
import { useTabStore } from './useTabStore.js';
import { useModuleSettings } from '@host/hooks/useSettings.js';
import { IconGlobe, IconSearch, IconX } from '@host/components/icons.jsx';

const startOfDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
function dayBucket(ts) {
  const diff = Math.round((startOfDay(Date.now()) - startOfDay(ts)) / 864e5);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function HistoryRoute({ api, accent, onClose, onOpenUrl }) {
  const [entries, setEntries] = useState(() => store.getHistory().slice());
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const { pinned, recent } = useTabStore();
  const { settings, setSetting } = useModuleSettings('browser');
  const paused = !!settings.historyPaused;

  const faviconFor = useMemo(() => {
    const m = new Map();
    for (const it of [...(recent || []), ...(pinned || [])]) {
      if (it.url && it.favicon && !m.has(it.url)) m.set(it.url, it.favicon);
    }
    return m;
  }, [pinned, recent]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? entries.filter(e => (e.title || '').toLowerCase().includes(q) || (e.url || '').toLowerCase().includes(q))
      : entries;
    const out = [];
    let cur = null;
    for (const e of matched) {
      const b = dayBucket(e.ts);
      if (!cur || cur.bucket !== b) { cur = { bucket: b, items: [] }; out.push(cur); }
      cur.items.push(e);
    }
    return out;
  }, [entries, query]);

  const open = (url) => { if (!url) return; onOpenUrl(url); api.router.navigate('/tools/browser'); };
  const removeEntry = (e) => { store.deleteHistoryEntry(e.url, e.ts); setEntries(store.getHistory().slice()); };
  const clearAll = () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    store.clearHistory();
    setEntries([]);
    setConfirmClear(false);
  };

  return (
    <div style={wrap}>
      <style>{ROW_CSS}</style>
      <div style={bar}>
        <strong style={{ fontSize: 14, flexShrink: 0 }}>History</strong>
        <div style={searchWrap}>
          <IconSearch size={15} />
          <input style={searchInput} placeholder="Search history…" value={query}
            onChange={e => setQuery(e.target.value)} spellCheck={false} autoComplete="off" />
        </div>
        <button type="button" style={{ ...ghost, ...(paused ? { borderColor: accent, color: accent } : {}) }}
          onClick={() => setSetting('historyPaused', !paused)}
          title={paused ? 'History recording is paused — click to resume' : 'Stop recording new history'}>
          {paused ? 'Paused — Resume' : 'Pause history'}
        </button>
        <button type="button" style={{ ...ghost, ...(confirmClear ? { borderColor: accent, color: accent } : {}) }}
          onClick={clearAll} title="Clear all history">
          {confirmClear ? 'Confirm clear' : 'Clear history'}
        </button>
        <button type="button" style={ghost} onClick={onClose} title="Back to browser">✕</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 16px' }}>
        {groups.length === 0 ? (
          <p style={emptyStyle}>
            {entries.length === 0
              ? (paused ? 'History recording is paused. Resume to log visits.' : 'No history yet. Sites you visit will appear here.')
              : 'No matches.'}
          </p>
        ) : groups.map(g => (
          <div key={g.bucket} style={{ marginBottom: 4 }}>
            <div style={dayHeading}>{g.bucket}</div>
            {g.items.map(e => (
              <div key={e.url + e.ts} className="aos-hist-row" style={row}>
                <button type="button" style={rowMain} title={e.url} onClick={() => open(e.url)}>
                  <span style={favWrap}>
                    {faviconFor.get(e.url)
                      ? <img src={faviconFor.get(e.url)} width={16} height={16} alt="" style={{ borderRadius: 3 }} onError={(ev) => { ev.currentTarget.style.display = 'none'; }} />
                      : <IconGlobe size={15} />}
                  </span>
                  <span style={rowTitle}>{e.title || hostOf(e.url)}</span>
                  <span style={rowUrl}>{hostOf(e.url)}</span>
                  <span style={rowTime}>{fmtTime(e.ts)}</span>
                </button>
                <button type="button" className="aos-hist-del" style={delBtn}
                  title="Remove from history" aria-label="Remove from history"
                  onClick={() => removeEntry(e)}><IconX /></button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const wrap = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg)', position: 'relative' };
const bar = { display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderBottom: '1px solid var(--border)', background: 'var(--surface)', flex: '0 0 auto' };
const ghost = { flexShrink: 0, padding: '7px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', font: 'inherit', fontSize: 12.5 };
const searchWrap = { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, padding: '0 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-muted)' };
const searchInput = { flex: 1, minWidth: 0, padding: '7px 0', border: 'none', background: 'transparent', color: 'var(--text)', font: 'inherit', outline: 'none' };

const dayHeading = { fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600, padding: '14px 16px 4px' };
const row = { display: 'flex', alignItems: 'center' };
const rowMain = { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '7px 4px 7px 16px', border: 'none', background: 'transparent', color: 'var(--text)', cursor: 'pointer', font: 'inherit', textAlign: 'left' };
const favWrap = { flexShrink: 0, width: 16, height: 16, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' };
const rowTitle = { flex: '0 1 auto', minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 };
const rowUrl = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-faint)' };
const rowTime = { flexShrink: 0, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' };
const delBtn = { flexShrink: 0, width: 28, height: 28, marginRight: 8, display: 'grid', placeItems: 'center', border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', opacity: 0, transition: 'opacity 120ms ease' };
const emptyStyle = { textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, marginTop: 48 };

const ROW_CSS = `
.aos-hist-row:hover { background: var(--hover); }
.aos-hist-row:hover .aos-hist-del { opacity: 1; }
.aos-hist-del:hover { color: var(--text); background: var(--border-2); }
`;

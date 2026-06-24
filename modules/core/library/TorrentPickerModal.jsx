// Torrent picker — the user chooses WHICH Nyaa release to download instead of the
// old silent auto-pick (which grabbed look-alike titles, e.g. a fantasy isekai for
// "Nichijou"). Self-contained: owns its search lifecycle (editable query + Sub/Dub
// toggle, both re-run the search), lists ranked candidates with batch/episode
// labels, and hands the chosen magnet back via onPick → which rides
// anime_download_enqueue(downloadSource) and skips download_anime.py's Nyaa search.

import { useEffect, useRef, useState } from 'react';
import { videoApi } from './api.js';
import { FilterChip, OutlinedBtn, PrimaryBtn } from '@host/components/ui/index.js';

// nyaa_search.py --type only accepts these; anything else (ONA/Music/…) → TV.
const NYAA_TYPES = ['Movie', 'OVA', 'Special'];
const normType = (t) => (NYAA_TYPES.includes(t) ? t : 'TV');

export default function TorrentPickerModal({ open, title, englishTitle, type, accent, onPick, onCancel }) {
  const a = accent || 'var(--accent)';
  const [query, setQuery] = useState(title || '');
  const [audio, setAudio] = useState('sub');
  const [cands, setCands] = useState(null);   // null = not searched yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(0);
  const reqId = useRef(0);

  async function runSearch(q, aud) {
    const term = (q ?? query).trim();
    if (!term) { setError('Type something to search.'); setCands([]); return; }
    const myId = ++reqId.current;
    setLoading(true); setError(null);
    try {
      const res = await videoApi.animeTorrentSearch(term, englishTitle, normType(type), aud ?? audio);
      if (myId !== reqId.current) return;
      const list = (res && res.candidates) || [];
      setCands(list); setSel(0);
      if (!list.length) setError('No torrents found.');
    } catch (e) {
      if (myId !== reqId.current) return;
      setCands([]); setError((e && e.message) || 'Search failed.');
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
  }

  // (Re)seed query + auto-search each time the modal opens for a title.
  useEffect(() => {
    if (!open) return;
    setQuery(title || ''); setAudio('sub');
    runSearch(title || '', 'sub');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, title]);

  // Esc cancels.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel?.(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  if (!open) return null;

  const confirm = () => {
    if (!cands || !cands[sel]) return;
    onPick?.(cands[sel].magnet, audio, cands[sel]);
  };

  return (
    <div onClick={onCancel} style={S.overlay}>
      <div onClick={(e) => e.stopPropagation()} className="candy-section" style={S.panel}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Choose a torrent</div>
        <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-muted)', marginTop: -4 }}>
          Pick the release to download. If the results aren’t the show you want, edit the search.
        </div>

        {/* Editable query + audio */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
            placeholder="Search Nyaa…"
            className="candy-input"
            style={{ flex: 1, minWidth: 0, padding: '7px 10px', fontSize: 12, color: 'var(--text)' }}
          />
          <PrimaryBtn small accent={a} onClick={() => runSearch()}>Search</PrimaryBtn>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={S.label}>Audio</span>
          <FilterChip active={audio === 'sub'} accent={a} onClick={() => { setAudio('sub'); runSearch(query, 'sub'); }}>Sub</FilterChip>
          <FilterChip active={audio === 'dub'} accent={a} onClick={() => { setAudio('dub'); runSearch(query, 'dub'); }}>Dub</FilterChip>
        </div>

        {/* Results */}
        <div style={S.list}>
          {loading && <div style={S.muted}>Searching…</div>}
          {!loading && error && <div style={S.muted}>{error} Try editing the search above.</div>}
          {!loading && cands && cands.map((c, i) => {
            const active = i === sel;
            return (
              <button key={(c.magnet || '') + i} type="button" onClick={() => setSel(i)} style={S.row(active, a)}>
                <span style={{ flexShrink: 0, color: active ? a : 'var(--text-faint)', fontSize: 13 }}>{active ? '●' : '○'}</span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={S.title} title={c.title}>{c.title}</span>
                  <span style={S.meta}>
                    {c.group && <span style={S.badge}>{c.group}</span>}
                    <span style={{ color: c.is_batch ? a : 'var(--text-faint)', fontWeight: 600 }}>
                      {c.is_batch ? 'BATCH' : (c.episode_count ? `${c.episode_count} ep` : 'single ep')}
                    </span>
                    <span>{c.seeders} seeders</span>
                    {c.size_human && <span>· {c.size_human}</span>}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }}>
          <OutlinedBtn small onClick={onCancel}>Cancel</OutlinedBtn>
          <PrimaryBtn small accent={a} disabled={loading || !cands || !cands.length} onClick={confirm}>
            Download selected
          </PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

const S = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)',
  },
  panel: {
    width: 580, maxWidth: '92vw', maxHeight: '82vh',
    padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12,
  },
  label: { fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' },
  list: {
    flex: 1, minHeight: 120, maxHeight: '46vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 4,
    border: '1px solid var(--border)', borderRadius: 'var(--radius-md, 8px)', padding: 6,
  },
  muted: { color: 'var(--text-faint)', fontSize: 12, padding: '14px 8px', textAlign: 'center' },
  row: (active, a) => ({
    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
    padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
    border: `1px solid ${active ? a : 'transparent'}`,
    background: active ? `color-mix(in oklch, ${a} 12%, transparent)` : 'transparent',
    color: 'var(--text)', font: 'inherit',
  }),
  title: { fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
    fontVariantNumeric: 'tabular-nums',
  },
  badge: {
    padding: '1px 6px', borderRadius: 3, background: 'var(--surface-2)',
    color: 'var(--text-muted)', fontSize: 9.5,
  },
};

// Backlinks + Outgoing-links rail for the page view (Obsidian core-plugin
// parity). Reads the cached vault manifest (manifestReader) and derives both
// link directions client-side — no IPC per page:
//   - Outgoing: resolve the current page's `outbound_links` to their entries.
//   - Backlinks: reverse-scan every entry's `outbound_links` for this page.
//
// Resolution is best-effort: a wikilink target may be a full vault path, a bare
// basename, or an alias. Full-path matches win (exact); bare-name collisions
// (two pages sharing a basename) resolve to the first indexed — acceptable for
// a navigation aid. Sourced from Citadel's manifest, which carries the body
// link-graph; foreign/added vaults whose Rust manifest lacks `outbound_links`
// show empty groups (Rust link-computation parity is a logged follow-up).

import { useMemo } from 'react';
import { useManifestData } from '../lib/manifestReader.js';
import { navigate } from '../router.js';
import { encodePagePath } from './SidebarBrowser.jsx';
import { basename, buildIndex, resolveTarget } from '../lib/linkGraph.js';

function LinkGroup({ title, items, emptyLabel }) {
  return (
    <section style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '12px 16px 6px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div style={{ padding: '2px 16px 8px', fontSize: 12, color: 'var(--text-faint)' }}>{emptyLabel}</div>
      ) : items.map(e => (
        <button
          key={e.path}
          type="button"
          onClick={() => navigate('/page/' + encodePagePath(e.path))}
          onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--surface-2)'; }}
          onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent'; }}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '6px 16px', borderRadius: 0,
          }}
        >
          <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {e.title || basename(e.path)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {e.path}
          </div>
        </button>
      ))}
    </section>
  );
}

export default function PageLinksPanel({ filePath, accent, onClose }) {
  const manifest = useManifestData();

  const { outgoing, backlinks, indexed } = useMemo(() => {
    const entries = manifest?.entries;
    if (!Array.isArray(entries)) return { outgoing: [], backlinks: [], indexed: true };
    const idx = buildIndex(entries);
    const selfPath = (filePath || '').replace(/\.md$/i, '').toLowerCase();
    const self = idx.byPath.get(selfPath) || null;
    if (!self) return { outgoing: [], backlinks: [], indexed: false };

    const outSeen = new Set();
    const out = [];
    for (const l of self.outbound_links || []) {
      const tgt = resolveTarget(l.target, idx);
      if (!tgt || tgt.path === self.path || outSeen.has(tgt.path)) continue;
      outSeen.add(tgt.path);
      out.push(tgt);
    }

    const backSeen = new Set();
    const back = [];
    for (const e of entries) {
      if (e.path === self.path || !Array.isArray(e.outbound_links)) continue;
      for (const l of e.outbound_links) {
        const tgt = resolveTarget(l.target, idx);
        if (tgt && tgt.path === self.path) {
          if (!backSeen.has(e.path)) { backSeen.add(e.path); back.push(e); }
          break;
        }
      }
    }

    const byTitle = (a, b) => (a.title || a.path).localeCompare(b.title || b.path);
    out.sort(byTitle);
    back.sort(byTitle);
    return { outgoing: out, backlinks: back, indexed: true };
  }, [manifest, filePath]);

  return (
    <aside style={{
      width: 280, flexShrink: 0, borderLeft: '1px solid var(--border)',
      background: 'var(--surface)', display: 'flex', flexDirection: 'column',
      minHeight: 0, overflow: 'hidden',
      ...(accent ? { '--accent': accent } : {}),
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>Links</span>
        <button
          type="button" onClick={onClose} title="Close links panel"
          style={{ background: 'transparent', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 2 }}
        >×</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '4px 0 24px' }}>
        {!indexed && (
          <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-faint)' }}>
            This page isn’t in the vault manifest yet.
          </div>
        )}
        {indexed && (
          <>
            <LinkGroup title="Outgoing links" items={outgoing} emptyLabel="No outgoing links" />
            <LinkGroup title="Backlinks" items={backlinks} emptyLabel="No backlinks" />
          </>
        )}
      </div>
    </aside>
  );
}

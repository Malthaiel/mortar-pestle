// Deadlock page pane — dispatches by path shape:
//   Coaching/Scrim     → the scrims landing blurb
//   <scrim> (a bare folder)     → the empty-scrim blurb
//   anything else               → the read-only markdown reader (react-markdown +
//                                 GFM, client-side wikilink transform).
//
// Scrim Teardown (2026-07-26): the scrim Overview / Match / report / segments
// panes are gone with the pages they mounted. A scrim folder holds nothing, so
// there is nothing left to route into.
//
// Why the reader is client-side (not vault_render_reference): the shared Rust
// renderer resolves wikilinks against the ACTIVE (content) vault's manifest — a
// known, accepted cross-vault degradation (see render/mod.rs::render_path_in) —
// so a Deadlock page rendered while Citadel is active would mark every
// `[[…]]` link broken. Deadlock uses full-path wikilinks, so we
// transform them into in-module `/deadlock/<path>` links here.
//
// `nav` (default: the host router) lets the overlay host drive the same pane
// with local selection state — no router exists in that webview.

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@host/api.js';
import { navigate } from '@host/router.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import PageTitleHeader from '@host/components/PageTitleHeader.jsx';
import { getDeadlockIndex, resolveTarget } from './deadlockIndex.js';
import { SCRIM_BASE } from './DeadlockTree.jsx';

// Drop a leading YAML frontmatter block (the Rust reader strips it too).
function stripFrontmatter(src) {
  if (!src.startsWith('---\n')) return src;
  const close = src.indexOf('\n---', 4);
  if (close === -1) return src;
  const nl = src.indexOf('\n', close + 1);
  return nl === -1 ? '' : src.slice(nl + 1);
}

// Replace `[[target|display]]` / `[[target]]` (and `![[…]]`) with markdown links to
// /deadlock/<resolved>. Fence-aware: code spans/blocks pass through untouched.
// Unresolved short-forms degrade to plain text (no dead links).
function transformWikilinks(src, index) {
  const re = /!?\[\[([^\]]+)\]\]/g;
  return src
    .split(/(```[\s\S]*?```|`[^`]*`)/g)
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // code — leave verbatim
      return seg.replace(re, (_m, inner) => {
        let target = inner;
        let display = null;
        const pipe = target.indexOf('|');
        if (pipe !== -1) { display = target.slice(pipe + 1).trim(); target = target.slice(0, pipe); }
        const hash = target.indexOf('#');
        if (hash !== -1) target = target.slice(0, hash);
        target = target.trim();
        const label = (display || target.split('/').pop() || target).replace(/[[\]]/g, '\\$&');
        const resolved = resolveTarget(target, index);
        if (!resolved) return label; // unresolved → plain text, not a broken link
        return `[${label}](#/deadlock/${encodePagePath(resolved)})`;
      });
    })
    .join('');
}

// Anchor override bound to the pane's nav (router in the main app, local
// selection in the overlay host).
const mdComponents = (nav) => ({
  a({ href, children, ...rest }) {
    const h = href || '';
    if (h.startsWith('#/deadlock/')) {
      return (
        <a className="wikilink wikilink--internal" href={h}
          onClick={(e) => { e.preventDefault(); nav(h.slice(1)); }} {...rest}>
          {children}
        </a>
      );
    }
    if (/^https?:\/\//i.test(h)) {
      return <a href={h} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
    }
    return <a href={h} {...rest}>{children}</a>;
  },
});

function Shell({ children, accent, header }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {header}
      <div className="deadlock-reader deadlock-md" style={{ maxWidth: 820, margin: '0 auto', padding: '20px 28px 64px', '--accent': accent }}>
        {children}
      </div>
    </div>
  );
}

export default function DeadlockPage({ rest, accent, nav = navigate, overlay = false }) {
  const [raw, setRaw] = useState(null);
  const [err, setErr] = useState(null);
  const [index, setIndex] = useState(null);

  // A bare scrim folder is the only scrim shape left — it holds no pages, so it
  // gets a blurb rather than a 404 from the reader. A deeper path (a file someone
  // put there by hand) still falls through to the reader.
  const isScrimLanding = rest === SCRIM_BASE;
  const isScrimFolder = !!(rest && /^Deadlock\/Coaching\/Scrim\/[^/]+$/.test(rest));

  useEffect(() => { getDeadlockIndex().then(setIndex).catch(() => {}); }, []);

  useEffect(() => {
    if (!rest || isScrimFolder || isScrimLanding) { setRaw(null); setErr(null); return; }
    let cancelled = false;
    setRaw(null); setErr(null);
    api.getRawFile(rest + '.md', 'deadlock')
      .then((c) => { if (!cancelled) setRaw(c); })
      .catch((e) => { if (!cancelled) setErr(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, [rest, isScrimFolder, isScrimLanding]);

  const body = useMemo(
    () => (raw == null ? '' : transformWikilinks(stripFrontmatter(raw), index)),
    [raw, index],
  );

  if (isScrimLanding) return (
    <Shell accent={accent}>
      <h2>Scrims</h2>
      <p style={{ opacity: 0.7 }}>Expand the Scrim folder on the left, then right-click it for New Scrim (or right-click a scrim for Rename / Delete).</p>
    </Shell>
  );

  if (isScrimFolder) return (
    <Shell accent={accent}>
      <h2>{rest.split('/').pop()}</h2>
      <p style={{ opacity: 0.7 }}>This scrim is empty.</p>
    </Shell>
  );

  if (!rest) {
    return (
      <Shell accent={accent}>
        <h2>Deadlock</h2>
        <p style={{ opacity: 0.7 }}>Pick a page from the tree on the left.</p>
      </Shell>
    );
  }
  if (err) return <Shell accent={accent}><p style={{ color: 'var(--error)' }}>Couldn’t open this page: {err}</p></Shell>;
  if (raw == null) return <Shell accent={accent}><p style={{ opacity: 0.6 }}>Loading</p></Shell>;

  // Read-only title header (Deadlock is read-only for end users — no rename).
  const pageTitle = rest.split('/').pop() || rest;
  return (
    <Shell accent={accent} header={<PageTitleHeader title={pageTitle} accent={accent} />}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(nav)}>{body}</ReactMarkdown>
    </Shell>
  );
}

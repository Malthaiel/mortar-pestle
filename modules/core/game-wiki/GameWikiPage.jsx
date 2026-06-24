// Game Wiki reader — renders a read-only GameWiki-vault markdown page client-side
// (react-markdown + GFM), mirroring the Claude module's MessageContent pattern.
//
// Why client-side (not vault_render_reference): the shared Rust renderer resolves
// wikilinks against the ACTIVE (content) vault's manifest — a known, accepted
// cross-vault degradation (see render/mod.rs::render_path_in) — so a GameWiki page
// rendered while Citadel is active would mark every `[[Deadlock/…]]` link broken
// and unclickable. GameWiki uses full-path wikilinks, so we transform them here
// into in-module `/game-wiki/<path>` links and keep navigation inside the module.

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@host/api.js';
import { navigate } from '@host/router.js';
import { encodePagePath } from '@host/components/SidebarBrowser.jsx';
import { getGameWikiIndex, resolveTarget } from './gamewikiIndex.js';
import ScrimViewer from './ScrimViewer.jsx';
import ScrimListLanding from './ScrimListLanding.jsx';

// Coaching scrims render as the interactive ScrimViewer, not the markdown reader.
const SCRIM_BASE = 'Deadlock/Coaching/Scrim';

// Drop a leading YAML frontmatter block (the Rust reader strips it too).
function stripFrontmatter(src) {
  if (!src.startsWith('---\n')) return src;
  const close = src.indexOf('\n---', 4);
  if (close === -1) return src;
  const nl = src.indexOf('\n', close + 1);
  return nl === -1 ? '' : src.slice(nl + 1);
}

// Replace `[[target|display]]` / `[[target]]` (and `![[…]]`) with markdown links to
// /game-wiki/<resolved>. Fence-aware: code spans/blocks pass through untouched.
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
        return `[${label}](#/game-wiki/${encodePagePath(resolved)})`;
      });
    })
    .join('');
}

const MD_COMPONENTS = {
  a({ href, children, ...rest }) {
    const h = href || '';
    if (h.startsWith('#/game-wiki/')) {
      return (
        <a className="wikilink wikilink--internal" href={h}
          onClick={(e) => { e.preventDefault(); navigate(h.slice(1)); }} {...rest}>
          {children}
        </a>
      );
    }
    if (/^https?:\/\//i.test(h)) {
      return <a href={h} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
    }
    return <a href={h} {...rest}>{children}</a>;
  },
};

function Shell({ children, accent }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="gamewiki-reader gamewiki-md" style={{ maxWidth: 820, margin: '0 auto', padding: '20px 28px 64px', '--accent': accent }}>
        {children}
      </div>
    </div>
  );
}

export default function GameWikiPage({ rest, accent }) {
  const [raw, setRaw] = useState(null);
  const [err, setErr] = useState(null);
  const [index, setIndex] = useState(null);
  const isScrimFile = !!rest && rest.startsWith(SCRIM_BASE + '/');
  const isScrimLanding = rest === SCRIM_BASE;

  useEffect(() => { getGameWikiIndex().then(setIndex).catch(() => {}); }, []);

  useEffect(() => {
    if (!rest || isScrimFile || isScrimLanding) { setRaw(null); setErr(null); return; }
    let cancelled = false;
    setRaw(null); setErr(null);
    api.getRawFile(rest + '.md', 'gamewiki')
      .then((c) => { if (!cancelled) setRaw(c); })
      .catch((e) => { if (!cancelled) setErr(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, [rest, isScrimFile, isScrimLanding]);

  const body = useMemo(
    () => (raw == null ? '' : transformWikilinks(stripFrontmatter(raw), index)),
    [raw, index],
  );

  if (isScrimLanding) return <ScrimListLanding accent={accent} />;
  if (isScrimFile) return <ScrimViewer path={rest + '.md'} accent={accent} />;

  if (!rest) {
    return (
      <Shell accent={accent}>
        <h2>Game Wiki</h2>
        <p style={{ opacity: 0.7 }}>Pick a page from the tree on the left.</p>
      </Shell>
    );
  }
  if (err) return <Shell accent={accent}><p style={{ color: 'var(--error)' }}>Couldn’t open this page: {err}</p></Shell>;
  if (raw == null) return <Shell accent={accent}><p style={{ opacity: 0.6 }}>Loading…</p></Shell>;

  return (
    <Shell accent={accent}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{body}</ReactMarkdown>
    </Shell>
  );
}

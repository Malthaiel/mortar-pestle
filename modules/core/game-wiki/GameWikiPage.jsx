// Game Wiki page pane — dispatches by path shape (GameWiki Unification Phase 4):
//   <scrim>/Overview            → OverviewPage (scrim-level editor)
//   <scrim>/Matches/Match <n>   → MatchPage (per-match editor)
//   <scrim>/Report|Coaching/<t> → VodReportView inline (sidecar-driven views)
//   anything else               → the read-only markdown reader (react-markdown +
//                                 GFM, client-side wikilink transform).
//
// Why the reader is client-side (not vault_render_reference): the shared Rust
// renderer resolves wikilinks against the ACTIVE (content) vault's manifest — a
// known, accepted cross-vault degradation (see render/mod.rs::render_path_in) —
// so a GameWiki page rendered while Citadel is active would mark every
// `[[Deadlock/…]]` link broken. GameWiki uses full-path wikilinks, so we
// transform them into in-module `/game-wiki/<path>` links here.
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
import { getGameWikiIndex, resolveTarget } from './gamewikiIndex.js';
import { SCRIM_BASE } from './GameWikiTree.jsx';
import { sidecarPath, resolveReviewTranscript, matchPath } from './matchData.js';
import OverviewPage from './OverviewPage.jsx';
import MatchPage from './MatchPage.jsx';
import VodReportView from './VodReportView.jsx';
import CommsTranscriptView from './CommsTranscriptView.jsx';

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

// Anchor override bound to the pane's nav (router in the main app, local
// selection in the overlay host).
const mdComponents = (nav) => ({
  a({ href, children, ...rest }) {
    const h = href || '';
    if (h.startsWith('#/game-wiki/')) {
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

// M1: the inline per-match report pane. Final replaces first (locked decision 2):
// render the .matchfinal sidecar when it exists, else .matchreport (whose view
// banners itself as not-yet-coach-reviewed). Probed per mount — a fresh generate
// remounts via the route key.
function MatchReportPane({ folder, n, tab, rest, accent, nav }) {
  const [sp, setSp] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.getRawFileMeta(sidecarPath(folder, n, 'matchfinal'), 'gamewiki')
      .then(() => { if (!cancelled) setSp(sidecarPath(folder, n, 'matchfinal')); })
      .catch(() => { if (!cancelled) setSp(sidecarPath(folder, n, 'matchreport')); });
    return () => { cancelled = true; };
  }, [folder, n]);
  if (!sp) return <Shell accent={accent}><p style={{ opacity: 0.6 }}>Loading…</p></Shell>;
  const onTabChange = (t) => {
    const to = `${folder}/Matches/Match ${n}/${t}`;
    if (to !== rest) nav('/game-wiki/' + encodePagePath(to));
  };
  return (
    <VodReportView inline variant="match" tab={tab} onTabChange={onTabChange}
      sidecarPath={sp}
      feedbackPath={sidecarPath(folder, n, 'matchfeedback')}
      mdPath={matchPath(folder, n)} accent={accent} />
  );
}

// M1: the two per-match transcript pages (locked decision 10 — comms and review
// stamps land on separate pages). Comms reads the match's own transcript; review
// resolves through the ONE accessor (per-match .reviewcomms, else the M8-adopted
// scrim-level .vodcomms on single-match scrims).
function MatchSegmentsPane({ folder, n, review, accent }) {
  const [resolved, setResolved] = useState(review ? undefined : { path: sidecarPath(folder, n, 'comms'), scrimLevel: false });
  useEffect(() => {
    if (!review) { setResolved({ path: sidecarPath(folder, n, 'comms'), scrimLevel: false }); return undefined; }
    let cancelled = false;
    setResolved(undefined);
    resolveReviewTranscript(api, folder, n)
      .then((r) => { if (!cancelled) setResolved(r); })
      .catch(() => { if (!cancelled) setResolved(null); });
    return () => { cancelled = true; };
  }, [review, folder, n]);
  const title = review ? 'Review Segments' : 'Comms Segments';
  return (
    <Shell accent={accent} header={<PageTitleHeader title={title} accent={accent} />}>
      {resolved === undefined && <p style={{ opacity: 0.6 }}>Loading…</p>}
      {resolved === null && (
        <p style={{ opacity: 0.7 }}>
          {review ? 'No review recording for this match yet.' : 'No comms transcript for this match yet.'}
        </p>
      )}
      {resolved && (
        <>
          {resolved.scrimLevel && (
            <p style={{ opacity: 0.6, fontSize: 12 }}>Scrim-level review recording (adopted for this single-match scrim).</p>
          )}
          <CommsTranscriptView sidecarPath={resolved.path} />
        </>
      )}
    </Shell>
  );
}

function Shell({ children, accent, header }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {header}
      <div className="gamewiki-reader gamewiki-md" style={{ maxWidth: 820, margin: '0 auto', padding: '20px 28px 64px', '--accent': accent }}>
        {children}
      </div>
    </div>
  );
}

export default function GameWikiPage({ rest, accent, nav = navigate, overlay = false }) {
  const [raw, setRaw] = useState(null);
  const [err, setErr] = useState(null);
  const [index, setIndex] = useState(null);

  // Scrim dispatch by path shape. A bare scrim-folder path lands on Overview.
  const sm = rest ? rest.match(/^(Deadlock\/Coaching\/Scrim\/[^/]+)(?:\/(.+))?$/) : null;
  const scrimFolder = sm ? sm[1] : null;
  const scrimTail = sm ? (sm[2] || 'Overview') : null;
  const isScrimLanding = rest === SCRIM_BASE;
  const isScrim = !!scrimFolder && !isScrimLanding;

  useEffect(() => { getGameWikiIndex().then(setIndex).catch(() => {}); }, []);

  useEffect(() => {
    if (!rest || isScrim || isScrimLanding) { setRaw(null); setErr(null); return; }
    let cancelled = false;
    setRaw(null); setErr(null);
    api.getRawFile(rest + '.md', 'gamewiki')
      .then((c) => { if (!cancelled) setRaw(c); })
      .catch((e) => { if (!cancelled) setErr(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, [rest, isScrim, isScrimLanding]);

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

  if (isScrim) {
    if (scrimTail === 'Overview') return <OverviewPage folder={scrimFolder} accent={accent} nav={nav} overlay={overlay} />;
    // M1: per-match routes. Bare `Matches/Match N` = the match Overview (editor);
    // a tail = a report view (VodReportView variant=match tab) or a segments page.
    const mm = scrimTail.match(/^Matches\/Match (\d+)(?:\/([\w-]+))?$/);
    if (mm) {
      const n = Number(mm[1]);
      const tail = mm[2] || null;
      if (!tail) return <MatchPage key={`${scrimFolder}/${n}`} folder={scrimFolder} n={n} accent={accent} overlay={overlay} />;
      if (tail === 'comms-segments' || tail === 'review-segments') {
        return <MatchSegmentsPane key={`${scrimFolder}/${n}/${tail}`} folder={scrimFolder} n={n}
          review={tail === 'review-segments'} accent={accent} />;
      }
      return <MatchReportPane key={`${scrimFolder}/${n}`} folder={scrimFolder} n={n}
        tab={tail} rest={rest} accent={accent} nav={nav} />;
    }
    // A stray real file inside a scrim folder — fall through to the reader shape
    // is not worth supporting; point at the tree instead.
    return (
      <Shell accent={accent}>
        <p style={{ opacity: 0.7 }}>Pick a page from this scrim in the tree on the left.</p>
      </Shell>
    );
  }

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

  // Read-only title header (Game Wiki is read-only for end users — no rename).
  const pageTitle = rest.split('/').pop() || rest;
  return (
    <Shell accent={accent} header={<PageTitleHeader title={pageTitle} accent={accent} />}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(nav)}>{body}</ReactMarkdown>
    </Shell>
  );
}

// Global wikilink hover preview. Listens at the document level for hovers
// over .wikilink--internal anchors emitted by the server-side markdown
// renderer; after a 250ms dwell, fetches the target page and shows a
// floating preview card with the page title + ~200 words of prose.
//
// Implementation notes:
//   - The renderer puts the resolved path in data-target. We use that to
//     call api.getPage(target).
//   - The preview is positioned absolutely below the link, with a 6px gap.
//     If the link is in the bottom third of the viewport, the preview
//     flips above it instead.
//   - Hovering inside the preview keeps it open (the popover handles its
//     own mouseleave with a grace timer).
//   - One preview at a time. Hovering a different link before close cancels
//     the in-flight one.

import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const HOVER_DELAY  = 250;
const LEAVE_GRACE  = 200;
const PREVIEW_W    = 360;
const PREVIEW_MAX_H = 240;
const PREVIEW_PREVIEW_CHARS = 320;

export default function WikilinkHoverPreview() {
  const [state, setState] = useState(null);
  // state: null | { x, y, above, target, status, title, body }

  const enterTimer = useRef(null);
  const leaveTimer = useRef(null);
  const currentTarget = useRef(null);
  const popRef = useRef(null);
  const hoveringPopover = useRef(false);

  useEffect(() => {
    const clearTimers = () => {
      if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null; }
      if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    };

    const scheduleClose = () => {
      clearTimers();
      leaveTimer.current = setTimeout(() => {
        if (!hoveringPopover.current) {
          currentTarget.current = null;
          setState(null);
        }
      }, LEAVE_GRACE);
    };

    const onOver = (e) => {
      const el = e.target.closest('.wikilink--internal');
      if (!el) return;
      const target = el.getAttribute('data-target');
      if (!target) return;
      if (currentTarget.current === target) return;
      clearTimers();
      currentTarget.current = target;
      const rect = el.getBoundingClientRect();
      const above = rect.top > window.innerHeight * 0.66;
      const x = Math.min(window.innerWidth - PREVIEW_W - 12, Math.max(12, rect.left));
      const y = above
        ? rect.top - 8 - PREVIEW_MAX_H
        : rect.bottom + 8;
      enterTimer.current = setTimeout(() => {
        setState({ x, y, above, target, status: 'loading', title: null, body: null });
        api.getPage(target)
          .then(res => {
            if (currentTarget.current !== target) return;
            const body = extractPreview(res?.body || res?.content || '');
            setState(s => s && s.target === target
              ? { ...s, status: 'ready', title: res?.title || titleFromPath(target), body }
              : s);
          })
          .catch(() => {
            if (currentTarget.current !== target) return;
            setState(s => s && s.target === target ? { ...s, status: 'error' } : s);
          });
      }, HOVER_DELAY);
    };

    const onOut = (e) => {
      const el = e.target.closest?.('.wikilink--internal');
      if (!el) return;
      scheduleClose();
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      clearTimers();
    };
  }, []);

  if (!state) return null;

  return (
    <div
      ref={popRef}
      className="candy-card"
      onMouseEnter={() => { hoveringPopover.current = true; }}
      onMouseLeave={() => {
        hoveringPopover.current = false;
        currentTarget.current = null;
        setState(null);
      }}
      style={{
        position: 'fixed',
        left: state.x, top: state.y,
        width: PREVIEW_W,
        maxHeight: PREVIEW_MAX_H,
        padding: '12px 14px',
        zIndex: 1400,
        overflow: 'hidden',
        animation: 'fadeIn 0.14s ease',
        pointerEvents: 'auto',
      }}
    >
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600,
        marginBottom: 4,
      }}>{state.target}</div>
      <div style={{
        fontSize: 13, fontWeight: 600, color: 'var(--text)',
        letterSpacing: '-0.01em',
        marginBottom: 6,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{state.title || titleFromPath(state.target)}</div>
      {state.status === 'loading' && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Loading…</div>
      )}
      {state.status === 'error' && (
        <div style={{ fontSize: 11, color: '#e07b7b' }}>Could not load preview.</div>
      )}
      {state.status === 'ready' && (
        <div style={{
          fontSize: 12, color: 'var(--text-muted)',
          lineHeight: 1.55,
          maxHeight: PREVIEW_MAX_H - 60,
          overflow: 'hidden',
        }}>{state.body || 'No preview text.'}</div>
      )}
    </div>
  );
}

function extractPreview(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // Strip frontmatter
  let text = raw.replace(/^---[\s\S]*?---\s*/m, '');
  // Strip HTML
  text = text.replace(/<[^>]*>/g, '');
  // Strip markdown syntax (basic)
  text = text
    .replace(/^#+\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[[^\]]*\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (_m, p1, p2) => p2 ? p2.slice(1) : p1)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
  return text.length > PREVIEW_PREVIEW_CHARS
    ? text.slice(0, PREVIEW_PREVIEW_CHARS) + '…'
    : text;
}

function titleFromPath(p) {
  const leaf = p.split('/').pop().replace(/\.md$/, '');
  return leaf || p;
}

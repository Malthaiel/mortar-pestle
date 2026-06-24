// Vertical mini-map rendered against the right edge of a scrolling page
// container. Reads the container's H1/H2/H3 elements after each html
// update, draws a thin bar per heading proportional to its position in
// the document, highlights the one currently in view, and supports
// click-to-jump.
//
// Renders nothing if there are fewer than 2 headings — a one-section page
// doesn't need an outline.
//
// Pass:
//   containerRef — ref to the element that scrolls (the parent of the
//                  rendered markdown)
//   contentKey   — opaque key that changes whenever the rendered HTML
//                  changes (e.g. the html string itself). Used to re-scan.
//   accent       — accent color for the active heading.

import { useEffect, useRef, useState } from 'react';

export default function PageMinimap({ containerRef, contentKey, accent }) {
  const [headings, setHeadings] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const rafRef = useRef(null);

  // Re-scan whenever content changes.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    // Defer until the next frame so dangerouslySetInnerHTML has actually
    // mounted the new children.
    const tid = setTimeout(() => {
      const nodes = root.querySelectorAll('h1, h2, h3');
      const out = [];
      nodes.forEach(n => {
        const text = (n.textContent || '').trim();
        if (!text) return;
        out.push({ el: n, level: parseInt(n.tagName.slice(1), 10), text });
      });
      setHeadings(out);
    }, 50);
    return () => clearTimeout(tid);
  }, [contentKey, containerRef]);

  // Track which heading is in view via scroll listener.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || headings.length === 0) return;
    const onScroll = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const rootTop = root.getBoundingClientRect().top;
        let best = 0;
        for (let i = 0; i < headings.length; i++) {
          const top = headings[i].el.getBoundingClientRect().top - rootTop;
          if (top <= 80) best = i;
          else break;
        }
        setActiveIdx(best);
      });
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [headings, containerRef]);

  if (headings.length < 2) return null;

  const accentColor = accent || 'var(--text)';

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        right: 6, top: 60, bottom: 60,
        width: 32,
        display: 'flex', flexDirection: 'column', gap: 4,
        alignItems: 'flex-end', justifyContent: 'flex-start',
        zIndex: 4,
        pointerEvents: 'none',
      }}
    >
      {headings.map((h, i) => (
        <MinimapBar
          key={i}
          heading={h}
          active={i === activeIdx}
          accent={accentColor}
        />
      ))}
    </div>
  );
}

function MinimapBar({ heading, active, accent }) {
  const [hover, setHover] = useState(false);
  const width = heading.level === 1 ? 22 : (heading.level === 2 ? 18 : 12);
  return (
    <div style={{ position: 'relative', pointerEvents: 'auto' }}>
      <button
        type="button"
        onClick={() => heading.el.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={heading.text}
        style={{
          width, height: 4,
          background: active
            ? accent
            : (hover ? 'var(--text-muted)' : 'var(--border-2)'),
          border: 'none', padding: 0,
          borderRadius: 2,
          cursor: 'pointer',
          opacity: active ? 1 : (hover ? 0.85 : 0.55),
          transition: 'background 120ms ease, opacity 120ms ease, transform 120ms ease',
          transform: hover ? 'translateX(-3px)' : 'none',
        }}
      />
      {hover && (
        <div style={{
          position: 'absolute',
          right: width + 8, top: -4,
          background: 'var(--surface)',
          border: '1px solid var(--border-2)',
          borderRadius: 4,
          padding: '4px 8px',
          fontSize: 11, fontWeight: 500,
          color: 'var(--text)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          boxShadow: '0 6px 14px rgba(0,0,0,0.18)',
          maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis',
          zIndex: 6,
        }}>{heading.text}</div>
      )}
    </div>
  );
}

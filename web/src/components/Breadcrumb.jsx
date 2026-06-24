// Persistent breadcrumb header rendered at the top of the main pane.
// Lives inside AppShell so it persists across route changes.
//
// Builds a trail from the current route:
//   /pulse                  → "Pulse"
//   /pulse/calendar         → "Pulse / Calendar"
//   /knowledge/deadlock     → "Knowledge / Deadlock"
//   /knowledge/deadlock/heroes/Vyper.md
//                            → "Knowledge / Deadlock / Heroes / Vyper"
//   /page/Knowledge/Deadlock/Heroes/Vyper.md
//                            → "Knowledge / Deadlock / Heroes / Vyper"
//   /infrastructure/templates/New Today Page.md
//                            → "Infrastructure / Templates / New Today Page"
//
// Each segment is clickable and navigates to that level. The final segment
// (the leaf) is not clickable — it's the current view.
//
// Hidden on:
//   - the player popout (its hash doesn't match here anyway)
//   - bare '/' before any redirect has fired
//
// The breadcrumb is also the host surface for the Phase 4 scroll-position
// dot (a small accent dot crawls along it tracking scroll progress through
// the active page). The dot is added later, not in Phase 1.

function buildTrail(route) {
  if (!route || !route.page) return [];
  if (route.page === 'pulse') {
    const trail = [{ label: 'Pulse', href: '#/pulse', isLeaf: !route.sub }];
    if (route.sub) {
      trail.push({ label: prettifySlug(route.sub), href: null, isLeaf: true });
    }
    return trail;
  }

  if (route.page === 'tools') {
    // Tools routes (e.g. the Anime player) own their in-pane chrome —
    // no global breadcrumb crumb.
    return [];
  }

  return [];
}

function prettifySlug(slug) {
  return slug
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

export default function Breadcrumb({ route, accent }) {
  // The Knowledge / Infrastructure / Pulse sections and the page reader
  // (/page/*) intentionally show no path-trail breadcrumb — it was removed as
  // visual clutter. Docs (incl. the folded-in Releases tab) renders its own
  // in-pane header, so it builds no trail either.
  if (route?.page === 'page' || route?.page === 'vault'
      || route?.page === 'pulse') return null;
  const trail = buildTrail(route);
  if (trail.length === 0) return null;
  const accentColor = accent || 'var(--text)';

  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        flexShrink: 0,
        padding: '10px 20px 8px',
        borderBottom: '1px solid var(--border-soft)',
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', gap: 8,
        overflowX: 'auto', overflowY: 'hidden',
        fontFamily: 'var(--font-body)',
        position: 'relative',
        zIndex: 1,
      }}
    >
      {trail.map((seg, i) => (
        <span
          key={i}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            flexShrink: 0,
          }}
        >
          {i > 0 && (
            <span aria-hidden style={{
              color: 'var(--text-faint)',
              fontSize: 11, fontWeight: 400,
            }}>›</span>
          )}
          {seg.href && !seg.isLeaf
            ? <BreadcrumbLink href={seg.href} accent={accentColor}>{seg.label}</BreadcrumbLink>
            : <BreadcrumbLeaf accent={accentColor} muted={!seg.isLeaf}>{seg.label}</BreadcrumbLeaf>}
        </span>
      ))}
    </nav>
  );
}

function BreadcrumbLink({ href, accent, children }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        window.location.hash = href.startsWith('#') ? href.slice(1) : href;
      }}
      style={{
        color: 'var(--text-muted)',
        fontSize: 12, fontWeight: 500,
        textDecoration: 'none',
        padding: '2px 4px',
        borderRadius: 4,
        cursor: 'pointer',
        transition: 'color 80ms ease, background 80ms ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.color = accent;
        e.currentTarget.style.background = `color-mix(in oklch, ${accent} 8%, transparent)`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color = 'var(--text-muted)';
        e.currentTarget.style.background = 'transparent';
      }}
    >{children}</a>
  );
}

function BreadcrumbLeaf({ accent, muted, children }) {
  return (
    <span style={{
      fontSize: 12, fontWeight: muted ? 500 : 600,
      color: muted ? 'var(--text-muted)' : 'var(--text)',
      padding: '2px 4px',
      letterSpacing: '-0.005em',
    }}>{children}</span>
  );
}

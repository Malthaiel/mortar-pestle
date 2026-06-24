// Per-Area release history. Shared by two hosts: a module settings page's
// "Releases" section (module-backed Areas) and the standalone Releases settings
// tab (module-less Areas). Shows that Area's SHIPPED releases only — the same
// AreaGroup renderer the Release History timeline uses, filtered to one Area.
// headerLink={false}: this view IS the Area destination, so its headers stay
// plain labels rather than self-referential nav buttons.

import { useReleases } from '../../hooks/useReleases.js';
import { AreaGroup } from './DocsReleasesTab.jsx';

export default function AreaReleasesView({ area, accent }) {
  const { releases, loading } = useReleases();
  const accentColor = accent || 'var(--accent)';

  // Each release contributes at most one matching Area object (legacy flat
  // blocks are named 'General', so area='General' picks them up too).
  const rows = (releases || [])
    .map(r => ({ release: r, areaObj: (r.areas || []).find(a => a.name === area) }))
    .filter(x => x.areaObj);

  if (loading) return <Empty>Loading release history…</Empty>;
  if (!area) return <Empty>No release area for this module.</Empty>;
  if (!rows.length) return <Empty>No shipped releases for {area} yet.</Empty>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
        textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 600,
      }}>
        {area} · {rows.length} {rows.length === 1 ? 'release' : 'releases'}
      </div>
      {rows.map(({ release, areaObj }) => (
        <div key={release.version} className="candy-section" style={{ padding: '14px 16px' }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12,
          }}>
            <span style={{
              fontSize: 13, fontWeight: 700, color: 'var(--text)',
              fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
            }}>
              {release.versionLabel || release.version}
            </span>
            {release.tag && (
              <span style={{
                fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
                border: '1px solid var(--border-2)', borderRadius: 4, padding: '1px 7px',
                textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>
                {release.tag}
              </span>
            )}
            <span style={{
              fontSize: 11, color: 'var(--text-faint)', marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
            }}>
              {release.date}
            </span>
          </div>
          {/* Force the in-context area object non-synthetic so its sections
              render flush without a redundant header (we draw our own above). */}
          <AreaGroup
            area={{ ...areaObj, synthetic: true }}
            version={release.version}
            accent={accentColor}
            headerLink={false}
          />
        </div>
      ))}
    </div>
  );
}

function Empty({ children }) {
  return (
    <div style={{
      padding: '14px 16px',
      background: 'var(--surface-2)',
      border: '1px dashed var(--border)',
      borderRadius: 'var(--radius-md)',
      fontSize: 12, lineHeight: 1.5,
      color: 'var(--text-muted)',
    }}>{children}</div>
  );
}

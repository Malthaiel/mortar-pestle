// Per-Area release history. Shared by two hosts: a module settings page's
// "Releases" section (the Areas that module owns, e.g. Library = Music + Movies
// & TV + Anime) and the standalone Releases settings tab (one module-less Area).
// Shows those Areas' SHIPPED releases only — the same AreaGroup renderer the
// Release History timeline uses, filtered to the given Areas.
// headerLink={false}: this view IS the Area destination, so its headers stay
// plain labels rather than self-referential nav buttons.

import { useReleases } from '../../hooks/useReleases.js';
import { AreaGroup } from './DocsReleasesTab.jsx';
import { eyebrowStyle } from '../../components/ui/Eyebrow.jsx';

export default function AreaReleasesView({ areas, accent }) {
  const { releases, loading } = useReleases();
  const accentColor = accent || 'var(--accent)';
  const label = (areas || []).join(', ');

  // One card per release holding every matching Area (legacy flat blocks are
  // named 'General', so areas=['General'] picks them up too).
  const rows = (releases || [])
    .map(r => ({ release: r, areaObjs: (r.areas || []).filter(a => areas?.includes(a.name)) }))
    .filter(x => x.areaObjs.length);

  if (loading) return <Empty>Loading release history</Empty>;
  if (!areas?.length) return <Empty>No release area for this module.</Empty>;
  if (!rows.length) return <Empty>No shipped releases for {label} yet.</Empty>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...eyebrowStyle }}>
        {label} · {rows.length} {rows.length === 1 ? 'release' : 'releases'}
      </div>
      {rows.map(({ release, areaObjs }) => (
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
                letterSpacing: '0.04em',
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
          {/* synthetic = no Area header: redundant for a single Area (the
              eyebrow names it), needed when several share the card. */}
          {areaObjs.map(areaObj => (
            <AreaGroup
              key={areaObj.name}
              area={{ ...areaObj, synthetic: areas.length === 1 }}
              version={release.version}
              accent={accentColor}
              headerLink={false}
            />
          ))}
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

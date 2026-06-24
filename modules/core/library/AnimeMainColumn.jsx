// The full right-hand column of an anime detail page (owned + discovery), in MAL
// reading order: trailer → synopsis → background → credits → themes →
// recommendations. The two text sections (Synopsis / Background) are owned here;
// every other block is a self-skipping sibling, so the column passes data
// straight through and each child renders nothing when it has nothing to show.
// Mounted as AnimeDetailHeader's rightColumn on both SeriesDetail (owned) and
// DiscoveryDetail (not-owned), replacing the old inline synopsis + AnimeCredits.

import AnimeCredits from './AnimeCredits.jsx';
import AnimeThemes from './AnimeThemes.jsx';
import AnimeRecommendations from './AnimeRecommendations.jsx';

// Mirrors the AnimeCredits / AnimeThemes / AnimeRecommendations SectionHeader:
// 11px mono uppercase faint label with a bottom border.
function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '0 0 6px', borderBottom: '1px solid var(--border)', marginBottom: 12,
    }}>{children}</div>
  );
}

// Body-text block (Synopsis / Background) — same prose styling as the old
// DiscoveryDetail inline synopsis (13px muted, 1.6 line-height, pre-wrap).
function TextSection({ title, body }) {
  if (!body) return null;
  return (
    <section>
      <SectionHeader>{title}</SectionHeader>
      <p style={{
        margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--text-muted)',
        maxWidth: 760, whiteSpace: 'pre-wrap',
      }}>{body}</p>
    </section>
  );
}

export default function AnimeMainColumn({ malId, accent, synopsis, background, openings, endings }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <TextSection title="Synopsis" body={synopsis} />
      <TextSection title="Background" body={background} />
      <AnimeCredits malId={malId} accent={accent} />
      <AnimeThemes openings={openings} endings={endings} accent={accent} />
      <AnimeRecommendations malId={malId} accent={accent} />
    </div>
  );
}

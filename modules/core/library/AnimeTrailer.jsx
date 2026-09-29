// Promotional-video thumbnail for one anime. The whole card is a candy button;
// clicking it opens the YouTube PV in the in-app browser (public youtube URLs
// pass the browser's nav allow-list). Pure presentational — the trailer object
// ({ youtubeId, url, image }) arrives already resolved. Renders nothing without
// a URL to open.

import { IconPlayMark } from '@host/components/icons.jsx';

// A card's `Trailer:` frontmatter is a plain YouTube URL string (written by
// tv_library.rs); the live MAL detail hands over a resolved object instead.
// Normalise here, beside the only consumer, so both callers pass the same shape.
// ponytail: YouTube only — that is the only host either source emits.
export function normalizeTrailer(trailer) {
  if (!trailer) return null;
  if (typeof trailer === 'object') return trailer.url ? trailer : null;
  const m = String(trailer).match(/(?:[?&]v=|youtu\.be\/)([\w-]{6,})/);
  return m
    ? { youtubeId: m[1], url: String(trailer), image: `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` }
    : null;
}

export default function AnimeTrailer({ trailer, accent, fill }) {
  if (!trailer || !trailer.url) return null;

  const go = () => {
    window.location.hash = '/tools/browser/' + encodeURIComponent(trailer.url);
  };

  // fill = match the header top-row height while staying 16:9 (the card derives its
  // width from --panel-h). Rendered as a FLAT clickable card (not a candy button) so
  // its own border + surface-depth shadow match the flat stats panel beside it exactly
  // — the ▶ overlay signals it's playable; hover tints the border. Non-fill = 16:9 at
  // container width.
  return (
    <button
      type="button"
      onClick={go}
      title="Watch trailer"
      className="anime-trailer-btn"
      style={{ '--accent': accent || 'var(--accent)', width: fill ? 'auto' : '100%' }}
    >
      <div className={fill ? 'anime-trailer-card is-fill' : 'anime-trailer-card'}>
        {trailer.image && <img src={trailer.image} alt="" loading="lazy" />}
        <span><IconPlayMark size={22}/></span>
      </div>
    </button>
  );
}

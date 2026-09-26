// Credits for one album. The default export mounts below the album header in
// AlbumDetail and is now only "More from this artist" (the artist's MusicBrainz
// discography; owned ones link to the library detail, the rest seed a Browse
// search). Performers moved into the header's tab strip (AlbumPerformers
// below); Related and the Release details tab were deleted, all
// user-directed 2026-09-26.

import { useEffect, useMemo, useRef, useState } from 'react';
import { musicApi, useMbRefreshTick } from './api.js';
import BrowseResultCard from './BrowseResultCard.jsx';
import PosterRow from '@modules/core/library/PosterRow.jsx';
import { encodePath } from '../paths.js';
import { navigate as go } from '@host/router.js';
import { toBrowse } from './util.js';

const toAlbum = (path) => go('/tools/library/music/downloaded/' + encodePath(path));


export default function MusicCredits({ album, accent }) {
  const artist = album?.artist || '';
  const selfId = album?.providerId || null;

  const [library, setLibrary] = useState([]);    // owned albums (for the owned map)
  const [discography, setDiscography] = useState(null); // artist's MB release groups
  const [moreExpanded, setMoreExpanded] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    musicApi.listAlbums().then(l => { if (!cancelled) setLibrary(l || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Resolve the artist on MusicBrainz, then pull their discography. Both are
  // saved answers after the first visit; a background re-check that finds new
  // releases bumps mbTick and the row re-reads in place (blanked only when the
  // artist itself changes).
  const mbTick = useMbRefreshTick();
  useEffect(() => { setDiscography(null); }, [artist]);
  useEffect(() => {
    if (!artist) { setDiscography([]); return; }
    const my = ++reqId.current;
    (async () => {
      try {
        const hits = await musicApi.searchArtists(artist);
        const mbid = hits && hits[0] && hits[0].mbid;
        if (!mbid) { if (my === reqId.current) setDiscography([]); return; }
        const rgs = await musicApi.artistReleaseGroups(mbid);
        if (my === reqId.current) setDiscography(rgs || []);
      } catch {
        if (my === reqId.current) setDiscography([]);
      }
    })();
  }, [artist, mbTick]);

  const ownedByProvider = useMemo(() => {
    const m = new Map();
    library.forEach(a => { if (a.providerId) m.set(a.providerId, a.path); });
    return m;
  }, [library]);

  const more = useMemo(
    () => (discography || []).filter(r => r.mbid && r.mbid !== selfId),
    [discography, selfId],
  );
  // The rail renders the first MORE_CAP; "See All" expands to the full grid
  // in place (AnimeCredits' Staff pattern). User-directed 2026-09-26.
  const MORE_CAP = 10;
  const shownMore = moreExpanded ? more : more.slice(0, MORE_CAP);

  if (!album || more.length === 0) return null;

  return (
    // .film-below (library.css) = the header's own column: its side gutter and
    // centred measure, so the row's edges line up with the sleeve and the
    // tracklist at every pane width (user-directed 2026-09-26).
    <div className="film-below" style={{ paddingTop: 22, paddingBottom: 8 }}>
      <PosterRow
        title={`More from ${artist}`}
        accent={accent}
        colWidth={150}
        layout={moreExpanded ? 'grid' : 'row'}
        seeAllLabel={moreExpanded ? 'Show Less ↑' : 'See All →'}
        onSeeAll={more.length > MORE_CAP ? () => setMoreExpanded(e => !e) : undefined}
      >
        {shownMore.map(r => {
          const ownedPath = ownedByProvider.get(r.mbid);
          return (
            <BrowseResultCard
              key={r.mbid}
              result={r}
              accent={accent}
              inLibrary={!!ownedPath}
              onSelect={() => ownedPath ? toAlbum(ownedPath) : toBrowse(`${r.title} ${artist}`.trim())}
            />
          );
        })}
      </PosterRow>
    </div>
  );
}

// The Performers tab: release-level credits from MusicBrainz
// (music_release_personnel), main/featured artists plus producer, mixing,
// mastering and performer relations, one chip per person. Falls back to the
// primary album artist when a release carries no relationships.
export function AlbumPerformers({ album, accent }) {
  const artist = album?.artist || '';
  const selfId = album?.providerId || null;
  const [personnel, setPersonnel] = useState(null);     // null=loading, []=none/failed
  const persReq = useRef(0);

  // Release-level credits for THIS album (selfId is the release-group MBID).
  useEffect(() => {
    if (!selfId) { setPersonnel([]); return; }
    const my = ++persReq.current;
    setPersonnel(null);
    musicApi.releasePersonnel(selfId)
      .then(res => { if (my === persReq.current) setPersonnel((res && res.credits) || []); })
      .catch(() => { if (my === persReq.current) setPersonnel([]); });
  }, [selfId]);

  // Group flat credits into one entry per person, merging their roles in order.
  const performers = useMemo(() => {
    const order = [];
    const byKey = new Map();
    (personnel || []).forEach(c => {
      const key = c.mbid || c.name;
      if (!byKey.has(key)) { byKey.set(key, { name: c.name, roles: [] }); order.push(key); }
      const label = c.detail ? `${c.role} (${c.detail})` : c.role;
      const g = byKey.get(key);
      if (!g.roles.includes(label)) g.roles.push(label);
    });
    return order.map(k => byKey.get(k));
  }, [personnel]);

  if (personnel === null) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
        Loading credits…
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {performers.length > 0
        ? performers.map((p, i) => (
            <CreditChip
              key={p.name + i}
              name={p.name}
              role={p.roles.slice(0, 3).join(' · ') + (p.roles.length > 3 ? ` +${p.roles.length - 3}` : '')}
              accent={accent}
              onClick={() => toBrowse(p.name)}
            />
          ))
        : artist && <CreditChip name={artist} role="Primary artist" accent={accent} onClick={() => toBrowse(artist)} />}
    </div>
  );
}

function CreditChip({ name, role, accent, onClick }) {
  return (
    <button
      onClick={onClick}
      data-own-press
      className="candy-btn" data-shape="chip"
      style={{ '--accent': accent || 'var(--accent)' }}
      title={`Find ${name} on MusicBrainz`}
    >
      <span className="candy-face" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, padding: '4px 10px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{name}</span>
        {role && <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', color: 'var(--text-faint)' }}>{role}</span>}
      </span>
    </button>
  );
}

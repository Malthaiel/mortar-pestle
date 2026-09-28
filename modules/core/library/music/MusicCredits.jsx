// Two of the album page's header tabs: Discography (ArtistAlbums) and Credits
// (AlbumPerformers). Related and the Release details tab were deleted, all
// user-directed 2026-09-26.

import { useEffect, useMemo, useRef, useState } from 'react';
import { musicApi, useMbRefreshTick } from './api.js';
import BrowseResultCard from './BrowseResultCard.jsx';
import PosterRow from '@modules/core/library/PosterRow.jsx';
import { encodePath } from '../paths.js';
import { navigate as go } from '@host/router.js';
import { toBrowse } from './util.js';

const toAlbum = (path) => go('/tools/library/music/downloaded/' + encodePath(path));

const NOTE_STYLE = { fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' };

// The Discography tab: the artist's other albums, EPs and singles (their
// MusicBrainz discography), most played first, in a sliding row two covers
// tall (user-directed 2026-09-26).
// Owned ones open the library page, the rest seed a Browse search. It was a
// "More from" rail under the header until it became a tab (user-directed
// 2026-09-26).
export function ArtistAlbums({ album, accent }) {
  const artist = album?.artist || '';
  const selfId = album?.providerId || null;

  const [library, setLibrary] = useState([]);    // owned albums (for the owned map)
  const [discography, setDiscography] = useState(null); // artist's MB release groups
  const [all, setAll] = useState(false);          // Show All pressed
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
  useEffect(() => { setDiscography(null); setAll(false); }, [artist]);
  useEffect(() => {
    if (!artist) { setDiscography([]); return; }
    const my = ++reqId.current;
    (async () => {
      try {
        const hits = await musicApi.searchArtists(artist);
        const mbid = hits && hits[0] && hits[0].mbid;
        if (!mbid) { if (my === reqId.current) setDiscography([]); return; }
        const [rgs, listens] = await Promise.all([
          musicApi.artistReleaseGroups(mbid, true),
          musicApi.artistPopularity(mbid).catch(() => ({})),
        ]);
        // Most played first (ListenBrainz listens, user-directed 2026-09-26).
        // The sort is stable, so records nobody has played keep MusicBrainz's
        // newest-first order after them.
        const plays = (r) => listens[r.mbid] || 0;
        if (my === reqId.current) setDiscography([...(rgs || [])].sort((a, b) => plays(b) - plays(a)));
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
    // No live recordings: official or not, they crowd the studio records out
    // of the most-played top (user-directed 2026-09-26).
    () => (discography || []).filter(r => r.mbid && r.mbid !== selfId && !r.secondaryTypes?.includes('Live')),
    [discography, selfId],
  );

  if (discography === null) return <div style={NOTE_STYLE}>Loading albums</div>;
  if (more.length === 0) return <div style={NOTE_STYLE}>No other albums found</div>;

  return (
    <PosterRow accent={accent} colWidth={COL} rows={SLIDER_ROWS} arrows={false}>
      {(all ? more : more.slice(0, SLIDER_CAP)).map(r => {
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
      {/* The app's See All chip (MusicHome), as the slider's last column,
          both rows tall (user-directed 2026-09-26). */}
      {!all && more.length > SLIDER_CAP && (
        <div style={{ gridRow: `span ${SLIDER_ROWS}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <button onClick={() => setAll(true)} data-own-press
                  className="candy-btn" data-shape="chip" style={{ '--accent': accent || 'var(--accent)' }}>
            <span className="candy-face" style={{ fontSize: 11 }}>Show All</span>
          </button>
        </div>
      )}
    </PosterRow>
  );
}

const SLIDER_ROWS = 2;
const SLIDER_CAP = 12; // before Show All (user-picked 2026-09-26, 18 then 12)
// The old rail's cover width. The page scrolls past the slider: covers used to
// shrink to fit the window (2026-09-26), dropped as scrolling is fine
// (user-directed 2026-09-28).
const COL = 150;

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

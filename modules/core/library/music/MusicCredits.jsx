// "Max detail" credits for one album, mounted below the tracklist in
// AlbumDetail — the music analog of the Anime tab's AnimeCredits. Four stacked
// sections, each hidden when it has no data (so the page never shows an empty
// rail):
//   • More from this artist — the artist's MusicBrainz discography (owned ones
//     link to the library detail; the rest seed a Browse search).
//   • Performers & personnel — release-level credits from MusicBrainz
//     (music_release_personnel): main/featured artists plus producer, mixing,
//     mastering, and performer relations, grouped one chip per person. Falls
//     back to the primary album artist when a release carries no relationships.
//   • Related — other owned albums that share a genre with this one.
//   • Release details — type / year / tracks / length / genres / MBID.

import { useEffect, useMemo, useRef, useState } from 'react';
import { musicApi } from './api.js';
import BrowseResultCard from './BrowseResultCard.jsx';
import CoverArtCard from './CoverArtCard.jsx';
import PosterRow from '@modules/core/library/PosterRow.jsx';

const go = (hash) => { window.location.hash = hash; };
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const toAlbum = (path) => go('/tools/library/music/downloaded/' + encodePath(path));
const toBrowse = (q) => go('/tools/library/music/browse/q/' + encodeURIComponent(q));

function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '0 0 6px', borderBottom: '1px solid var(--border)', marginBottom: 12,
    }}>{children}</div>
  );
}

export default function MusicCredits({ album, accent }) {
  const artist = album?.artist || '';
  const selfId = album?.providerId || null;

  const [library, setLibrary] = useState([]);    // owned albums (for owned-map + related)
  const [discography, setDiscography] = useState(null); // artist's MB release groups
  const [personnel, setPersonnel] = useState(null);     // null=loading, []=none/failed
  const reqId = useRef(0);
  const persReq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    musicApi.listAlbums().then(l => { if (!cancelled) setLibrary(l || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Resolve the artist on MusicBrainz, then pull their discography.
  useEffect(() => {
    if (!artist) { setDiscography([]); return; }
    const my = ++reqId.current;
    setDiscography(null);
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
  }, [artist]);

  // Release-level credits for THIS album (selfId is the release-group MBID).
  useEffect(() => {
    if (!selfId) { setPersonnel([]); return; }
    const my = ++persReq.current;
    setPersonnel(null);
    musicApi.releasePersonnel(selfId)
      .then(res => { if (my === persReq.current) setPersonnel((res && res.credits) || []); })
      .catch(() => { if (my === persReq.current) setPersonnel([]); });
  }, [selfId]);

  const ownedByProvider = useMemo(() => {
    const m = new Map();
    library.forEach(a => { if (a.providerId) m.set(a.providerId, a.path); });
    return m;
  }, [library]);

  const more = useMemo(
    () => (discography || []).filter(r => r.mbid && r.mbid !== selfId),
    [discography, selfId],
  );

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

  // Related: other owned albums sharing at least one genre, excluding this album
  // and the same artist (which "More from this artist" already covers).
  const related = useMemo(() => {
    const genres = new Set((album?.genres || []).map(g => String(g).toLowerCase()));
    if (genres.size === 0) return [];
    return library.filter(a =>
      a.path !== album.path &&
      (a.artist || '') !== artist &&
      (a.genres || []).some(g => genres.has(String(g).toLowerCase()))
    ).slice(0, 14);
  }, [library, album, artist]);

  if (!album) return null;

  return (
    <div style={{ padding: '22px 24px 8px', display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* More from this artist */}
      {more.length > 0 && (
        <PosterRow title={`More from ${artist}`} accent={accent} colWidth={150}>
          {more.map(r => {
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
      )}

      {/* Performers & personnel — release-level credits (MusicBrainz). */}
      {(performers.length > 0 || artist) && (
        <section>
          <SectionHeader>Performers &amp; personnel</SectionHeader>
          {personnel === null ? (
            <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
              Loading credits…
            </div>
          ) : (
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
                : <CreditChip name={artist} role="Primary artist" accent={accent} onClick={() => toBrowse(artist)} />}
            </div>
          )}
        </section>
      )}

      {/* Related (shared genre, owned) */}
      {related.length > 0 && (
        <PosterRow title="Related" accent={accent} colWidth={150}>
          {related.map(a => (
            <CoverArtCard key={a.path} album={a} accent={accent} selected={false}
                          onSelect={toAlbum} onPlay={() => {}} />
          ))}
        </PosterRow>
      )}

      {/* Release details */}
      <section>
        <SectionHeader>Release details</SectionHeader>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[
            { label: 'Type', value: album.releaseType || 'Album' },
            { label: 'Year', value: album.year },
            { label: 'Tracks', value: album.tracks ? album.tracks.length : null },
            { label: 'Length', value: album.length },
            { label: 'Genres', value: (album.genres && album.genres.length) ? album.genres.join(', ') : null },
            { label: 'MusicBrainz', value: album.providerId },
          ].filter(s => s.value != null && s.value !== '').map(s => (
            <div key={s.label} style={{
              padding: '7px 14px', borderRadius: 8, background: 'var(--surface-2)',
              display: 'flex', flexDirection: 'column', gap: 2, minWidth: 64, maxWidth: 280,
            }}>
              <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{s.label}</span>
              <span style={{ fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(s.value)}>{s.value}</span>
            </div>
          ))}
        </div>
      </section>
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
        {role && <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' }}>{role}</span>}
      </span>
    </button>
  );
}

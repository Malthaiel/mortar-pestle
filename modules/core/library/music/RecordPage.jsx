// The record page: the film page's header wearing a record, shared 1-1 by the
// album and playlist pages (user-directed 2026-09-27: "the exact same page").
// The picture full-bleed behind a cover tile, the title at the film's derived
// scale, one fact line and one fused action run standing on the cover's floor,
// then the tabs and the body under both. Each page only feeds it data. Hooks
// live in recordHooks.js.

import { Fragment, useEffect, useRef, useState } from 'react';
import { IconStarMark, IconSwatch, IconPaperPlane, IconArrowBigDown, IconPlusBig, IconBookmarkAlt, IconHandRock, IconCamcorder, IconEarAlt, IconAnnouncement, IconTag, IconHot, IconBrush } from '@host/components/icons.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { NAV_H, NAV_TEXT, NAV_ICON } from '@host/components/vault-tree/treeKit.jsx';
import { statusLabel, STATUS_ICON } from '@host/util/media-status.js';
import { useContextMenu } from '@host/context-menu/useContextMenu.js';
import { STATUS_DOT_COLOR, resolveDot, toBrowse } from './util.js';
import AddToPlaylistButton from './AddToPlaylistButton.jsx';
import { useAddToPlaylistMenu } from './useAddToPlaylistMenu.jsx';
import { fmtDuration } from './searchShared.jsx';
import { useOpenPart } from './recordHooks.js';
import { FILM_POSTER_W, FILM_DOT, POSTER_COL_GAP, POSTER_DEPTH, PosterTile, SourceRun } from '../AnimeDetailHeader.jsx';
import { artistImage } from './artistImage.js';

// The header's text: type tag, title and fact line all in the title's colour
// (user-directed 2026-09-26). Every size rides --film-head, the film's one head
// knob. The tag wears the title's type a notch under the fact line
// (user-directed 2026-09-28).
const HEAD_COLOR = 'var(--text)';
const FACT_SIZE = 'calc(12px * var(--film-head))';
const TAG_SIZE = 'calc(11px * var(--film-head))';

const LISTEN_STATUSES = ['Plan-to-Listen', 'Currently-Listening', 'Listened', 'Dropped'];

// The photo rides the fact line, so it is sized to that line: an even number of
// pixels, so the circle has no half-pixel edge.
const ARTIST_PFP = 22;

// The rows and the action run above them are the SAME size knob, so a row can
// never drift from the run it sits under (.candy-split derives the seam, the
// corners and every part's height from it). Change this and both change.
// 30, up from the film's 26 (user-directed 2026-09-28: "slightly larger").
// The names and icons grow with it (same day), 10.5 -> 12 and 14 -> 16: the
// run's own vars, which library.css [data-record-run] lays on every face.
// The three numbers are the app's nav size knob (treeKit NAV_H / NAV_TEXT /
// NAV_ICON), shared with every left sidebar (user-directed 2026-09-28).
const ROW_H = `${NAV_H}px`;
const RUN_SIZE = { '--cbtn-size': ROW_H, '--chip-label-size': `${NAV_TEXT}px`, '--record-icon': `${NAV_ICON}px` };

// The header column's line gap (type tag, title, fact line), and the air above and
// below the action runs: the fact line down to them and them down to the body are
// the SAME air (user-directed 2026-09-27; measured 12px from the artist photo's
// bottom to the run's top). The runs' lip paints outside layout, so the gap under
// them adds it back.
const HEAD_GAP = 8;
const RUN_AIR = 12;

const splitName = (t) => <span className="split-label"><span>{t}</span></span>;

// The artist on the fact line: a round press photo and the name, which opens
// the only artist surface the app has (a Browse search). The photo comes from
// TheAudioDB (artistImage.js) and is often absent, so the initials circle is
// the normal case, not an error state. `photo={false}` is the bare name.
export function ArtistLink({ name, accent, photo = true }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (!photo) return;
    let live = true;
    setSrc('');
    artistImage(name).then(url => { if (live) setSrc(url); });
    return () => { live = false; };
  }, [name, photo]);
  const a = accent || 'var(--accent)';
  const initials = String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return (
    <span
      onClick={() => toBrowse(name)}
      title={`Find ${name}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}
      onMouseEnter={e => { e.currentTarget.style.color = a; }}
      onMouseLeave={e => { e.currentTarget.style.color = ''; }}
    >
      {photo && (src
        ? <img src={src} alt="" onError={() => setSrc('')}
            style={{ width: ARTIST_PFP, height: ARTIST_PFP, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0 }}/>
        : <span style={{
            width: ARTIST_PFP, height: ARTIST_PFP, borderRadius: '50%', flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: `color-mix(in oklch, ${a} 16%, var(--surface-2))`,
            fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600,
            color: 'var(--text-muted)', letterSpacing: '0.02em', userSelect: 'none',
          }}>{initials}</span>)}
      {name}
    </span>
  );
}

// The page. `backdrop` is the picture painted full-bleed (the file itself, not
// a thumbnail); `picture` fills the cover tile, or `cover` stands in for it (a
// playlist's collage). `actions` / `tabs` are an <ActionRun> and a <TabRun>.
export function RecordPage({ accent, backdrop, picture, cover, onPictureClick, sources, tag, title, facts, actions, tabs, error, children, after }) {
  // scrollbar-gutter keeps the scrollbar's lane even when nothing scrolls, so
  // the right edge (lane + gutter) always matches the left (the ResizeSeam
  // grab strip + gutter): 34px both sides, measured 2026-09-26.
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable' }}>
      {/* Header: cover + meta, over the picture painted full-bleed behind them.
          .film-detail is the film page's own header shell (library.css) -- it
          owns the deep top padding derived from the still's aspect, the reading
          measure, and the layering that keeps the content clickable. Used here
          verbatim, exactly as AnimeDetailHeader uses it for a film. */}
      {/* No picture, no shell: .film-detail's top padding is reserved FOR the
          picture, so applying it without one leaves 266px of empty page.
          .film-below keeps the same column (gutter + measure) without it. */}
      <div className={backdrop ? 'film-detail' : 'film-below'}
           style={backdrop ? undefined : { paddingTop: 32, paddingBottom: 26, borderBottom: 'var(--candy-frame) solid var(--border)' }}>
        {backdrop && (
          <div className="film-backdrop is-square" aria-hidden>
            {/* A real <img>, like the film still: the box takes its height from
                the file rather than restating an aspect here. is-square adds
                the one crop a square sleeve needs. */}
            <img src={backdrop} alt=""/>
          </div>
        )}
        {/* One wrapper for everything: .film-detail centres its children at
            the reading measure, so the page has to BE a single child. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: RUN_AIR }}>
        {/* Cover and head stand on one floor: the head column sinks until the
            action run's bottom meets the cover's (user-directed 2026-09-28).
            Each side reserves its own lip in padding, so flex-end lines up the
            painted bottoms, not the bare boxes. The film action row's hairline
            (AnimeMainColumn.jsx) splits it from the body, RUN_AIR each side
            (user-directed 2026-09-28). */}
        <div style={{ display: 'flex', gap: 28, alignItems: 'flex-end', paddingBottom: RUN_AIR, borderBottom: 'var(--candy-frame) solid var(--border)' }}>
        {/* LEFT column: the film poster's column 1-1 -- the same candy tile
            (opens the full picture). */}
        <div style={{ width: FILM_POSTER_W, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: POSTER_COL_GAP, paddingBottom: POSTER_DEPTH }}>
          <PosterTile image={picture} title={title} accent={accent || 'var(--accent)'} aspect="1 / 1"
            onClick={onPictureClick}>{cover}</PosterTile>
          {/* ponytail: source run hidden for now (user-directed 2026-09-28,
              temporary). Restoring it puts the column's floor under the run,
              not the cover. */}
          {false && sources?.length > 0 && <SourceRun sources={sources}/>}
        </div>

        <div style={{
          flex: 1, minWidth: 320, display: 'flex', flexDirection: 'column', gap: HEAD_GAP,
          paddingBottom: 'var(--candy-depth-small)',
        }}>
          {/* Type tag. The film has none, but nothing else on the page tells an
              EP from an album. The title's font, weight and tracking, smaller
              (user-directed 2026-09-28). */}
          <div style={{
            fontSize: TAG_SIZE, fontWeight: 700, color: HEAD_COLOR,
            letterSpacing: '-0.015em',
          }}>{tag}</div>

          {/* Title and fact line both multiply by --film-head, the film's one
              head knob -- never type a size here that ignores it. */}
          <h2 style={{
            margin: 0, fontSize: 'calc(28px * var(--film-head))', fontWeight: 700,
            color: HEAD_COLOR, lineHeight: 1.12, letterSpacing: '-0.015em',
          }}>
            {title}
          </h2>

          {/* White like the title (user-directed 2026-09-26); ArtistLink
              inherits it and only tints on hover. */}
          {facts.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              fontSize: FACT_SIZE, color: HEAD_COLOR,
            }}>
              {facts.map((f, i) => <Fragment key={i}>{i > 0 && FILM_DOT}{f}</Fragment>)}
            </div>
          )}

          {/* The film page's action-row shell (AnimeMainColumn.jsx), minus its
              hairline (user-directed 2026-09-26). RUN_AIR above it
              (user-directed 2026-09-27). The action run leads, the tabs follow
              it (user-directed 2026-09-26, again 2026-09-28). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: RUN_AIR - HEAD_GAP }}>
            {actions}
            {tabs}
          </div>
        </div>
        </div>

        {/* The body sits under BOTH the cover and the runs, the full measure
            wide (user-directed 2026-09-28). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: RUN_AIR }}>
          {error && (
            <div style={{ fontSize: 11, color: 'var(--error)' }}>{error}</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {children}
          </div>
        </div>
        </div>
      </div>
      {after}
    </div>
  );
}

// Every action as ONE control, the same fused shell the film page uses for
// status / rating / Download / More. Every part an icon whose name opens on
// hover, like the tabs (user-directed 2026-09-27). act() numbers the parts in
// render order (Download is not always there), so data-open lands on the
// hovered one. A disabled part keeps its paint and simply does nothing --
// fading it punches a hole in the run.
// `download` = { label, rest, busy, onClick } or null; `playlistRefs()` gives
// the refs Add to Playlist writes; `moreItems` fills More Options.
export function ActionRun({ accent, playLabel, onPlay, download, status, rating, busy, onStatus, onRating, onAdd, addBusy, playlistRefs, onQueue, moreItems }) {
  const [openAct, actRun] = useOpenPart(0);
  // Add to Playlist opens the same sub-menu a song's right-click menu carries.
  const playlistMenu = useAddToPlaylistMenu(accent);
  const { openContextMenu } = useContextMenu();
  const menuUnder = (e, items, opts) => {
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu({ x: r.left, y: r.bottom + 4 }, items, { accent, ...opts });
  };
  let actN = 0;
  const act = () => ({ 'data-open': actN++ === openAct ? '' : undefined });
  // The New-playlist modal renders beside the run, never inside it: the run's
  // children are its parts (tabUnder counts them).
  return (<>
    <div className="candy-split" data-record-run {...actRun} style={{
      position: 'relative', ...RUN_SIZE,
    }}>
      {/* Play leads the run (user-directed 2026-09-26; the film's too). Never
          disabled: a track not on disk streams, so an undownloaded record plays
          too. Lit and named at rest, like the picked tab (user-directed
          2026-09-27); useOpenPart(0) shuts the name while another part is
          hovered. */}
      <button
        className="candy-btn is-active"
        data-shape="chip"
        data-own-press
        onClick={onPlay}
        aria-label={playLabel}
        style={{ '--accent': accent || 'var(--accent)' }}
        {...act()}
      ><span className="candy-face"><IconHandRock size={14}/>{splitName(playLabel)}</span></button>

      {/* Icon only, right after Play (user-directed 2026-09-26); the job's
          state (Queued, Downloading 3/11, Failed) is its name, plus a bare 3/11
          count on the face while it downloads (.is-rest), which gives way to
          the words on hover. */}
      {download && (
        <button
          className="candy-btn"
          data-shape="chip"
          data-own-press
          onClick={download.onClick}
          disabled={download.busy}
          aria-label={download.label}
          {...act()}
        ><span className="candy-face"><IconArrowBigDown size={14}/>
          {download.rest && <span className="split-label is-rest"><span>{download.rest}</span></span>}
          {splitName(download.label)}</span></button>
      )}

      {/* An album nobody owns has no card to hold a rating or a status, so
          one part adds it instead, with the status picked from its menu
          (user-directed 2026-09-28). Big plus mark, and Download wears
          the big down arrow (user-picked 2026-09-28). */}
      {onAdd ? (
        <button type="button" className="candy-btn" data-shape="chip" data-own-press
          disabled={addBusy}
          onClick={(e) => menuUnder(e, LISTEN_STATUSES.map(s => ({ label: statusLabel(s), onClick: () => onAdd(s) })), { header: 'Add to library as' })}
          aria-label="Add to Library" {...act()}
        ><span className="candy-face"><IconPlusBig size={14}/>{splitName(addBusy ? 'Adding' : 'Add to Library')}</span></button>
      ) : (<>
        {/* The film's rating control, 1-1: re-picking the current value clears
            it. Every rating wears the star; a picked one shows its number at
            rest and opens to "8 out of 10" (user-directed 2026-09-27). Before
            Status (user-directed 2026-09-28). */}
        <CandySelect icon={IconStarMark}
          value={rating ? String(rating) : ''}
          accent={accent}
          fuse shape="chip" nameOnHover {...act()}
          title="Your rating out of 10"
          placeholder="Rate out of 10"
          options={Array.from({ length: 10 }, (_, n) => ({ value: String(10 - n), label: String(10 - n), short: String(10 - n), long: `${10 - n} out of 10` }))}
          clearable
          disabled={busy}
          onChange={(v) => onRating(Number(v) || 0)}
        />

        {/* A picked status shows its icon alone at rest; the word opens on
            hover (user-directed 2026-09-27). */}
        <CandySelect
          value={status || ''}
          accent={accent}
          fuse shape="chip" nameOnHover {...act()}
          icon={IconTag}
          title="Mark status"
          placeholder="Status"
          options={LISTEN_STATUSES.map(s => ({ value: s, label: statusLabel(s), icon: STATUS_ICON[s], dot: resolveDot(STATUS_DOT_COLOR, s, accent) }))}
          clearable
          disabled={busy}
          onChange={onStatus}
        />
      </>)}

      {/* Queue and Playlist left the More menu for parts of their own
          (user-directed 2026-09-27), wearing the song rows' marks. Always
          offered: off-disk tracks stream from the queue too. Playlist before
          Queue, as on a song row (user-directed 2026-09-27). */}
      <button type="button" className="candy-btn" data-shape="chip" data-own-press
        onClick={(e) => menuUnder(e, playlistMenu.buildItems(playlistRefs()), { header: 'Add to playlist' })}
        aria-label="Add to Playlist" {...act()}
      ><span className="candy-face"><IconBookmarkAlt size={14}/>{splitName('Add to Playlist')}</span></button>
      <button type="button" className="candy-btn" data-shape="chip" data-own-press
        onClick={onQueue} aria-label="Add to Queue" {...act()}
      ><span className="candy-face"><IconPaperPlane size={14}/>{splitName('Add to Queue')}</span></button>

      {/* The page's own rarer actions live in here, as Uninstall does on a
          film. The swatch, not a ⋯ (user-directed 2026-09-26). */}
      {moreItems.length > 0 && (
        <button type="button" className="candy-btn" data-shape="chip" data-own-press
          onClick={(e) => menuUnder(e, moreItems)}
          aria-label="More Options" {...act()}
        ><span className="candy-face"><IconSwatch size={14}/>{splitName('More Options')}</span></button>
      )}
    </div>
    {playlistMenu.modalEl}
  </>);
}

// The film's tab strip (AnimeMainColumn FILM_TABS), for a record: one section
// under the hairline at a time (user-directed 2026-09-26). The open tab follows
// the pointer by tabUnder, not by hit-test; the liquid follows [data-open]
// while the run is hovered (liquidHover.js). Names must not shrink left to
// right (see ALBUM_TABS), so the tab under an arriving pointer, opened, is
// still under it.
export function TabRun({ accent, tabs, icons, active, onPick }) {
  const [openIdx, tabRun] = useOpenPart(tabs.indexOf(active));
  return (
    <div className="candy-split" data-record-run {...tabRun}
      style={{ '--accent': accent || 'var(--accent)', ...RUN_SIZE }}>
      {tabs.map((t, i) => {
        const Icon = icons[t];
        return (
          <button
            key={t}
            type="button"
            data-own-press
            data-shape="chip"
            className={'candy-btn' + (t === active ? ' is-active' : '')}
            data-open={i === openIdx ? '' : undefined}
            onClick={() => onPick(t)}
            aria-label={t}
          >{/* Icons, and ONE name: the picked tab's, or the hovered one's,
              opening like a dock button (.split-label, user-directed
              2026-09-27). No tooltip: the name shows itself. */}
            <span className="candy-face"><Icon size={14}/>{splitName(t)}</span></button>
        );
      })}
    </div>
  );
}

// One row = ONE fused run (.candy-split, Component Map § Default Components)
// as wide as the column: the name half (number, name, length) plays and
// pauses, then Artist, World plays, Plays, Playlist, Queue, Video, [Remove]
// (user-directed 2026-09-26; Remove for playlists 2026-09-27; Artist on every
// row 2026-09-28).
// Every part is ROW_H tall because the run declares --cbtn-size; nothing here
// restates a height.
export function TrackRow({ track, artist, artistSizers, plays, playsDigits, accent, playing, highlighted, onPlay, onEnqueue, onMenu, onRemove, playlistRef, videoUrl, world, worldText, worldSizers }) {
  const rowRef = useRef(null);
  // Scroll a song arrived-at from search into view; long tracklists otherwise
  // highlight a row sitting below the fold.
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlighted]);

  // Same parts the run above is built from -- plain chips, not a shape of their
  // own -- so a row IS the action run, carrying a track instead of an action.
  // `.is-active` is the split's own lit-half state; the loaded track wears it.
  const lit = playing || highlighted;

  // Playlist, Queue, Video and Remove are icons that open their name under the
  // pointer (.split-label, the album tabs' name; user-directed 2026-09-27), none
  // at rest. The row is pinned at both ends, so a name opens LEFTWARD: the song's
  // name half gives up the room and the parts before it slide left. Open =
  // [data-open] from here, never :hover (liquidHover.js copies attributes, not
  // hover). A name wider than its left neighbour's open width would let a
  // pointer sliding left skip that neighbour; keep each name no wider than the
  // open part to its left (so Remove says just "Remove").
  // The two counts do the same, but swap: their short form (.split-label.is-rest)
  // shuts as the long one opens (user-picked 2026-09-27).
  const [open, setOpen] = useState(null);   // the open part's name
  const named = (t) => ({ 'data-open': open === t ? '' : undefined });
  const videoName = videoUrl ? 'Open Video' : 'No Video';
  const worldName = world && `${world.playcount.toLocaleString('en')} Globally`;
  const playsName = `Played ${plays} Time${plays === 1 ? '' : 's'}`;

  return (
    <div
      ref={rowRef}
      className="candy-split"
      data-record-run
      onPointerMove={(e) => setOpen(e.target.closest('.candy-btn')?.querySelector('.split-label:not(.is-rest)')?.textContent ?? null)}
      onPointerLeave={() => setOpen(null)}
      style={{
        display: 'flex', width: '100%',
        ...RUN_SIZE, '--accent': accent || 'var(--accent)',
      }}
    >
      <button
        type="button"
        className={'candy-btn' + (lit ? ' is-active' : '')}
        data-shape="chip"
        data-own-press
        onClick={onPlay}
        onContextMenu={onMenu}
        title={playing ? 'Pause' : 'Play'}
        style={{ flex: 1, minWidth: 0 }}
      >
        <span className="candy-face" style={{ width: '100%', justifyContent: 'flex-start' }}>
          {/* The number turns into ▶ only where the hover's red has reached:
              the lit copy liquidHover.js clones wears [data-dock-hover], and
              library.css swaps the two there (user-directed 2026-09-26). Both
              share one grid cell, so the swap never shifts the name. */}
          <span className="track-n" style={{
            flexShrink: 0, fontVariantNumeric: 'tabular-nums', opacity: 0.7,
            display: 'inline-grid', justifyItems: 'center',
          }}>{playing ? '▶' : <>
            <span className="track-n-num" style={{ gridArea: '1 / 1' }}>{String(track.n).padStart(2, '0')}</span>
            <span className="track-n-play" style={{ gridArea: '1 / 1' }}>▶</span>
          </>}</span>

          <span style={{
            flex: 1, minWidth: 0, textAlign: 'left',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{track.title}</span>

          {/* Duration, at the far end of the half that carries the name. */}
          <span style={{
            flexShrink: 0, fontVariantNumeric: 'tabular-nums', opacity: 0.7,
          }}>{fmtDuration(track.duration)}</span>
        </span>
      </button>

      {/* The artist, by name, right after the song (user-picked 2026-09-28):
          opens the artist the way the fact line's name does. Every row's slot
          holds every artist on the page as hidden sizers, so the parts after it
          line up; a long name is capped at a quarter of the row and cut. No
          artist = the World-plays grey dash. */}
      <button
        type="button"
        className="candy-btn"
        data-shape="chip"
        data-own-press
        aria-disabled={!artist}
        onClick={() => { if (artist) toBrowse(artist); }}
        title={artist ? `Find ${artist}` : undefined}
        style={{ flexShrink: 0, maxWidth: '25%', ...(artist ? null : { opacity: 1, cursor: 'default', '--cbtn-rest-text': 'var(--text-faint)' }) }}
      ><span className="candy-face" style={{ width: '100%' }}><IconBrush size={14}/>
        <span style={{ display: 'inline-grid', minWidth: 0, flex: 1 }}>
          {artistSizers.map(s => <span key={s} aria-hidden style={{ gridArea: '1 / 1', visibility: 'hidden', overflow: 'hidden', whiteSpace: 'nowrap' }}>{s}</span>)}
          <span style={{ gridArea: '1 / 1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{artist || '–'}</span>
        </span>
      </span></button>

      {/* Worldwide plays on Last.fm (Last.fm World Plays plan, user-picked
          2026-09-26), right after the name (user-directed 2026-09-26). On
          every song so the parts line up: a grey dash while loading, with no
          key, or when Last.fm doesn't know the song -- the video part's
          disabled treatment. Opens the song's Last.fm page in the in-app
          browser. */}
      <button
        type="button"
        className="candy-btn"
        data-shape="chip"
        data-own-press
        aria-disabled={!world}
        onClick={() => { if (world?.url) window.location.hash = '/tools/browser/' + encodeURIComponent(world.url); }}
        title={world ? undefined : 'No Last.fm play count'}
        style={world ? undefined : { opacity: 1, cursor: 'default', '--cbtn-rest-text': 'var(--text-faint)' }}
        {...(world && named(worldName))}
      ><span className="candy-face"><IconAnnouncement size={14}/>
        <span className="split-label is-rest"><span style={{ display: 'inline-grid', justifyItems: 'end', fontVariantNumeric: 'tabular-nums' }}>
          {worldSizers.map(s => <span key={s} aria-hidden style={{ gridArea: '1 / 1', visibility: 'hidden' }}>{s}</span>)}
          <span style={{ gridArea: '1 / 1' }}>{worldText}</span>
        </span></span>
        {world && splitName(worldName)}
      </span></button>

      {/* Finished listens, its own part of the run (user-directed 2026-09-26,
          replacing a Plays tab), beside the world count. Shows only once the
          listen log is read, so the run never jumps from a guess. */}
      {plays != null && (
        <button
          type="button"
          className="candy-btn"
          data-shape="chip"
          data-own-press
          {...named(playsName)}
        ><span className="candy-face"><IconEarAlt size={14}/>
          <span className="split-label is-rest"><span style={{ display: 'inline-block', minWidth: `${playsDigits}ch`, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{plays}</span></span>
          {splitName(playsName)}
        </span></button>
      )}

      {/* Its own half now, not a child of the row -- so it needs no
          stopPropagation to keep the row from playing under it. */}
      {/* No tooltips on the named parts: the name shows itself. */}
      <AddToPlaylistButton
        variant="form"
        fuse
        icon={IconBookmarkAlt}
        label={splitName('Add to Playlist')}
        accent={accent}
        title={null}
        refs={playlistRef ? [playlistRef] : []}
        {...named('Add to Playlist')}
      />

      <button
        type="button"
        className="candy-btn"
        data-shape="chip"
        data-own-press
        onClick={onEnqueue}
        {...named('Add to Queue')}
      ><span className="candy-face"><IconPaperPlane size={14}/>{splitName('Add to Queue')}</span></button>

      {/* On every song, so the parts line up down the list;
          greyed and inert when the song has no music video (user-directed
          2026-09-26). styles.css fades a disabled / aria-disabled candy button
          to 0.55, which paints a dark hole in the run (photographed
          2026-09-26), so only the icon greys: opacity is held at 1 here.
          The grey is the REST text colour, so hover still floods the accent
          with a white icon like every part (user-directed 2026-09-27).
          Opens in the in-app browser, as a film trailer does (AnimeTrailer). */}
      <button
        type="button"
        className="candy-btn"
        data-shape="chip"
        data-own-press
        aria-disabled={!videoUrl}
        onClick={() => { if (videoUrl) window.location.hash = '/tools/browser/' + encodeURIComponent(videoUrl); }}
        style={videoUrl ? undefined : { opacity: 1, cursor: 'default', '--cbtn-rest-text': 'var(--text-faint)' }}
        {...named(videoName)}
      ><span className="candy-face"><IconCamcorder size={14}/>{splitName(videoName)}</span></button>

      {/* Takes the song out of this playlist only; the file is kept
          (user-picked 2026-09-27). */}
      {onRemove && (
        <button
          type="button"
          className="candy-btn"
          data-shape="chip"
          data-own-press
          onClick={onRemove}
          aria-label="Remove from Playlist"
          {...named('Remove')}
        ><span className="candy-face"><IconHot size={14}/>{splitName('Remove')}</span></button>
      )}
    </div>
  );
}

export function Centered({ children, tone }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: tone === 'error' ? 'var(--text)' : 'var(--text-faint)',
      fontSize: 13,
    }}>{children}</div>
  );
}

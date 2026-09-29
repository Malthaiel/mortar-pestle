// Video Player settings — a tab in the host Settings drawer, registered by the
// Video module. The qBittorrent group (host / user / password / daemon controls)
// was deleted in SF4 of the Built-in Torrent Engine — the engine is compiled in,
// so there is nothing left to configure. What remains:
//   • Subtitles — global subtitle appearance (size, style, position, font, …),
//     the same VideoPlayerProvider state the in-player ⚙ popover edits, so the two
//     surfaces stay in lockstep. Per-episode Sync stays in the player popover — it
//     needs a loaded episode and is calibrated live while watching.

import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { Seg, OutlinedBtn } from '@host/components/ui/index.js';
import { videoApi } from './api.js';
import { useVideoPlayer } from './VideoPlayerProvider.jsx';
import { useImportJobs } from './ImportProvider.jsx';
import { ModuleSectionBand as SectionBand } from '@host/components/settings/section-primitives.jsx';
import { IconSettings } from '@host/components/icons.jsx';

function basename(p) {
  if (!p) return '';
  return p.split(/[\\/]/).pop();
}

function errText(e, fallback) {
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code) return e.code;
  try { return JSON.stringify(e); } catch { return fallback; }
}

const inputStyle = { color: 'var(--text)', padding: '5px 8px', fontSize: 12, outline: 'none', width: '100%' };

export default function VideoSettingsTab({ accent }) {
  return (
    <div style={{ color: 'var(--text)', fontSize: 12 }}>
      <DownloadsSection accent={accent}/>
      <TorrentSourcesSection accent={accent}/>
      <FilmInfoSection accent={accent}/>
      <ImportSection
        accent={accent}
        kind="mal"
        title="Import from MyAnimeList"
        anchor="set-video-malImport"
        fieldLabel="MAL XML file"
        filter={{ name: 'MAL export', extensions: ['xml', 'gz'] }}
        blurb={<>
          Import your MAL export (<b>.xml</b> or <b>.xml.gz</b>, from MyAnimeList → List → Export).
          Adds each anime as a not-downloaded entry with your status, score, episode progress, rewatches, and dates.
          Large lists take a while — each title is fetched from MyAnimeList in turn.
        </>}
      />
      <ImportSection
        accent={accent}
        kind="watchlist"
        title="Import from a film or show list"
        anchor="set-video-watchlistImport"
        fieldLabel="Letterboxd or IMDb CSV"
        filter={{ name: 'Letterboxd or IMDb export', extensions: ['csv'] }}
        blurb={<>
          Import a <b>Letterboxd</b> diary export or an <b>IMDb</b> list export (both <b>.csv</b>).
          Films land in Movies, shows in TV Shows, each marked Completed with your rating and the day you finished it.
          A Letterboxd list has no ids, so every title is looked up by name and year — a title that does not match
          exactly is reported, never guessed. Long lists take a while.
        </>}
      />
      <SubtitleSection accent={accent}/>
    </div>
  );
}

// ── Torrent sources ───────────────────────────────────────────────────────────
// No index address ships with the app. Every search lane reads its address from
// here, and with all three blank nothing is searched — the picker opens empty
// and points back at this section. See the Bring Your Own Source plan.

const SOURCE_FIELDS = [
  { key: 'torrentioBase', label: 'Films and TV', hint: 'Used for both the Movies and TV Shows rooms.' },
  { key: 'eztvBase',      label: 'TV fallback',  hint: 'Tried only when the films-and-TV source returns nothing for an episode.' },
  { key: 'nyaaBase',      label: 'Anime',        hint: 'Used by the Anime room and the airing-series sweep.' },
];

function TorrentSourcesSection({ accent }) {
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => (
    videoApi.videoGetConfig()
      .then(c => { setCfg(c); setDraft(Object.fromEntries(SOURCE_FIELDS.map(f => [f.key, c[f.key] || '']))); })
      .catch(e => setErr(errText(e, 'Could not read the download source settings.')))
  ), []);

  useEffect(() => { load(); }, [load]);

  const dirty = !!cfg && !!draft && SOURCE_FIELDS.some(f => (draft[f.key] || '') !== (cfg[f.key] || ''));

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await videoApi.videoSetConfig(draft);
      await load();
      setSaved(true);
    } catch (e) { setErr(errText(e, 'Could not save the download sources.')); }
    finally { setBusy(false); }
  };

  const none = !!draft && SOURCE_FIELDS.every(f => !(draft[f.key] || '').trim());

  return (
    <SectionBand gap={12} title="Download sources">
      <div data-search-anchor="set-video-torrentSources" style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
        Mortar &amp; Pestle ships with no download sources. Nothing is searched until you add
        an address of your own, and you are responsible for what you download through it.
        Leave a box empty to switch that lane off.
      </div>
      {SOURCE_FIELDS.map(f => (
        <Field key={f.key} label={f.label}>
          <input
            className="candy-input"
            value={draft ? draft[f.key] : ''}
            onChange={e => { setSaved(false); setDraft(d => ({ ...d, [f.key]: e.target.value })); }}
            placeholder="Not set"
            spellCheck={false}
            style={inputStyle}
          />
          <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{f.hint}</div>
        </Field>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={save} disabled={!dirty || busy} className="candy-btn">
          <span className="candy-face">{busy ? 'Saving' : 'Save'}</span>
        </button>
        {saved && !dirty && <span style={{ fontSize: 11, color: 'var(--text-2)' }}>Saved</span>}
        {none && !dirty && (
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            No source set — downloading is off.
          </span>
        )}
      </div>
      {err && <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{err}</div>}
    </SectionBand>
  );
}

// ── Film info (TMDb) ─────────────────────────────────────────
// The key belongs to the USER, not the app — no key ships, and film pages simply
// stay thinner without one. Naming TMDb here is deliberate and required: the
// design rests on the user knowingly holding their own agreement with them, and
// TMDb's terms require the attribution line below. See the Bring Your Own Source
// plan. The key itself is never read back out of the keychain — the UI only
// learns whether one is stored.

const TMDB_ATTRIBUTION = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';

function FilmInfoSection({ accent }) {
  const [has, setHas] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(() => (
    videoApi.tmdbHasApiKey().then(setHas).catch(() => setHas(false))
  ), []);

  useEffect(() => { load(); }, [load]);

  const save = async (value) => {
    setBusy(true); setErr(null);
    try { await videoApi.tmdbSetApiKey(value); setKey(''); await load(); }
    catch (e) { setErr(errText(e, 'Could not save the key.')); }
    finally { setBusy(false); }
  };

  return (
    <SectionBand gap={12} title="Film info">
      <div data-search-anchor="set-video-tmdbKey" style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
        Film pages show cast, crew, studios and box office when you add your own free
        TMDb key. No key ships with Mortar &amp; Pestle — you make the account, the key stays
        on this computer, and without one the pages simply show less.
        {' '}
        <a href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer"
           style={{ color: 'var(--accent)' }}>Make a free TMDb account</a>, then paste the key below.
      </div>
      <Field label={has ? 'TMDb key (stored)' : 'TMDb key'}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="candy-input"
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder={has ? 'A key is saved' : 'Not set'}
            spellCheck={false}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button onClick={() => save(key)} disabled={!key.trim() || busy} className="candy-btn">
            <span className="candy-face">{busy ? 'Saving' : 'Save'}</span>
          </button>
          {has && (
            <button onClick={() => save('')} disabled={busy} className="candy-btn">
              <span className="candy-face">Remove</span>
            </button>
          )}
        </div>
      </Field>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        {TMDB_ATTRIBUTION}
      </div>
      {err && <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{err}</div>}
    </SectionBand>
  );
}

// ── File imports ──────────────────────────────────────────────────────────────
// Two sections, one component. Both pick an export file → a background job
// (shared engine with the music CSV import) writes each title as a
// not-downloaded entry carrying the user's status, rating and dates. They differ
// only in job kind, wording and file filter, so they share the whole interaction
// rather than living as two copies that drift.
// Survives the drawer closing (state in ImportProvider / the Rust job queue).

function ImportSection({ accent, kind, title, anchor, blurb, fieldLabel, filter }) {
  const { jobs, enqueue, cancel } = useImportJobs();
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const mine = jobs.filter(j => j.kind === kind);
  const active = mine.find(j => ['queued', 'parsing', 'importing'].includes(j.state));
  const lastDone = [...mine].reverse().find(j => ['done', 'error', 'cancelled'].includes(j.state));

  const pick = async () => {
    setErr(null);
    try {
      const p = await open({ multiple: false, filters: [filter] });
      if (typeof p === 'string') setFile(p);
    } catch (e) { setErr(String(e?.message || e)); }
  };
  const start = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try { await enqueue({ kind, filePath: file }); setFile(''); }
    catch (e) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const pct = active && active.state === 'importing' && active.total > 0
    ? Math.round((active.index / active.total) * 100) : null;

  return (
    <SectionBand gap={12} title={title}>
      <div data-search-anchor={anchor} style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
        {blurb}
      </div>
      <Field label={fieldLabel}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="candy-input" value={basename(file)} readOnly placeholder="No file chosen"
                 style={{ ...inputStyle, flex: 1 }}/>
          <button onClick={pick} className="candy-btn"><span className="candy-face">Choose</span></button>
        </div>
      </Field>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={start} disabled={!file || busy || !!active} className="candy-btn">
          <span className="candy-face">{busy ? 'Starting' : 'Import'}</span>
        </button>
        {active && (
          <button onClick={() => cancel(active.id)} className="candy-btn"><span className="candy-face">Cancel</span></button>
        )}
      </div>
      {err && <div style={{ fontSize: 11, color: 'var(--error, var(--text))' }}>{err}</div>}
      {active && (
        <div style={{ fontSize: 11, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>{active.state === 'parsing' ? `Parsing ${active.source}`
            : active.state === 'queued' ? 'Queued'
            : `Importing… ${active.index}/${active.total}${active.currentTitle ? ` · ${active.currentTitle}` : ''}`}</span>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: pct == null ? '40%' : `${pct}%`, background: accent || 'var(--accent)', borderRadius: 2, transition: 'width 200ms ease' }}/>
          </div>
        </div>
      )}
      {!active && lastDone && (
        <div style={{ fontSize: 11, color: lastDone.state === 'error' ? 'var(--error, var(--text))' : (lastDone.unmatched && lastDone.unmatched.length ? '#d8a657' : 'var(--text-muted)') }}>
          {lastDone.state === 'error' ? (lastDone.error || 'Import failed') : (lastDone.summary || 'Done')}
        </div>
      )}
      {!active && lastDone && lastDone.state !== 'error' && (
        <>
          <NameList label="Bring these in from MyAnimeList" names={lastDone.anime}/>
          <NameList label="Not found — nothing was guessed" names={lastDone.unmatched}/>
        </>
      )}
    </SectionBand>
  );
}

// The summary counts them; this names them, folded away until asked for.
function NameList({ label, names }) {
  if (!names || !names.length) return null;
  return (
    <details style={{ fontSize: 11, color: 'var(--text-2)' }}>
      <summary style={{ cursor: 'pointer' }}>{label} ({names.length})</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4 }}>
        {names.map((n, i) => <span key={i}>{n}</span>)}
      </div>
    </details>
  );
}

// ── Downloads ───────────────────────────────────────────────────────────────
// Where anime video FILES land. Cards, covers and episode metadata always stay
// in the Library vault — only the big video folders relocate, so the whole
// library can sit on a secondary drive. Unset = `<library>/Anime/Videos`
// (byte-for-byte the historical behaviour). Chosen folder IS the video root:
// files land at `<chosen>/<Series>`, no nested Anime/Videos.

function DownloadsSection({ accent }) {
  const [cfg, setCfg] = useState(null); // { videoRoot, effectiveRoot, isDefault }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [moving, setMoving] = useState(null); // { index, total, currentTitle }
  const [moveMsg, setMoveMsg] = useState(null);

  const load = useCallback(() => (
    videoApi.videoGetConfig().then(setCfg).catch(e => setErr(errText(e, 'Could not read the video folder setting.')))
  ), []);

  useEffect(() => { load(); }, [load]);

  const apply = async (root) => {
    setBusy(true); setErr(null);
    try {
      await videoApi.videoSetConfig({ videoRoot: root });
      await load();
    } catch (e) { setErr(errText(e, 'Could not save the video folder.')); }
    finally { setBusy(false); }
  };

  const pick = async () => {
    setErr(null);
    try {
      const p = await open({ directory: true });
      if (typeof p === 'string') await apply(p);
    } catch (e) { setErr(errText(e, 'Folder picker failed.')); }
  };

  // Progress ticks from the Rust move loop; the drawer can close mid-move and
  // the move keeps going — only the display is lost.
  useEffect(() => {
    let un;
    listen('anime-move-progress', e => setMoving(e.payload)).then(f => { un = f; });
    return () => { if (un) un(); };
  }, []);

  const moveAll = async () => {
    setMoving({ index: 0, total: 0 }); setMoveMsg(null); setErr(null);
    try {
      const r = await videoApi.animeMoveVideos();
      const bits = [`Moved ${r.moved}`];
      if (r.skipped) bits.push(`skipped ${r.skipped}`);
      if (r.failed) bits.push(`failed ${r.failed}`);
      setMoveMsg({ text: `${bits.join(', ')}.`, warnings: r.warnings || [] });
    } catch (e) { setErr(errText(e, 'Move failed.')); }
    finally { setMoving(null); }
  };

  return (
    <SectionBand gap={12} title="Downloads">
      <div data-search-anchor="set-video-videoFolder" style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
        Where downloaded anime <b>video files</b> are saved. Each series gets its own folder inside.
        Covers and episode details always stay with your library — only the videos move, so you can keep them on a bigger drive.
        Already-downloaded series stay where they are.
      </div>
      <Field label="Video folder">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="candy-input" value={cfg ? cfg.effectiveRoot : ''} readOnly
                 title={cfg ? cfg.effectiveRoot : ''} placeholder="Loading"
                 style={{ ...inputStyle, flex: 1 }}/>
          <button onClick={pick} disabled={busy} className="candy-btn"><span className="candy-face">Choose</span></button>
        </div>
      </Field>
      {cfg && cfg.isDefault && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Default library folder.</div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        {cfg && !cfg.isDefault && (
          <button onClick={() => apply('')} disabled={busy || !!moving} className="candy-btn">
            <span className="candy-face">Reset to Default</span>
          </button>
        )}
        <button onClick={moveAll} disabled={busy || !!moving} className="candy-btn">
          <span className="candy-face">{moving ? 'Moving' : 'Move All Here'}</span>
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        <b>Move All Here</b> brings every finished series into the folder above — it copies each one,
        checks it arrived whole, and only then removes the old copy. Series still downloading are left alone.
      </div>
      {moving && (
        <div style={{ fontSize: 11, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>{moving.total ? `${moving.index}/${moving.total}${moving.currentTitle ? ` · ${moving.currentTitle}` : ''}` : 'Starting'}</span>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: moving.total ? `${Math.round((moving.index / moving.total) * 100)}%` : '40%', background: accent || 'var(--accent)', borderRadius: 2, transition: 'width 200ms ease' }}/>
          </div>
        </div>
      )}
      {!moving && moveMsg && (
        <div style={{ fontSize: 11, color: moveMsg.warnings.length ? '#d8a657' : 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>{moveMsg.text}</span>
          {moveMsg.warnings.map((w, i) => <span key={i} style={{ color: 'var(--text-faint)' }}>{w}</span>)}
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: 'var(--error, var(--text))' }}>{err}</div>}
    </SectionBand>
  );
}

// ── Subtitles ───────────────────────────────────────────────────────────────
// Global appearance only; shares VideoPlayerProvider state with the in-player ⚙
// popover. Per-episode Sync is intentionally absent — it lives in the player.

function SubtitleSection({ accent }) {
  const v = useVideoPlayer();
  const s = v?.subSettings;
  const set = v?.updateSubSetting;
  if (!s || !set) return null;

  return (
    <SectionBand gap={12} title="Subtitles">
      <RangeRow label="Size" anchor="set-video-subSize" value={s.size} min={12} max={64} step={1}
                onChange={x => set('size', x)} format={x => `${x}px`} accent={accent}/>
      <CtrlRow label="Style" anchor="set-video-subStyle">
        <Seg
          value={s.bgStyle}
          options={[
            { value: 'box',     label: 'Box' },
            { value: 'shadow',  label: 'Shadow' },
            { value: 'outline', label: 'Outline' },
            { value: 'none',    label: 'None' },
          ]}
          onChange={x => set('bgStyle', x)}
          accent={accent}
        />
      </CtrlRow>
      {s.bgStyle === 'box' && (
        <RangeRow label="BG opacity" value={s.bgOpacity} min={0} max={1} step={0.05}
                  onChange={x => set('bgOpacity', x)} format={x => `${Math.round(x * 100)}%`} accent={accent}/>
      )}
      {s.bgStyle === 'shadow' && (
        <RangeRow label="Shadow size" value={s.shadowSize} min={0} max={20} step={1}
                  onChange={x => set('shadowSize', x)} format={x => `${x}px`} accent={accent}/>
      )}
      {s.bgStyle === 'outline' && (
        <RangeRow label="Outline size" value={s.outlineSize} min={0} max={10} step={0.5}
                  onChange={x => set('outlineSize', x)} format={x => `${x}px`} accent={accent}/>
      )}
      <RangeRow label="Position" anchor="set-video-subPosition" value={s.position} min={0} max={1} step={0.01}
                onChange={x => set('position', x)} format={x => `${Math.round(x * 100)}%`} accent={accent}/>
      <CtrlRow label="Font" anchor="set-video-subFont">
        <Seg
          value={s.fontFamily}
          options={[
            { value: 'sans', label: 'Sans' },
            { value: 'mono', label: 'Mono' },
          ]}
          onChange={x => set('fontFamily', x)}
          accent={accent}
        />
      </CtrlRow>
      <CtrlRow label="Weight">
        <Seg
          value={s.fontWeight}
          options={[
            { value: 400, label: 'Normal' },
            { value: 500, label: 'Medium' },
            { value: 700, label: 'Bold' },
          ]}
          onChange={x => set('fontWeight', x)}
          accent={accent}
        />
      </CtrlRow>
      <RangeRow label="Letter spacing" value={s.letterSpacing} min={-2} max={8} step={0.5}
                onChange={x => set('letterSpacing', x)} format={x => `${x}`} accent={accent}/>
      <RangeRow label="Line height" value={s.lineHeight} min={0.9} max={2.0} step={0.05}
                onChange={x => set('lineHeight', x)} format={x => x.toFixed(2)} accent={accent}/>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Per-episode Sync lives in the player <IconSettings size="1em"/>.</span>
        <OutlinedBtn small onClick={v.resetSubSettings}>Reset</OutlinedBtn>
      </div>
    </SectionBand>
  );
}

// ── primitives ──────────────────────────────────────────────────────────────

// Bare section header matching the module-tab convention (see planner's SettingsTab).

function Field({ label, anchor, children }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, color: 'var(--text-2)' }}>{label}</label>
      {children}
    </div>
  );
}

function CtrlRow({ label, anchor, children }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 30 }}>
      <span style={{ fontSize: 12, color: 'var(--text-2)', flexShrink: 0 }}>{label}</span>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function RangeRow({ label, value, min, max, step, onChange, format, accent, anchor }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 30 }}>
      <span style={{ width: 92, flexShrink: 0, fontSize: 12, color: 'var(--text-2)' }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: accent || 'var(--accent)' }}
      />
      <span style={{
        width: 44, textAlign: 'right', fontSize: 10.5,
        fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
        fontVariantNumeric: 'tabular-nums',
      }}>{format ? format(value) : value}</span>
    </div>
  );
}

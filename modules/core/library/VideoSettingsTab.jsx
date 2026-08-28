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
      <MalImportSection accent={accent}/>
      <SubtitleSection accent={accent}/>
    </div>
  );
}

// ── Import from MyAnimeList ───────────────────────────────────────────────────
// Pick a MAL list export (.xml / .xml.gz) → a background job (shared engine with
// the music CSV import) writes each anime as a not-downloaded entry carrying the
// user's status, score, watched count, rewatches, and start/finish dates.
// Survives the drawer closing (state in ImportProvider / the Rust job queue).

function MalImportSection({ accent }) {
  const { jobs, enqueue, cancel } = useImportJobs();
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const malJobs = jobs.filter(j => j.kind === 'mal');
  const active = malJobs.find(j => ['queued', 'parsing', 'importing'].includes(j.state));
  const lastDone = [...malJobs].reverse().find(j => ['done', 'error', 'cancelled'].includes(j.state));

  const pick = async () => {
    setErr(null);
    try {
      const p = await open({ multiple: false, filters: [{ name: 'MAL export', extensions: ['xml', 'gz'] }] });
      if (typeof p === 'string') setFile(p);
    } catch (e) { setErr(String(e?.message || e)); }
  };
  const start = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try { await enqueue({ kind: 'mal', filePath: file }); setFile(''); }
    catch (e) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const pct = active && active.state === 'importing' && active.total > 0
    ? Math.round((active.index / active.total) * 100) : null;

  return (
    <SectionBand gap={12} title="Import from MyAnimeList">
      <div data-search-anchor="set-video-malImport" style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
        Import your MAL export (<b>.xml</b> or <b>.xml.gz</b>, from MyAnimeList → List → Export).
        Adds each anime as a not-downloaded entry with your status, score, episode progress, rewatches, and dates.
        Large lists take a while — each title is fetched from MyAnimeList in turn.
      </div>
      <Field label="MAL XML file">
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
    </SectionBand>
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
      await videoApi.videoSetConfig(root);
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
            <span className="candy-face">Reset to default</span>
          </button>
        )}
        <button onClick={moveAll} disabled={busy || !!moving} className="candy-btn">
          <span className="candy-face">{moving ? 'Moving' : 'Move all here'}</span>
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        <b>Move all here</b> brings every finished series into the folder above — it copies each one,
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
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Per-episode Sync lives in the player ⚙.</span>
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

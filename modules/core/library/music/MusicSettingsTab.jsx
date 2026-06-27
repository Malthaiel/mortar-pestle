// Music settings — the Music sub-tab of the Library settings page (Settings →
// Modules › Library › Music). Rendered by LibrarySettingsTab.
//
// Import (SF5): pick a CSV/TXT playlist/album file (from chosic, Exportify, our
// own future export, or hand-written) → a background job parses it, writes a
// playlist page of not-downloaded tracks, and (optionally) resolves each distinct
// album against MusicBrainz to drop a not-downloaded album card. Survives the
// drawer closing (state lives in ImportProvider / the Rust job queue).
//
// Export: Spotify Premium-gates every Web API app, so Iskariel does NOT export
// playlists in-app. The Export section points users to Exportify — a free,
// open-source web tool that logs into the user's OWN (free) Spotify account and
// produces a CSV the Import section above accepts verbatim. (Rationale + the
// rejected token-proxy alternative live in Plans/Spotify Token Proxy.md.)
// Primitives (SectionBand/Field) copied from VideoSettingsTab per convention.

import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Seg } from '@host/components/ui/index.js';
import { useImportJobs } from '../ImportProvider.jsx';

const inputStyle = { color: 'var(--text)', padding: '5px 8px', fontSize: 12, outline: 'none', width: '100%' };

function basename(p) {
  if (!p) return '';
  return p.split(/[\\/]/).pop();
}

export default function MusicSettingsTab({ accent }) {
  return (
    <div style={{ color: 'var(--text)', fontSize: 12 }}>
      <ImportSection accent={accent}/>
      <ExportSection/>
    </div>
  );
}

// ── Import (CSV/TXT → library) ──────────────────────────────────────────────

function ImportSection({ accent }) {
  const { jobs, enqueue, cancel } = useImportJobs();
  const [file, setFile] = useState('');     // absolute path
  const [addAlbums, setAddAlbums] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const musicJobs = jobs.filter(j => j.kind === 'music');
  const active = musicJobs.find(j => ['queued', 'parsing', 'importing'].includes(j.state));
  const lastDone = [...musicJobs].reverse().find(j => ['done', 'error', 'cancelled'].includes(j.state));

  const pick = async () => {
    setErr(null);
    try {
      const p = await open({ multiple: false, filters: [{ name: 'Playlist / album', extensions: ['csv', 'txt'] }] });
      if (typeof p === 'string') setFile(p);
    } catch (e) { setErr(String(e?.message || e)); }
  };

  const startImport = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      await enqueue({ kind: 'music', filePath: file, addAlbums, initialStatus: 'Plan-to-Listen' });
      setFile('');
    } catch (e) { setErr(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <SectionBand title="Import playlist / album file">
      <div data-search-anchor="set-music-importFile" style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
        Import a <b>.csv</b> or <b>.txt</b> playlist/album export (e.g. from chosic, Exportify, or any
        “Artist - Title” list). Creates a playlist of not-downloaded tracks; you can download them later.
      </div>

      <Field label="File">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="candy-input" value={basename(file)} readOnly placeholder="No file chosen"
                 style={{ ...inputStyle, flex: 1 }}/>
          <button onClick={pick} className="candy-btn"><span className="candy-face">Choose…</span></button>
        </div>
      </Field>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
          Also add album cards
          <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-faint)', marginTop: 1 }}>
            One not-downloaded card per distinct album (resolved via MusicBrainz)
          </span>
        </span>
        <Seg
          value={addAlbums ? 'on' : 'off'}
          options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
          onChange={v => setAddAlbums(v === 'on')}
          accent={accent}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={startImport} disabled={!file || busy || !!active} className="candy-btn">
          <span className="candy-face">{busy ? 'Starting…' : 'Import'}</span>
        </button>
        {active && (
          <button onClick={() => cancel(active.id)} className="candy-btn"><span className="candy-face">Cancel</span></button>
        )}
      </div>

      {err && <div style={{ fontSize: 11, color: 'var(--error, var(--text))' }}>{err}</div>}

      {active && <ProgressLine job={active}/>}
      {!active && lastDone && <SummaryLine job={lastDone}/>}
    </SectionBand>
  );
}

function ProgressLine({ job }) {
  let label;
  if (job.state === 'queued') label = 'Queued…';
  else if (job.state === 'parsing') label = `Parsing ${job.source}…`;
  else label = `Resolving albums… ${job.index}/${job.total}${job.currentTitle ? ` · ${job.currentTitle}` : ''}`;
  const pct = job.state === 'importing' && job.total > 0 ? Math.round((job.index / job.total) * 100) : null;
  return (
    <div style={{ fontSize: 11, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span>{label}</span>
      <div style={{ height: 4, borderRadius: 2, background: 'var(--surface-2)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: pct == null ? '40%' : `${pct}%`,
          background: 'var(--accent)', borderRadius: 2, transition: 'width 200ms ease',
        }}/>
      </div>
    </div>
  );
}

function SummaryLine({ job }) {
  const color = job.state === 'error' ? 'var(--error, var(--text))'
    : (job.unmatched && job.unmatched.length) ? '#d8a657' : 'var(--text-muted)';
  return (
    <div style={{ fontSize: 11, color, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span>{job.state === 'error' ? (job.error || 'Import failed') : (job.summary || 'Done')}</span>
      {job.unmatched && job.unmatched.length > 0 && (
        <details style={{ color: 'var(--text-faint)' }}>
          <summary style={{ cursor: 'pointer' }}>{job.unmatched.length} unmatched album{job.unmatched.length === 1 ? '' : 's'}</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {job.unmatched.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

// ── Export from Spotify (via Exportify) ─────────────────────────────────────
// Spotify Premium-gates the Web API, so export is delegated to Exportify (free,
// external). The user logs into their own free account there and downloads a CSV
// that the Import section above reads as-is.

const mono = {
  fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text)',
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', padding: '2px 6px', userSelect: 'all',
};

function ExportSection() {
  return (
    <SectionBand title="Export from Spotify">
      <div
        data-search-anchor="set-music-spotifyExport"
        style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.6 }}
      >
        Spotify requires a paid developer account to read playlists through its API, so
        Iskariel doesn’t export them directly. Use <b>Exportify</b> — a free, open-source
        web tool — to turn any of your playlists into a CSV, then import it above.
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.7 }}>
        <li>Open <span style={mono}>exportify.net</span> in your browser.</li>
        <li>Log in with your Spotify account (a free account works).</li>
        <li>Click <b>Export</b> next to a playlist to download its CSV.</li>
        <li>Back here, use <b>Import playlist / album file</b> above to add it.</li>
      </ol>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
        Source: <span style={{ ...mono, fontSize: 10.5 }}>github.com/watsonbox/exportify</span>
      </div>
    </SectionBand>
  );
}

// ── primitives ──────────────────────────────────────────────────────────────

function SectionBand({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600,
        marginBottom: 8,
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, anchor, children }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, color: 'var(--text-2)' }}>{label}</label>
      {children}
    </div>
  );
}

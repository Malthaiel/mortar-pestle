// Capture settings page (Settings → Modules › Capture, 5-SF4). A read-only engine
// readout (codec / bitrate / keyframe interval / container), live global-hotkey
// rows (the portal-bound triggers + a rebind path), and the Phase-2 replay-length
// slider stub. Every value comes from the live capture snapshot (get_capture_state
// + the `capture-state` event); a down engine is a calm "unavailable" state, never
// an error throw. Styling primitives mirror BrowserSettingsTab.

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { openInFiles } from '@host/components/vault-tree/revealInFiles.js';

// Snapshot-only live state (the clip list is CapturePage's concern, not Settings).
// Mirrors useCaptureState's discriminate-by-`state` idiom; null ⇒ engine down.
function useCaptureSnapshot() {
  const [snapshot, setSnapshot] = useState(null);
  const [engine, setEngine] = useState(null);
  useEffect(() => {
    let alive = true;
    invoke('get_capture_state')
      .then((s) => { if (alive) setSnapshot(s || null); })
      .catch(() => { if (alive) setSnapshot(null); });
    const subs = [
      listen('capture-state', (e) => {
        const p = e.payload;
        if (p && typeof p.state === 'string' && ('recording' in p || 'config' in p)) setSnapshot(p);
      }),
      listen('capture-engine-status', (e) => { if (e.payload) setEngine(e.payload); }),
    ];
    return () => { alive = false; subs.forEach((pr) => pr.then((un) => un()).catch(() => {})); };
  }, []);
  return { snapshot, engine };
}

function SectionBand({ title, anchor, children }) {
  return (
    <div {...(anchor ? { 'data-search-anchor': anchor } : {})} style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 600, marginBottom: 8,
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </div>
  );
}

function SettingRow({ label, hint, children, stacked }) {
  if (stacked) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>{label}</div>
          {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>{hint}</div>}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </div>
  );
}

const statNum = { fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--text)', fontWeight: 600 };
const hintText = { fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5, padding: '4px 0' };
const actionBtn = {
  fontSize: 11, padding: '3px 10px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)', background: 'var(--surface-2)',
  color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit',
};
const triggerKbd = {
  fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text)',
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', padding: '2px 8px', whiteSpace: 'nowrap',
};
const reservedBadge = {
  fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
  textTransform: 'uppercase', color: 'var(--text-faint)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
  padding: '1px 5px', marginLeft: 8,
};

const fmtMbps = (bps) => (bps ? `${Math.round(bps / 1e6)} Mbps` : '—');

// Read-only encoder block (NVENC H.264, fixed this release).
function EncoderReadout({ snapshot }) {
  const cfg = snapshot?.config;
  return (
    <SectionBand title="Encoder" anchor="set-capture-encoder">
      <SettingRow label="Codec"><span style={statNum}>{snapshot?.codec ? snapshot.codec.toUpperCase() : '—'}</span></SettingRow>
      <SettingRow label="Bitrate"><span style={statNum}>{snapshot ? fmtMbps(snapshot.bitrate_bps) : '—'}</span></SettingRow>
      <SettingRow label="Keyframe interval"><span style={statNum}>{snapshot?.gop_len ? `${snapshot.gop_len} frames` : '—'}</span></SettingRow>
      <SettingRow label="Container"><span style={statNum}>{cfg?.container ? cfg.container.toUpperCase() : '—'}</span></SettingRow>
      <div style={hintText}>Encoder settings are fixed in this release (hardware NVENC, monitor-native). They become configurable in a later version.</div>
    </SectionBand>
  );
}

// Read-only audio block (system/desktop track, fixed format this release). Values
// come from snapshot.config.audio (camelCase on the wire); the track codec is fixed
// at Opus 192k in the save-time mux.
function AudioReadout({ snapshot }) {
  const audio = snapshot?.config?.audio;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '—');
  const khz = audio?.sampleRate ? `${Math.round(audio.sampleRate / 1000)} kHz` : '—';
  const chans = audio?.channels === 1 ? 'mono' : audio?.channels === 2 ? 'stereo'
    : audio?.channels ? `${audio.channels} ch` : '—';
  return (
    <SectionBand title="Audio" anchor="set-capture-audio">
      <SettingRow label="Source"><span style={statNum}>{audio?.track ? cap(audio.track) : '—'}</span></SettingRow>
      <SettingRow label="Format"><span style={statNum}>{audio ? `${khz} ${chans}` : '—'}</span></SettingRow>
      <SettingRow label="Track codec"><span style={statNum}>AAC 192k</span></SettingRow>
      <div style={hintText}>Records all desktop audio (system output), captured alongside video and muxed into the clip. Microphone and per-app audio arrive in a later version.</div>
    </SectionBand>
  );
}

// Live hotkey rows + the rebind path. `can_configure` (portal v2+) lights an
// in-place Rebind; otherwise the KDE Shortcuts deep-link is the reconfigure path.
function HotkeyRows({ snapshot }) {
  const hk = snapshot?.hotkeys;
  const shortcuts = hk?.shortcuts || [];
  const openKde = () => invoke('capture_open_kde_settings').catch(() => {});
  const rebind = () => invoke('capture_rebind_hotkeys').catch(() => {});
  return (
    <SectionBand title="Global shortcuts" anchor="set-capture-hotkeys">
      {!hk?.bound ? (
        <div style={hintText}>{hk?.last_error ? `Shortcuts unavailable: ${hk.last_error}` : 'Shortcuts not bound yet.'}</div>
      ) : shortcuts.length === 0 ? (
        <div style={hintText}>No shortcuts bound.</div>
      ) : shortcuts.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text)', display: 'flex', alignItems: 'center' }}>
            {s.description || s.id}
            {s.reserved && <span style={reservedBadge}>reserved</span>}
          </span>
          <span style={triggerKbd}>{s.trigger_description || '—'}</span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, paddingTop: 8, flexWrap: 'wrap' }}>
        {hk?.can_configure && <button type="button" onClick={rebind} style={actionBtn}>Rebind…</button>}
        <button type="button" onClick={openKde} style={actionBtn}>Open KDE Shortcuts</button>
      </div>
      <div style={hintText}>
        The Record shortcut toggles recording. Reserved shortcuts are bound now for a future release.{' '}
        {hk?.can_configure ? 'Use Rebind to reconfigure in place.' : 'Reconfigure these in KDE System Settings → Shortcuts.'}
      </div>
    </SectionBand>
  );
}

// Instant-replay ring length (Phase 2). Persists `replayLengthMin` via
// set_capture_config; while armed the engine holds ~bitrate × duration of H.264 in
// RAM. Hard-capped at 10 min (decision #4): this UI cap plus an engine-side clamp
// keep arming inside the free-RAM budget (10-min Ultra ≈ 4.9 GB; 30-min ≈ 14.6 GB,
// over budget). The slider used to allow 1–30 with no allocation.
const REPLAY_MAX_MIN = 10;

function ReplaySlider({ snapshot }) {
  const cfg = snapshot?.config;
  const clamp = (v) => Math.min(Math.max(v, 1), REPLAY_MAX_MIN);
  const [val, setVal] = useState(clamp(cfg?.replayLengthMin ?? 5));
  useEffect(() => { if (cfg?.replayLengthMin != null) setVal(clamp(cfg.replayLengthMin)); }, [cfg?.replayLengthMin]);
  const commit = (v) => {
    if (!cfg) return;
    invoke('set_capture_config', { config: { ...cfg, replayLengthMin: v } }).catch(() => {});
  };
  // Live RAM estimate: the ring holds ~bitrate × duration of H.264 while armed
  // (the engine caps at 1.25× for GOP-eviction headroom). null engine → no figure.
  const bps = snapshot?.bitrate_bps;
  const estGb = bps ? (bps / 8 * val * 60 * 1.25) / 1e9 : null;
  return (
    <SectionBand title="Replay buffer" anchor="set-capture-replay">
      <SettingRow stacked
        label={`Replay length — ${val} min`}
        hint={estGb != null
          ? `While armed, the last ${val} min of gameplay stays in RAM (≈ ${estGb.toFixed(1)} GB at the current bitrate). Save with Ctrl+Alt+S.`
          : 'Instant-replay ring length. While armed, this many minutes of gameplay stays in RAM, saved on demand.'}>
        <input
          type="range" min={1} max={REPLAY_MAX_MIN} step={1} value={val}
          onChange={(e) => setVal(Number(e.target.value))}
          onMouseUp={(e) => commit(Number(e.target.value))}
          onKeyUp={(e) => commit(Number(e.target.value))}
          disabled={!cfg}
          style={{ width: '100%', accentColor: 'var(--accent)', opacity: cfg ? 1 : 0.5 }}
        />
      </SettingRow>
    </SectionBand>
  );
}

// Recordings destination (WI-2). Reads the resolved folder from get_captures_dir;
// Change… opens the native folder picker → set_captures_dir (persists + repoints
// the engine); Reset returns to the platform default. Blocked while recording/armed
// (the repoint restarts the engine). Existing clips stay where they are.
function RecordingsSection({ snapshot }) {
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const locked = !!snapshot?.recording || !!snapshot?.armed;

  const refresh = useCallback(() => {
    invoke('get_captures_dir').then((d) => setDir(d || '')).catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const change = async () => {
    setErr(null);
    let picked;
    try {
      picked = await open({ directory: true, multiple: false, title: 'Choose a recordings folder' });
    } catch { setErr('Could not open the folder picker.'); return; }
    const path = typeof picked === 'string' ? picked : (picked && picked.path) || null;
    if (!path) return; // cancelled
    setBusy(true);
    try { await invoke('set_captures_dir', { path }); refresh(); }
    catch (e) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  const reset = async () => {
    setErr(null); setBusy(true);
    try { await invoke('reset_captures_dir'); refresh(); }
    catch (e) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  const openFolder = () => { if (dir) openInFiles(dir, { isFolder: true }); };

  return (
    <SectionBand title="Recordings" anchor="set-capture-recordings">
      <SettingRow stacked
        label="Save recordings to"
        hint="New clips save here; existing clips stay where they are. Changing this briefly restarts the capture engine, so it is blocked while recording.">
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text)',
          wordBreak: 'break-all', background: 'var(--surface-2)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px',
        }}>{dir || '—'}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={change} disabled={busy || locked} style={actionBtn}>Change folder…</button>
          <button type="button" onClick={openFolder} disabled={!dir} style={actionBtn}>Open folder</button>
          <button type="button" onClick={reset} disabled={busy || locked} style={actionBtn}>Reset to default</button>
        </div>
        {locked && <div style={hintText}>Stop recording to change the folder.</div>}
        {err && <div style={{ ...hintText, color: 'var(--error)' }}>{err}</div>}
      </SettingRow>
    </SectionBand>
  );
}

export default function CaptureSettingsTab() {
  const { snapshot, engine } = useCaptureSnapshot();
  const down = !!engine && (engine.state === 'down' || engine.state === 'failed');
  return (
    <div>
      {down && (
        <div style={{ ...hintText, color: 'var(--error)' }}>
          Capture engine is down — values appear once it is running.
        </div>
      )}
      <RecordingsSection snapshot={snapshot} />
      <EncoderReadout snapshot={snapshot} />
      <AudioReadout snapshot={snapshot} />
      <HotkeyRows snapshot={snapshot} />
      <ReplaySlider snapshot={snapshot} />
    </div>
  );
}

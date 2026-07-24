// Broadcast settings (SP2 Engine section → SP4 four-section strip). Engine /
// Output / Recording / Replay on the shared host Topbar, controlled by the
// drawer address via {initialSection, onNavigateSection} (PAGE_SECTIONS.broadcast);
// falls back to local state standalone (OverlaySettingsTab idiom). Settings tabs
// receive NO `api`, so this builds its own createApi('broadcast') for verb() /
// api.settings / PropertiesForm. The engine profile (basic.ini) is the source of
// truth — every control reads get_output_settings and writes a section-nested
// set_output_settings patch; simple/advanced is a UI-only pref in the module bag.
// Encoder + video controls lock while recording OR armed (shared EncoderSet).

import React, { useEffect, useMemo, useState } from 'react';
import { createApi } from '@host/module-sdk/index.js';
import { Topbar, Slider, StatChip, TextInput, Seg } from '@host/components/ui';
import { OutlinedBtn } from '@host/components/ui/Button.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import EnableToggle from '@host/components/ui/EnableToggle.jsx';
import { SectionBand, Row } from '@host/components/settings/section-primitives.jsx';
import { verb } from './broadcastStore.js';
import { toast } from './mutations.js';
import useBroadcastState from './useBroadcastState.js';
import PropertiesForm from './PropertiesForm.jsx';
import RemuxWindow from './RemuxWindow.jsx';

const SECTIONS = [
  { id: 'engine', label: 'Engine' },
  { id: 'output', label: 'Output' },
  { id: 'recording', label: 'Recording' },
  { id: 'replay', label: 'Replay' },
  { id: 'stream', label: 'Stream' },
];
const QUALITY_OPTS = [
  { value: 'Stream', label: 'Streaming (SP5)' },
  { value: 'Small', label: 'Standard (CRF 23)' },
  { value: 'HQ', label: 'High (CRF 16)' },
  { value: 'Lossless', label: 'Lossless' },
];
const FORMAT_OPTS = [
  { value: 'hybrid_mp4', label: 'Hybrid MP4 (crash-safe)' },
  { value: 'mkv', label: 'MKV' },
  { value: 'hybrid_mov', label: 'Hybrid MOV' },
  { value: 'mp4', label: 'MP4' },
  { value: 'mov', label: 'MOV' },
];
const FPS_OPTS = [{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }];
const RES_OPTS = [{ value: '1', label: 'Full (100%)' }, { value: '0.75', label: '75%' }, { value: '0.5', label: '50%' }];
const RBTIME_OPTS = [{ value: '15', label: '15 s' }, { value: '30', label: '30 s' }, { value: '60', label: '60 s' }, { value: '120', label: '2 min' }, { value: '300', label: '5 min' }];
const RBSIZE_OPTS = [{ value: '256', label: '256 MB' }, { value: '512', label: '512 MB' }, { value: '1024', label: '1 GB' }, { value: '2048', label: '2 GB' }];
const SPLIT_OPTS = [{ value: 'off', label: 'Off' }, { value: 'Time', label: 'By time' }, { value: 'Size', label: 'By size' }, { value: 'Manual', label: 'Manual only' }];

const pad = (n) => String(n).padStart(2, '0');
// Client-side FilenameFormatting preview (cosmetic — the Rust namer is the real
// expander). %game stays literal (record-time game isn't known here).
function expandName(t) {
  const d = new Date();
  return String(t || '')
    .replace(/%CCYY/g, String(d.getFullYear())).replace(/%YY/g, pad(d.getFullYear() % 100))
    .replace(/%MM/g, pad(d.getMonth() + 1)).replace(/%DD/g, pad(d.getDate()))
    .replace(/%hh/g, pad(d.getHours())).replace(/%mm/g, pad(d.getMinutes())).replace(/%ss/g, pad(d.getSeconds()));
}

const muted = { fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5, paddingTop: 2 };

// Commit-on-blur text field (PropertiesForm's CommitText idiom; Enter blurs).
function NameField({ value, accent, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <TextInput
      value={draft} accent={accent}
      onChange={(v) => setDraft(typeof v === 'string' ? v : v?.target?.value)}
      onBlur={() => { if (draft !== value) onCommit(draft); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
    />
  );
}

// Stream key / custom-URL field: masked by default with a reveal toggle, and
// commit-on-blur like NameField. Not a shared primitive — TextInput already
// takes `type`, so the whole "password field" is one piece of local state.
function SecretField({ value, accent, placeholder, onCommit }) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <TextInput
        value={draft} accent={accent} placeholder={placeholder}
        type={shown ? 'text' : 'password'}
        style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)' }}
        onChange={(v) => setDraft(typeof v === 'string' ? v : v?.target?.value)}
        onBlur={() => { if (draft !== value) onCommit(draft); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
      />
      <OutlinedBtn small onClick={() => setShown((s) => !s)} title={shown ? 'Hide' : 'Show'}>
        {shown ? 'Hide' : 'Show'}
      </OutlinedBtn>
    </div>
  );
}

export default function BroadcastSettingsTab({ accent, initialSection, onNavigateSection }) {
  const api = useMemo(() => createApi('broadcast'), []);
  const { snapshot, engine } = useBroadcastState(api);
  const locked = !!snapshot?.recording?.active || !!snapshot?.replay?.armed;

  const [localSection, setLocalSection] = useState('engine');
  const section = initialSection || localSection;
  const select = (id) => { if (onNavigateSection) onNavigateSection(id); else setLocalSection(id); };

  const [advanced, setAdvanced] = useState(() => !!api.settings.get('advancedMode', false));
  const [profile, setProfile] = useState(null); // { section: { key: stringValue } }
  const [encoders, setEncoders] = useState([]);
  const [paths, setPaths] = useState(null);
  const [remuxOpen, setRemuxOpen] = useState(false);
  const [svcCatalog, setSvcCatalog] = useState([]); // services[] from the OBS rtmp-services catalog
  const [svc, setSvc] = useState(null);             // { type, settings } | null (never configured)

  const refetchProfile = () => verb(api, 'get_output_settings').then((r) => setProfile(r?.profile || {})).catch(() => {});
  const refetchService = () => verb(api, 'get_stream_service').then((r) => setSvc(r || null)).catch(() => {});
  useEffect(() => {
    refetchProfile();
    refetchService();
    verb(api, 'list_encoders').then((r) => setEncoders(Array.isArray(r?.encoders) ? r.encoders : [])).catch(() => {});
    verb(api, 'get_stream_services').then((r) => setSvcCatalog(Array.isArray(r?.services) ? r.services : [])).catch(() => {});
    api.invoke('broadcast_paths').then(setPaths).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const g = (sec, key, dflt) => profile?.[sec]?.[key] ?? dflt;
  const applyPatch = (patch) => {
    setProfile((p) => {                                   // optimistic
      const next = { ...(p || {}) };
      for (const [sec, keys] of Object.entries(patch)) next[sec] = { ...(next[sec] || {}), ...keys };
      return next;
    });
    verb(api, 'set_output_settings', { patch }).catch((e) => {
      toast('Broadcast', (e && e.message) || 'Setting rejected');
      refetchProfile();                                   // resync disk truth on reject (e.g. busy)
    });
  };
  const set = (sec, key, value) => applyPatch({ [sec]: { [key]: String(value) } });

  // Derived control values.
  const advEncoder = g('AdvOut', 'RecEncoder', 'obs_x264');
  const baseCX = parseInt(g('Video', 'BaseCX', '1920'), 10) || 1920;
  const baseCY = parseInt(g('Video', 'BaseCY', '1080'), 10) || 1080;
  const outCX = parseInt(g('Video', 'OutputCX', String(baseCX)), 10) || baseCX;
  const resFrac = outCX / baseCX;
  const resValue = RES_OPTS.reduce((best, o) => Math.abs(parseFloat(o.value) - resFrac) < Math.abs(parseFloat(best) - resFrac) ? o.value : best, '1');
  const setRes = (f) => { const fr = parseFloat(f); applyPatch({ Video: { OutputCX: String(Math.round(baseCX * fr)), OutputCY: String(Math.round(baseCY * fr)) } }); };

  const tracks = parseInt(g('SimpleOutput', 'RecTracks', '3'), 10) || 1;
  const micOn = (tracks & 2) !== 0;
  const setMic = (on) => set('SimpleOutput', 'RecTracks', String(on ? (tracks | 2 | 1) : ((tracks & ~2) | 1)));

  const container = g('SimpleOutput', 'RecFormat2', 'hybrid_mp4');
  const remuxable = container === 'mkv';
  const autoRemux = g('Video', 'AutoRemux', 'false') === 'true';

  // --- stream service (SP5 SF1) ---
  // The engine keeps service.json opaque, so the whole shape lives here: mode
  // is just the `type` field, and everything else is `settings` keys.
  const svcType = svc?.type === 'rtmp_custom' ? 'rtmp_custom' : 'rtmp_common';
  const svcSet = svc?.settings || {};
  const svcName = svcSet.service || '';
  const svcEntry = svcCatalog.find((s) => s.name === svcName);
  const serviceOpts = useMemo(
    // Common services first (the catalog's own `common` flag), catalog order
    // within each group. 84 rows is fine unvirtualized — CandySelect's
    // type-ahead is the search.
    () => [...svcCatalog].sort((a, b) => (b.common === true) - (a.common === true)).map((s) => ({ value: s.name, label: s.name })),
    [svcCatalog],
  );
  const serverOpts = (svcEntry?.servers || []).map((s) => ({ value: s.url, label: s.name }));

  const saveService = (type, settings) => {
    const next = { type, settings };
    setSvc(next);                                       // optimistic, as applyPatch
    verb(api, 'set_stream_service', { service: next }).catch((e) => {
      toast('Broadcast', (e && e.message) || 'Stream settings rejected');
      refetchService();
    });
  };
  const setSvcField = (k, v) => saveService(svcType, { ...svcSet, [k]: v });
  // Switching to a DIFFERENT service clears the server — a Twitch ingest URL is
  // meaningless to YouTube. Two things this must not do, both observed live:
  //  1. Re-picking the service already selected wiped a deliberate server
  //     choice (Ashburn → whatever came first in the catalog).
  //  2. Defaulting to `servers[0]` is not "nearest", it is ALPHABETICAL —
  //     Twitch's list starts at "Asia: Hong Kong", and the catalog carries no
  //     auto/recommended entry (OBS synthesises its own). A silently wrong
  //     continent still streams, just badly, so an empty server that forces a
  //     pick is the honest default. SF7's bandwidth wizard picks the best one.
  const pickService = (name) => {
    if (name === svcName) return;                         // no-op, never a reset
    saveService('rtmp_common', { ...svcSet, service: name, server: '' });
  };
  const setSvcMode = (t) => {
    if (t === svcType) return;
    if (t === 'rtmp_custom') { saveService('rtmp_custom', { server: '', key: svcSet.key || '' }); return; }
    saveService('rtmp_common', { service: svcName || '', server: svcSet.server || '', key: svcSet.key || '' });
  };

  const splitOn = g('AdvOut', 'RecSplitFile', 'false') === 'true';
  const rawSplitType = g('AdvOut', 'RecSplitFileType', 'Time');
  const splitMode = splitOn ? rawSplitType : (rawSplitType === 'Manual' ? 'Manual' : 'off');
  const setSplit = (mode) => {
    if (mode === 'off') applyPatch({ AdvOut: { RecSplitFile: 'false' } });
    else if (mode === 'Manual') applyPatch({ AdvOut: { RecSplitFile: 'true', RecSplitFileType: 'Manual' } });
    else applyPatch({ AdvOut: { RecSplitFile: 'true', RecSplitFileType: mode } });
  };

  return (
    <div>
      <Topbar
        tiles={SECTIONS.map((s) => ({ id: s.id, label: s.label }))}
        activeId={section} accent={accent} onSelect={select}
        style={{ padding: '0 0 12px', background: 'transparent', marginBottom: 16 }}
      />

      {section === 'engine' && (
        <SectionBand title="Engine" anchor="set-bcast-engine">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <StatChip label="state" value={engine?.state || 'unknown'} />
            <StatChip label="restarts" value={engine ? String(engine.restartCount) : '—'} />
            <StatChip label="last exit" value={engine?.lastExitCode == null ? '—' : String(engine.lastExitCode)} />
          </div>
          {engine?.message && <div style={{ fontSize: 12, color: 'var(--text-muted)', paddingTop: 8 }}>{engine.message}</div>}
          <div style={{ display: 'flex', gap: 10, paddingTop: 10 }}>
            <OutlinedBtn small onClick={() => api.invoke('broadcast_restart_engine').catch(() => {})} title="Kill and respawn the Broadcast engine (also revives a crash-looped one)">Restart engine</OutlinedBtn>
            <OutlinedBtn small onClick={() => api.invoke('broadcast_open_log').catch(() => {})} title="Open mortar-pestle-broadcast.log">Open log file</OutlinedBtn>
          </div>
          {paths?.collectionPath && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all', paddingTop: 8 }}>Scene collection: {paths.collectionPath}</div>
          )}
        </SectionBand>
      )}

      {section === 'output' && (
        <SectionBand title="Output" anchor="set-bcast-output">
          <Row label="Mode">
            <Seg
              options={[{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }]}
              value={advanced ? 'advanced' : 'simple'} accent={accent}
              onChange={(v) => { const a = v === 'advanced'; setAdvanced(a); api.settings.set('advancedMode', a); }}
            />
          </Row>
          <Row label="Quality"><CandySelect value={g('SimpleOutput', 'RecQuality', 'HQ')} options={QUALITY_OPTS} onChange={(v) => set('SimpleOutput', 'RecQuality', v)} disabled={locked} title="Recording quality" /></Row>
          {!advanced && (
            <Row label="Encoder"><CandySelect value={g('SimpleOutput', 'RecEncoder', 'x264')} options={[{ value: 'x264', label: 'x264 (H.264)' }]} onChange={(v) => set('SimpleOutput', 'RecEncoder', v)} disabled={locked} title="Video encoder" /></Row>
          )}
          <Row label="Container"><CandySelect value={container} options={FORMAT_OPTS} onChange={(v) => set('SimpleOutput', 'RecFormat2', v)} disabled={locked} title="File container" /></Row>
          <Row label="Resolution"><CandySelect value={resValue} options={RES_OPTS} onChange={setRes} disabled={locked} title="Output scale of the canvas" /></Row>
          <Row label="Frame rate"><CandySelect value={g('Video', 'FPSCommon', '60')} options={FPS_OPTS} onChange={(v) => set('Video', 'FPSCommon', v)} disabled={locked} title="Frames per second" /></Row>
          {advanced && (
            <>
              <Row label="Encoder"><CandySelect value={advEncoder} options={encoders.map((e) => ({ value: e.id, label: e.display_name || e.id }))} onChange={(v) => set('AdvOut', 'RecEncoder', v)} disabled={locked} title="Detected hardware/software encoders" /></Row>
              <div style={{ paddingTop: 6 }}>
                <PropertiesForm
                  api={api} accent={accent}
                  node={{ item_id: advEncoder, name: advEncoder }} sceneName={null}
                  fetch={() => verb(api, 'get_encoder_properties', { encoder_id: advEncoder })}
                  commit={(k, v) => verb(api, 'set_encoder_settings', { settings: { [k]: v } })}
                />
              </div>
            </>
          )}
          {locked && <div style={muted}>Stop recording and disarm the replay buffer to change encoder or video settings.</div>}
        </SectionBand>
      )}

      {section === 'recording' && (
        <SectionBand title="Recording" anchor="set-bcast-recording">
          <Row label="Microphone track"><EnableToggle enabled={micOn} accent={accent} onChange={setMic} title="Record the mic to a second audio track" /></Row>
          <Row label="Split file"><CandySelect value={splitMode} options={SPLIT_OPTS} onChange={setSplit} title="Auto-split by time/size, or split manually from the composer" /></Row>
          {splitMode === 'Time' && (
            <Row label="Every"><Slider value={parseInt(g('AdvOut', 'RecSplitFileTime', '15'), 10) || 15} min={1} max={60} step={1} unit=" min" accent={accent} onChange={(v) => set('AdvOut', 'RecSplitFileTime', v)} /></Row>
          )}
          {splitMode === 'Size' && (
            <Row label="Every"><Slider value={parseInt(g('AdvOut', 'RecSplitFileSize', '2048'), 10) || 2048} min={256} max={8192} step={256} unit=" MB" accent={accent} onChange={(v) => set('AdvOut', 'RecSplitFileSize', v)} /></Row>
          )}
          <Row label="Auto-remux to MP4">
            <div style={remuxable ? undefined : { opacity: 0.4, pointerEvents: 'none' }}>
              <EnableToggle enabled={remuxable && autoRemux} accent={accent} onChange={(v) => set('Video', 'AutoRemux', !!v)} title="Copy the finished MKV into an MP4" />
            </div>
          </Row>
          {!remuxable && <div style={muted}>Auto-remux applies to MKV recordings only.</div>}
          <Row label="File name"><NameField value={g('Output', 'FilenameFormatting', '%CCYY-%MM-%DD %hh-%mm-%ss')} accent={accent} onCommit={(v) => set('Output', 'FilenameFormatting', v)} /></Row>
          <div style={muted}>Preview: {expandName(g('Output', 'FilenameFormatting', '%CCYY-%MM-%DD %hh-%mm-%ss'))} — <code>%game</code> fills in at record time.</div>
          <div style={{ paddingTop: 10 }}>
            <OutlinedBtn small onClick={() => setRemuxOpen(true)} title="Remux an existing recording to MP4 without re-encoding">Remux tool…</OutlinedBtn>
          </div>
        </SectionBand>
      )}

      {section === 'replay' && (
        <SectionBand title="Replay" anchor="set-bcast-replay">
          <Row label="Length"><CandySelect value={g('SimpleOutput', 'RecRBTime', '30')} options={RBTIME_OPTS} onChange={(v) => set('SimpleOutput', 'RecRBTime', v)} title="Seconds kept in the rolling buffer" /></Row>
          <Row label="Max size"><CandySelect value={g('SimpleOutput', 'RecRBSize', '512')} options={RBSIZE_OPTS} onChange={(v) => set('SimpleOutput', 'RecRBSize', v)} title="Memory cap for the buffer" /></Row>
          <Row label="File prefix"><NameField value={g('SimpleOutput', 'RecRBPrefix', 'Replay')} accent={accent} onCommit={(v) => set('SimpleOutput', 'RecRBPrefix', v)} /></Row>
          <div style={muted}>Arm and save the replay buffer from the composer bar (or Meta+Shift+S).</div>
        </SectionBand>
      )}

      {section === 'stream' && (
        <SectionBand title="Stream" anchor="set-bcast-stream">
          <Row label="Destination">
            <Seg
              options={[{ value: 'rtmp_common', label: 'Service' }, { value: 'rtmp_custom', label: 'Custom RTMP' }]}
              value={svcType} accent={accent} onChange={setSvcMode}
            />
          </Row>
          {svcType === 'rtmp_common' ? (
            <>
              <Row label="Service"><CandySelect value={svcName} options={serviceOpts} onChange={pickService} placeholder="Pick a service" title="Streaming service — start typing to jump" /></Row>
              <Row label="Server"><CandySelect value={svcSet.server || ''} options={serverOpts} onChange={(v) => setSvcField('server', v)} placeholder="Pick a server" title="Ingest server — closest is usually best" /></Row>
            </>
          ) : (
            <Row label="Server URL"><NameField value={svcSet.server || ''} accent={accent} onCommit={(v) => setSvcField('server', v)} /></Row>
          )}
          <Row label="Stream key"><SecretField value={svcSet.key || ''} accent={accent} placeholder="Paste your stream key" onCommit={(v) => setSvcField('key', v)} /></Row>
          <div style={muted}>The key is stored as plain text in the engine profile folder, exactly as OBS stores it.</div>
        </SectionBand>
      )}

      {remuxOpen && <RemuxWindow api={api} accent={accent} onClose={() => setRemuxOpen(false)} />}
    </div>
  );
}

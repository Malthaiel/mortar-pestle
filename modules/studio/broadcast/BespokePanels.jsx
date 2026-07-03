// SP3 bespoke panels (Overview-locked set) — thin candy layers over the
// generic PropertiesForm: each renders its signature rows (device/monitor/
// window pickers, hook badge, URL bar) and the remaining generic props below
// via the form's `omit`. Settings commits mirror the form's undo shape.
//
// Thumbnails (locked): monitors = live cards via engine temp sources
// (picker_open/close + screenshot{picker} @1s while open); windows = row list
// + ONE live thumb of the REAL source (selection IS the committed setting;
// undo covers regret). Hook badge derives from source width (frames flowing
// = hooked) — neutral palette, no stoplight.

import React, { useEffect, useRef, useState } from 'react';
import { SectionHeader } from '@host/components/ui';
import PropertiesForm, { NumField } from './PropertiesForm.jsx';
import { verb } from './broadcastStore.js';
import { pushUndo } from './broadcastUndo.js';
import { glyphFor } from './sourceGlyphs.jsx';

const SMALL = { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)' };

// picker_open/close + interval invokes must not interleave across StrictMode
// remounts (Tauri invoke order ≠ call order) — one module-level chain.
let pickerChain = Promise.resolve();
const chained = (op) => { pickerChain = pickerChain.then(op, op); return pickerChain; };

function commitSetting(api, sceneName, node, settingsBefore, patch, label) {
  return verb(api, 'set_source_settings', { scene: sceneName, name: node.name, settings: patch })
    .then(() => pushUndo({
      label: label || `${node.name}: settings`,
      undo: [{ op: 'set_source_settings', args: { scene: sceneName, name: node.name, settings: settingsBefore, replace: true } }],
      redo: [{ op: 'set_source_settings', args: { scene: sceneName, name: node.name, settings: patch } }],
    }))
    .catch((e) => console.warn('[broadcast] set_source_settings', e));
}

function useSettings2(api, sceneName, node) {
  const [settings, setSettings] = useState({});
  const [props, setProps] = useState([]);
  useEffect(() => {
    let alive = true;
    verb(api, 'get_properties', { scene: sceneName, item: node.item_id })
      .then((r) => { if (alive) { setSettings(r?.settings || {}); setProps(r?.props || []); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [api, sceneName, node.item_id, node.width]); // width edge re-reads (device came alive)
  return { settings, props, setSettings };
}

function Thumb({ png, w = '100%' }) {
  return png
    ? <img alt="" src={`data:image/png;base64,${png}`} style={{ width: w, aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 6, border: '2px solid var(--border-2)', background: '#000', display: 'block' }} />
    : <div style={{ width: w, aspectRatio: '16 / 9', borderRadius: 6, border: '2px solid var(--border-2)', background: '#000' }} />;
}

/// Candy row list for a LIST property's items (devices, windows).
function PickerRows({ prop, current, accent, onPick, glyph }) {
  if (!prop) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'calc(4px + var(--candy-depth-nav, 3px))' }}>
      {(prop.items || []).filter((i) => !i.disabled).map((i) => {
        const active = i.value === current;
        return (
          <button
            key={String(i.value)}
            type="button" data-own-press
            className={`candy-btn${active ? ' is-active' : ''}`}
            data-shape="row"
            style={{ '--cbtn-depth': 'var(--candy-depth-nav)', ...(accent ? { '--accent': accent } : {}) }}
            onClick={() => onPick(i.value)}
            title={i.name}
          >
            <span className="candy-face" style={{ justifyContent: 'flex-start', gap: 8, minWidth: 0, padding: '4px 10px', fontSize: 12 }}>
              {glyph}
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MonitorPanel({ api, sceneName, node, accent }) {
  const { settings } = useSettings2(api, sceneName, node);
  const [monitors, setMonitors] = useState([]);
  const [thumbs, setThumbs] = useState({});

  useEffect(() => {
    let alive = true;
    chained(() => verb(api, 'picker_open', { kind: 'monitor' })
      .then((r) => { if (alive) setMonitors(r?.monitors || []); })
      .catch((e) => console.warn('[broadcast] picker_open', e)));
    return () => {
      alive = false;
      chained(() => verb(api, 'picker_close').catch(() => {}));
    };
  }, [api]);

  useEffect(() => {
    if (!monitors.length) return;
    let alive = true;
    const grab = () => {
      for (const m of monitors) {
        verb(api, 'screenshot', { picker: m.id, width: 320 })
          .then((r) => { if (alive && r?.png) setThumbs((t) => ({ ...t, [m.id]: r.png })); })
          .catch(() => {});
      }
    };
    grab();
    const t = setInterval(grab, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [api, monitors]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader title="Display" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {monitors.map((m) => {
          const active = settings.monitor_id === m.id;
          return (
            <button
              key={m.id}
              type="button" data-own-press
              className={`candy-btn${active ? ' is-active' : ''}`}
              data-shape="tile"
              style={{ ...(accent ? { '--accent': accent } : {}), padding: 0 }}
              onClick={() => commitSetting(api, sceneName, node, { ...settings }, { monitor_id: m.id }, `${node.name}: display`)}
              title={m.label}
            >
              <span className="candy-face" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, minWidth: 0 }}>
                <Thumb png={thumbs[m.id]} />
                <span style={{ fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{m.label}</span>
              </span>
            </button>
          );
        })}
      </div>
      <PropertiesForm api={api} sceneName={sceneName} node={node} accent={accent} omit={['monitor_id']} />
    </div>
  );
}

function WindowPanel({ api, sceneName, node, accent }) {
  const { settings, props } = useSettings2(api, sceneName, node);
  const winProp = props.find((p) => p.name === 'window');
  const [thumb, setThumb] = useState(null);

  // Live thumb of the REAL source (locked #14): the committed window is what
  // renders; a captureless source shows the black placeholder.
  useEffect(() => {
    let alive = true;
    const grab = () => {
      verb(api, 'screenshot', { scene: sceneName, item: node.item_id, width: 320 })
        .then((r) => { if (alive && r?.png) setThumb(r.png); })
        .catch(() => {});
    };
    grab();
    const t = setInterval(grab, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [api, sceneName, node.item_id]);

  // OBS window values are "title:class:exe" — show "exe — title".
  const rows = winProp && {
    ...winProp,
    items: (winProp.items || []).map((i) => {
      const parts = String(i.value).split(':');
      const exe = parts[parts.length - 1] || '';
      return { ...i, name: exe ? `${exe} — ${parts[0] || i.name}` : i.name };
    }),
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader title="Window" />
      <Thumb png={thumb} />
      <PickerRows
        prop={rows}
        current={settings.window}
        accent={accent}
        glyph={glyphFor('window_capture', 12)}
        onPick={(v) => commitSetting(api, sceneName, node, { ...settings }, { window: v }, `${node.name}: window`)}
      />
      <PropertiesForm api={api} sceneName={sceneName} node={node} accent={accent} omit={['window']} />
    </div>
  );
}

function GamePanel({ api, sceneName, node, accent }) {
  // Hook state derives from live source dimensions (frames flowing = hooked)
  // — no engine signal plumbing needed; neutral palette per DESIGN.
  const hooked = node.width > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionHeader title="Game hook" />
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          color: hooked ? 'var(--text)' : 'var(--text-muted)',
        }}>
          {hooked ? `● hooked ${node.width}×${node.height}` : '○ waiting for game'}
        </span>
      </div>
      <PropertiesForm api={api} sceneName={sceneName} node={node} accent={accent} />
    </div>
  );
}

function DevicePanel({ api, sceneName, node, accent, propName, title, glyphId }) {
  const { settings, props } = useSettings2(api, sceneName, node);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader title={title} />
      <PickerRows
        prop={props.find((p) => p.name === propName)}
        current={settings[propName]}
        accent={accent}
        glyph={glyphFor(glyphId, 12)}
        onPick={(v) => commitSetting(api, sceneName, node, { ...settings }, { [propName]: v }, `${node.name}: device`)}
      />
      <PropertiesForm api={api} sceneName={sceneName} node={node} accent={accent} omit={[propName]} />
    </div>
  );
}

function BrowserPanel({ api, sceneName, node, accent }) {
  const { settings } = useSettings2(api, sceneName, node);
  const [url, setUrl] = useState(settings.url || '');
  useEffect(() => { setUrl(settings.url || ''); }, [settings.url]);
  const commitUrl = () => {
    if (url !== (settings.url || '')) commitSetting(api, sceneName, node, { ...settings }, { url }, `${node.name}: url`);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader title="Page" />
      <input
        className="candy-input"
        value={url}
        placeholder="https://…"
        onChange={(e) => setUrl(e.target.value)}
        onBlur={commitUrl}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
        spellCheck={false}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
      />
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <span style={SMALL}>W</span>
        <NumField value={settings.width || 800} min={1} max={8192} onCommit={(v) => commitSetting(api, sceneName, node, { ...settings }, { width: v })} />
        <span style={SMALL}>H</span>
        <NumField value={settings.height || 600} min={1} max={8192} onCommit={(v) => commitSetting(api, sceneName, node, { ...settings }, { height: v })} />
      </div>
      <PropertiesForm api={api} sceneName={sceneName} node={node} accent={accent} omit={['url', 'width', 'height']} />
    </div>
  );
}

function TextPanel({ api, sceneName, node, accent }) {
  const { settings } = useSettings2(api, sceneName, node);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader title="Text" />
      <textarea
        className="candy-input"
        defaultValue={settings.text || ''}
        key={node.item_id + (settings.text || '')}
        rows={3}
        placeholder="text…"
        onBlur={(e) => { if (e.target.value !== (settings.text || '')) commitSetting(api, sceneName, node, { ...settings }, { text: e.target.value }, `${node.name}: text`); }}
        onKeyDown={(e) => e.stopPropagation()}
        style={{ resize: 'vertical', fontSize: 13 }}
      />
      <PropertiesForm api={api} sceneName={sceneName} node={node} accent={accent} omit={['text']} />
    </div>
  );
}

const PANELS = {
  monitor_capture: MonitorPanel,
  window_capture: WindowPanel,
  game_capture: GamePanel,
  dshow_input: (p) => <DevicePanel {...p} propName="video_device_id" title="Camera" glyphId="dshow_input" />,
  wasapi_input_capture: (p) => <DevicePanel {...p} propName="device_id" title="Microphone" glyphId="wasapi_input_capture" />,
  wasapi_output_capture: (p) => <DevicePanel {...p} propName="device_id" title="Output device" glyphId="wasapi_output_capture" />,
  browser_source: BrowserPanel,
  text_ft2_source: TextPanel,
  text_ft2_source_v2: TextPanel,
};

export function hasBespokePanel(typeId) {
  return !!PANELS[typeId];
}

export default function BespokePanel({ api, sceneName, node, accent }) {
  const P = PANELS[node.id];
  if (!P) return <PropertiesForm api={api} sceneName={sceneName} node={node} accent={accent} />;
  return <P api={api} sceneName={sceneName} node={node} accent={accent} />;
}

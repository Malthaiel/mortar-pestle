// SP3 PropertiesForm (approved net-new; Overview reuse-first roster) — the
// schema-driven candy form over libobs property introspection. Renders the
// engine's PropSpec list (get_properties) with house controls; an arbitrary
// third-party source's properties render usable with ZERO bespoke code
// (SF4 accept).
//
// Commit model (locked): commit-on-change → set_source_settings (merge) +
// per-commit undo entry (undo = full-settings replace-restore, killing
// merge-ghost keys) + ALWAYS refetch get_properties — a fresh
// obs_source_properties has every modified-callback applied, which replaces
// OBS's refresh-flag machinery wholesale (<5ms local round-trip).
//
// v1 ceilings (ledgered for SP15): editable_list = line-per-entry textarea;
// font = face/size/bold/italic sub-fields (no system enumeration); color =
// hex input (no wheel); frame_rate unsupported (no v1-module input uses it).

import React, { useEffect, useRef, useState } from 'react';
import { OutlinedBtn, Slider, TextInput, SectionHeader, HexInput } from '@host/components/ui';
import EnableToggle from '@host/components/ui/EnableToggle.jsx';
import CandySelect from '@host/components/ui/CandySelect.jsx';
import { open, save } from '@tauri-apps/plugin-dialog';
import { verb } from './broadcastStore.js';
import { pushUndo } from './broadcastUndo.js';

const LABEL = { fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' };
const ROW = { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 };

export function NumField({ value, min, max, float = false, width = 72, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = float ? Number(draft) : Math.round(Number(draft));
    const lo = min ?? -Infinity;
    const hi = max ?? Infinity;
    if (!Number.isFinite(n) || n < lo || n > hi || n === value) {
      setDraft(String(value));
      return;
    }
    onCommit(float ? Math.round(n * 1000) / 1000 : n);
  };
  return (
    <input
      className="candy-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
      spellCheck={false}
      style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, width, padding: '3px 8px' }}
    />
  );
}

// OBS colors are ABGR ints (0xAABBGGRR). Hex UI shows #RRGGBB.
function abgrToHex(n) {
  const v = Number(n) >>> 0;
  const r = v & 0xff;
  const g = (v >> 8) & 0xff;
  const b = (v >> 16) & 0xff;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
function hexToAbgr(hex, alpha = 0xff) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return ((alpha << 24) >>> 0) + (b << 16) + (g << 8) + r;
}

function PropRow({ prop, value, accent, onCommit, onButton }) {
  if (!prop.visible) return null;
  const disabled = !prop.enabled;
  const dim = disabled ? { opacity: 0.45, pointerEvents: 'none' } : {};

  switch (prop.type) {
    case 'bool':
      return (
        <div style={{ ...ROW, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', ...dim }}>
          <span style={LABEL} title={prop.long_desc}>{prop.label}</span>
          <EnableToggle enabled={!!value} accent={accent} onChange={(v) => onCommit(v)} title={prop.label} />
        </div>
      );
    case 'int':
    case 'float': {
      const isFloat = prop.type === 'float';
      if (prop.number_type === 'slider') {
        return (
          <div style={{ ...ROW, ...dim }}>
            <span style={LABEL} title={prop.long_desc}>{prop.label}</span>
            <Slider
              value={Number(value) || 0}
              min={prop.min} max={prop.max} step={prop.step || (isFloat ? 0.01 : 1)}
              unit={prop.suffix || ''}
              accent={accent}
              onChange={(v) => onCommit(isFloat ? v : Math.round(v))}
            />
          </div>
        );
      }
      return (
        <div style={{ ...ROW, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', ...dim }}>
          <span style={LABEL} title={prop.long_desc}>{prop.label}{prop.suffix ? ` (${prop.suffix})` : ''}</span>
          <NumField value={Number(value) || 0} min={prop.min} max={prop.max} float={isFloat} onCommit={onCommit} />
        </div>
      );
    }
    case 'text': {
      if (prop.text_type === 'info') {
        return (
          <div style={{ fontSize: 11.5, color: prop.info_type === 'error' ? 'var(--text)' : 'var(--text-muted)', fontWeight: prop.info_type === 'error' ? 600 : 400 }}>
            {prop.label}
          </div>
        );
      }
      if (prop.text_type === 'multiline') {
        return (
          <div style={{ ...ROW, ...dim }}>
            <span style={LABEL}>{prop.label}</span>
            <textarea
              className="candy-input"
              defaultValue={value || ''}
              rows={4}
              onBlur={(e) => { if (e.target.value !== (value || '')) onCommit(e.target.value); }}
              onKeyDown={(e) => e.stopPropagation()}
              spellCheck={false}
              style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
            />
          </div>
        );
      }
      return (
        <div style={{ ...ROW, ...dim }}>
          <span style={LABEL}>{prop.label}</span>
          <CommitText value={value || ''} password={prop.text_type === 'password'} accent={accent} onCommit={onCommit} />
        </div>
      );
    }
    case 'path':
      return (
        <div style={{ ...ROW, ...dim }}>
          <span style={LABEL}>{prop.label}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <CommitText value={value || ''} accent={accent} onCommit={onCommit} />
            </div>
            <OutlinedBtn
              accent={accent}
              onClick={async () => {
                const opts = { defaultPath: value || prop.default_path || undefined };
                let picked = null;
                if (prop.path_type === 'directory') picked = await open({ ...opts, directory: true });
                else if (prop.path_type === 'file_save') picked = await save(opts);
                else picked = await open(opts);
                if (typeof picked === 'string' && picked) onCommit(picked);
              }}
            >
              Browse
            </OutlinedBtn>
          </div>
        </div>
      );
    case 'list': {
      const options = (prop.items || []).filter((i) => !i.disabled).map((i) => ({ value: i.value, label: i.name }));
      return (
        <div style={{ ...ROW, ...dim }}>
          <span style={LABEL} title={prop.long_desc}>{prop.label}</span>
          <CandySelect value={value} options={options} onChange={onCommit} title={prop.label} compact />
        </div>
      );
    }
    case 'color':
    case 'color_alpha': {
      const hex = abgrToHex(value ?? 0xffffffff);
      const alpha = prop.type === 'color_alpha' ? ((Number(value) >>> 24) & 0xff) : 0xff;
      return (
        <div style={{ ...ROW, ...dim }}>
          <span style={LABEL}>{prop.label}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span aria-hidden style={{ width: 22, height: 22, borderRadius: 6, background: hex, border: '2px solid var(--border-2)', flexShrink: 0 }} />
            <HexInput value={hex} onChange={(h) => onCommit(hexToAbgr(h, alpha))} accent={accent} />
          </div>
        </div>
      );
    }
    case 'button':
      return (
        <div style={{ ...dim }}>
          <OutlinedBtn
            accent={accent}
            onClick={() => {
              if (prop.button_type === 'url' && prop.url) window.open(prop.url, '_blank');
              else onButton(prop.name);
            }}
          >
            {prop.label}
          </OutlinedBtn>
        </div>
      );
    case 'editable_list': {
      const entries = Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : v?.value ?? '')).join('\n') : '';
      return (
        <div style={{ ...ROW, ...dim }}>
          <span style={LABEL}>{prop.label}</span>
          <textarea
            className="candy-input"
            defaultValue={entries}
            rows={4}
            placeholder="one entry per line"
            onBlur={(e) => {
              const next = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, selected: false, hidden: false }));
              onCommit(next);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            spellCheck={false}
            style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}
          />
        </div>
      );
    }
    case 'font': {
      const f = value && typeof value === 'object' ? value : {};
      const setF = (patch) => onCommit({ face: f.face || 'Arial', size: f.size || 32, flags: f.flags || 0, style: f.style || '', ...patch });
      const flags = f.flags || 0;
      return (
        <div style={{ ...ROW, ...dim }}>
          <span style={LABEL}>{prop.label}</span>
          <CommitText value={f.face || ''} accent={accent} onCommit={(face) => setF({ face })} />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ ...LABEL, textTransform: 'none' }}>size</span>
            <NumField value={f.size || 32} min={4} max={512} onCommit={(size) => setF({ size })} />
            <span style={{ ...LABEL, textTransform: 'none' }}>bold</span>
            <EnableToggle enabled={!!(flags & 1)} accent={accent} onChange={(v) => setF({ flags: v ? flags | 1 : flags & ~1 })} />
            <span style={{ ...LABEL, textTransform: 'none' }}>italic</span>
            <EnableToggle enabled={!!(flags & 2)} accent={accent} onChange={(v) => setF({ flags: v ? flags | 2 : flags & ~2 })} />
          </div>
        </div>
      );
    }
    case 'frame_rate':
      return <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{prop.label}: unsupported (v1)</div>;
    default:
      return null;
  }
}

function CommitText({ value, password, accent, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <TextInput
      value={draft}
      type={password ? 'password' : 'text'}
      accent={accent}
      onChange={(v) => setDraft(typeof v === 'string' ? v : v?.target?.value)}
      onBlur={() => { if (draft !== value) onCommit(draft); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
    />
  );
}

/// `omit`: property names a bespoke panel already renders above the form.
/// Optional `fetch`/`commit`/`onButton` swap the default scene-item wiring for
/// another PropSpec source (SP4 advanced-encoder page: get/set_encoder_properties).
/// Each defaults to the scene-item behavior; PropRow is untouched. `fetch()`
/// resolves `{props, settings}`; `commit(key,val)` resolves a promise (refetch
/// runs after); `onButton(propName)` resolves a promise.
export default function PropertiesForm({ api, sceneName, node, accent, omit, fetch: fetchProp, commit: commitProp, onButton }) {
  const [props, setProps] = useState(null);   // PropSpec[] | null loading
  const [settings, setSettings] = useState({});
  const aliveRef = useRef(true);

  const refetch = () => {
    (fetchProp ? fetchProp() : verb(api, 'get_properties', { scene: sceneName, item: node.item_id }))
      .then((r) => {
        if (!aliveRef.current) return;
        setProps(r?.props || []);
        setSettings(r?.settings || {});
      })
      .catch((e) => {
        console.warn('[broadcast] get_properties', e);
        if (aliveRef.current) setProps([]);
      });
  };

  useEffect(() => {
    aliveRef.current = true;
    setProps(null);
    refetch();
    return () => { aliveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sceneName, node.item_id]);

  const commit = (key, val) => {
    if (commitProp) {
      commitProp(key, val).then(refetch).catch((e) => console.warn('[broadcast] commit', e));
      return;
    }
    const before = { ...settings };
    verb(api, 'set_source_settings', { scene: sceneName, name: node.name, settings: { [key]: val } })
      .then(() => {
        pushUndo({
          label: `${node.name}: ${key}`,
          undo: [{ op: 'set_source_settings', args: { scene: sceneName, name: node.name, settings: before, replace: true } }],
          redo: [{ op: 'set_source_settings', args: { scene: sceneName, name: node.name, settings: { [key]: val } } }],
        });
        refetch();
      })
      .catch((e) => console.warn('[broadcast] set_source_settings', e));
  };

  const clickButton = (propName) => {
    (onButton ? onButton(propName) : verb(api, 'click_property_button', { scene: sceneName, item: node.item_id, prop: propName }))
      .then(() => refetch()) // always — cheaper than trusting the flag
      .catch((e) => console.warn('[broadcast] click_property_button', e));
  };

  const render = (list) => list.map((p) => {
    if (p.type === 'group') {
      const checkable = p.group_type === 'checkable';
      const on = checkable ? !!settings[p.name] : true;
      return (
        <div key={p.name} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <SectionHeader title={p.label} />
            {checkable && <EnableToggle enabled={on} accent={accent} onChange={(v) => commit(p.name, v)} />}
          </div>
          {on && <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 4 }}>{render(p.children || [])}</div>}
        </div>
      );
    }
    return (
      <PropRow
        key={p.name}
        prop={p}
        value={settings[p.name]}
        accent={accent}
        onCommit={(v) => commit(p.name, v)}
        onButton={clickButton}
      />
    );
  });

  if (props == null) return <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>loading</div>;
  const visible = omit?.length ? props.filter((p) => !omit.includes(p.name)) : props;
  if (!visible.length) return omit?.length ? null : <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>no properties</div>;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{render(visible)}</div>;
}

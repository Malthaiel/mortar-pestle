// Render typed inputs for a skill's Arguments: schema and report validity.
//
// type → input mapping:
//   string | url | path   → text input
//   integer               → number input
//   boolean               → checkbox
//   enum                  → select (options from arg.options[])
//
// SF8: argument key resolves to `arg.name` (Tauri-normalized) OR `arg.Name`
// (legacy fetch-fallback wire shape — vault YAML uses capital `Name:`). The
// nameOf() helper papers over both transports. Once SF12 deletes the Node
// path the fallback collapses and we can drop nameOf().

import { useEffect, useMemo, useState } from 'react';
import { Select, TextInput } from '@host/components/ui/index.js';

const nameOf = (arg) => arg?.name ?? arg?.Name ?? '';

function defaultsFor(args) {
  const out = {};
  for (const arg of args || []) {
    const key = nameOf(arg);
    if (!key) continue;
    if (arg.default !== undefined) out[key] = arg.default;
    else if (arg.type === 'boolean') out[key] = false;
    else out[key] = '';
  }
  return out;
}

export default function SkillArgsForm({ skill, values, onChange, onValidity, accent }) {
  // Reset/seed values when the selected skill changes
  useEffect(() => {
    if (!skill) return;
    onChange(defaultsFor(skill.arguments));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill?.slug]);

  const missingRequired = useMemo(() => {
    if (!skill) return [];
    return (skill.arguments || []).filter(arg => {
      if (!arg.required) return false;
      const v = values?.[nameOf(arg)];
      if (arg.type === 'boolean') return false;
      return v === undefined || v === null || String(v).trim() === '';
    });
  }, [skill, values]);

  useEffect(() => {
    onValidity?.(missingRequired.length === 0);
  }, [missingRequired, onValidity]);

  const accentColor = accent || 'var(--text)';

  if (!skill || !skill.arguments || skill.arguments.length === 0) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 14px',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-muted)',
        fontSize: 12, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: 'var(--text-faint)', flexShrink: 0,
        }}/>
        No arguments
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {skill.arguments.map((arg) => {
        const key = nameOf(arg);
        const v = values?.[key] ?? '';
        const set = (next) => onChange({ ...values, [key]: next });
        return (
          <ArgRow key={key} arg={arg} value={v} set={set} accent={accentColor}/>
        );
      })}
    </div>
  );
}

function ArgRow({ arg, value, set, accent }) {
  const label = nameOf(arg);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        fontSize: 9, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--text-faint)', fontWeight: 700,
      }}>
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        {arg.required && <span style={{ color: accent }}>*</span>}
        <span style={{
          color: 'var(--text-faint)',
          letterSpacing: '0.06em',
          fontWeight: 500,
        }}>{arg.type}</span>
      </div>

      {arg.type === 'boolean' ? (
        <BoolCheckbox value={value} onChange={set} description={arg.description} accent={accent}/>
      ) : arg.type === 'enum' ? (
        <Select
          value={value}
          onChange={set}
          options={[
            ...(arg.required ? [] : [{ value: '', label: '(none)' }]),
            ...(arg.options || []).map(o => ({ value: o, label: o })),
          ]}
          accent={accent}
        />
      ) : arg.type === 'integer' ? (
        <TextInput
          type="number"
          value={value}
          onChange={v => set(v === '' ? '' : parseInt(v, 10))}
          placeholder={arg.description}
          accent={accent}
        />
      ) : (
        <TextInput
          type={arg.type === 'url' ? 'url' : 'text'}
          value={value}
          onChange={set}
          placeholder={arg.description}
          accent={accent}
        />
      )}

      {arg.type !== 'boolean' && arg.description && (
        <div style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          lineHeight: 1.5,
        }}>{arg.description}</div>
      )}
    </div>
  );
}

function BoolCheckbox({ value, onChange, description, accent }) {
  const [hover, setHover] = useState(false);
  const checked = !!value;
  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px',
        background: hover ? 'var(--hover)' : 'var(--surface-2)',
        border: `1px solid ${checked ? accent : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        transition: 'all 80ms ease',
      }}
    >
      <span style={{
        width: 16, height: 16,
        borderRadius: 4,
        border: `1.5px solid ${checked ? accent : 'var(--border-2, var(--border))'}`,
        background: checked ? accent : 'transparent',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        transition: 'all 80ms ease',
      }}>
        {checked && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white"
               strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          position: 'absolute', opacity: 0, pointerEvents: 'none',
          width: 0, height: 0,
        }}
      />
      {description && (
        <span style={{
          fontSize: 13, color: 'var(--text-2)',
          flex: 1,
        }}>{description}</span>
      )}
    </label>
  );
}

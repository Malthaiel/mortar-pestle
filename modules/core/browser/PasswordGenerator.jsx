// Configurable password generator panel. Calls the stateless backend
// `creds_generate_password` (works whether the vault is locked or not). Used
// standalone in the vault Tools panel; the entry editor uses a quick-generate
// shortcut via PasswordField.

import { useCallback, useEffect, useState } from 'react';
import * as creds from './credsStore.js';
import { copySecret } from './useVaultLock.js';
import { CopyGlyph, RefreshGlyph } from './vaultIcons.jsx';

const box = {
  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12,
  display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--surface-2)',
};
const out = {
  flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
  font: 'inherit', fontFamily: 'var(--font-mono, monospace)',
};
const mini = {
  width: 30, height: 30, flex: '0 0 auto', display: 'grid', placeItems: 'center',
  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer',
};
const checkRow = { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--text)' };

export default function PasswordGenerator({ accent, clearSecs = 30, onUse }) {
  const [length, setLength] = useState(20);
  const [lower, setLower] = useState(true);
  const [upper, setUpper] = useState(true);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [avoid, setAvoid] = useState(true);
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  const gen = useCallback(async () => {
    setErr('');
    try {
      const pw = await creds.generate({ length, lower, upper, digits, symbols, avoidAmbiguous: avoid });
      setValue(pw);
    } catch (e) {
      setErr(e?.message || 'Could not generate.');
    }
  }, [length, lower, upper, digits, symbols, avoid]);

  useEffect(() => { gen(); }, [gen]);

  const copy = async () => {
    if (value && await copySecret(value, clearSecs)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const check = (label, val, set) => (
    <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="checkbox" checked={val} onChange={e => set(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <div style={box}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input style={out} value={value} readOnly spellCheck={false} />
        <button type="button" style={{ ...mini, ...(copied ? { borderColor: accent, color: accent } : {}) }} title="Copy" onClick={copy}><CopyGlyph /></button>
        <button type="button" style={mini} title="Regenerate" onClick={gen}><RefreshGlyph /></button>
      </div>
      <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
        Length {length}
        <input type="range" min="8" max="64" value={length} style={{ flex: 1 }}
          onChange={e => setLength(Number(e.target.value))} />
      </label>
      <div style={checkRow}>
        {check('a-z', lower, setLower)}
        {check('A-Z', upper, setUpper)}
        {check('0-9', digits, setDigits)}
        {check('!@#', symbols, setSymbols)}
        {check('No look-alikes', avoid, setAvoid)}
      </div>
      {err && <span style={{ fontSize: 12, color: 'var(--danger, var(--text))' }}>{err}</span>}
      {onUse && (
        <button type="button" onClick={() => onUse(value)}
          style={{ padding: '7px 12px', borderRadius: 'var(--radius-md)', border: `1px solid ${accent}`, background: accent, color: '#fff', cursor: 'pointer', font: 'inherit', fontWeight: 600 }}>
          Use this password
        </button>
      )}
    </div>
  );
}

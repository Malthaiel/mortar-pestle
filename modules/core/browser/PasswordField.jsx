// Reusable masked password field: mask-by-default, timed reveal, copy (with
// clipboard auto-clear), and an optional generate button. Used in the per-site
// add form and (SF4) the full entry editor.

import { useEffect, useRef, useState } from 'react';
import { EyeGlyph, CopyGlyph, RefreshGlyph } from './vaultIcons.jsx';
import { copySecret } from './useVaultLock.js';

const mini = {
  width: 28, height: 28, flex: '0 0 auto', display: 'grid', placeItems: 'center',
  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer',
};
const field = {
  flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
  font: 'inherit', fontFamily: 'var(--font-mono, monospace)',
};

export default function PasswordField({
  value, onChange, placeholder = 'Password', accent,
  onGenerate, revealRemaskSecs = 20, clearSecs = 30, autoComplete = 'off',
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const remask = useRef(null);

  useEffect(() => () => { if (remask.current) clearTimeout(remask.current); }, []);

  const toggleReveal = () => {
    setRevealed(prev => {
      const next = !prev;
      if (remask.current) clearTimeout(remask.current);
      if (next && revealRemaskSecs > 0) {
        remask.current = setTimeout(() => setRevealed(false), revealRemaskSecs * 1000);
      }
      return next;
    });
  };

  const doCopy = async () => {
    if (!value) return;
    if (await copySecret(value, clearSecs)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete={autoComplete}
        style={field}
      />
      <button type="button" title={revealed ? 'Hide' : 'Reveal'} style={mini} onClick={toggleReveal}>
        <EyeGlyph off={revealed} />
      </button>
      <button
        type="button"
        title={copied ? 'Copied' : 'Copy'}
        style={{ ...mini, ...(copied ? { borderColor: accent, color: accent } : {}) }}
        onClick={doCopy}
      >
        <CopyGlyph />
      </button>
      {onGenerate && (
        <button type="button" title="Generate password" style={mini} onClick={onGenerate}>
          <RefreshGlyph />
        </button>
      )}
    </div>
  );
}

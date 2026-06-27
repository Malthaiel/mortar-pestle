// Per-site vault popover (browser-extension style), rendered as a top drop-panel
// via the shared BrowserPopover shell (BrowserPage shrinks the native WebKit view
// down to make room — it renders ABOVE the React chrome, so it can't be overlaid).
// Calls only creds_match_host / creds_get — the full vault never crosses here.

import { useCallback, useEffect, useState } from 'react';
import * as creds from './credsStore.js';
import { useCredsStore } from './useCredsStore.js';
import PasswordField from './PasswordField.jsx';
import { EyeGlyph, CopyGlyph } from './vaultIcons.jsx';
import { copySecret } from './useVaultLock.js';
import BrowserPopover from './BrowserPopover.jsx';

const input = {
  width: '100%', padding: '6px 10px', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', font: 'inherit',
};
const label = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 };
const errStyle = { fontSize: 12, color: 'var(--danger, var(--text))' };
const note = { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 };

function primaryBtn(accent) {
  return {
    padding: '7px 14px', borderRadius: 'var(--radius-md)', border: `1px solid ${accent}`,
    background: accent, color: '#fff', cursor: 'pointer', font: 'inherit', fontWeight: 600,
  };
}
const ghostBtn = {
  padding: '7px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', font: 'inherit',
};
const rowMini = {
  width: 28, height: 28, flex: '0 0 auto', display: 'grid', placeItems: 'center',
  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer',
};

export default function SitePopover({ api, accent, host, clipboardClearSecs = 30, revealRemaskSecs = 20, onClose }) {
  const { status } = useCredsStore();
  const initialized = !!status?.initialized;
  const unlocked = !!status?.unlocked;
  useEffect(() => { creds.refresh(); }, []); // re-sync lock state when the popover opens
  const openVault = () => { api?.router?.navigate('/tools/browser/vault'); onClose(); };

  return (
    <BrowserPopover title="Password Vault" host={host} onClose={onClose}>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!status && <span style={note}>Loading…</span>}
        {status && !initialized && <SetupForm accent={accent} onDone={onClose} />}
        {status && initialized && !unlocked && <UnlockForm accent={accent} />}
        {status && unlocked && (
          <MatchesView
            accent={accent}
            host={host}
            clipboardClearSecs={clipboardClearSecs}
            revealRemaskSecs={revealRemaskSecs}
            onOpenVault={openVault}
          />
        )}
      </div>
    </BrowserPopover>
  );
}

function SetupForm({ accent, onDone }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [stay, setStay] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (pw.length < 1) { setErr('Choose a master password.'); return; }
    if (pw !== confirm) { setErr('Passwords do not match.'); return; }
    setBusy(true); setErr('');
    try {
      await creds.initMaster(pw, stay);
      setPw(''); setConfirm('');
    } catch (e) {
      setErr(e?.message || 'Could not create the vault.');
    } finally { setBusy(false); }
  };

  return (
    <>
      <span style={note}>
        Create a master password. It encrypts everything and is <strong>never stored</strong> —
        there is no recovery, so back up an export once you’re set up.
      </span>
      <div>
        <label style={label}>Master password</label>
        <input type="password" style={input} value={pw} autoFocus
          onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
      </div>
      <div>
        <label style={label}>Confirm</label>
        <input type="password" style={input} value={confirm}
          onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--text)' }}>
        <input type="checkbox" checked={stay} onChange={e => setStay(e.target.checked)} />
        Stay unlocked on this device (OS keyring)
      </label>
      {err && <span style={errStyle}>{err}</span>}
      <button type="button" style={primaryBtn(accent)} disabled={busy} onClick={submit}>
        {busy ? 'Creating…' : 'Create vault'}
      </button>
    </>
  );
}

function UnlockForm({ accent }) {
  const [pw, setPw] = useState('');
  const [stay, setStay] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pw) return;
    setBusy(true); setErr('');
    try {
      await creds.unlock(pw, stay);
      setPw('');
    } catch (e) {
      setErr(e?.message || 'Could not unlock.');
    } finally { setBusy(false); }
  };

  return (
    <>
      <div>
        <label style={label}>Master password</label>
        <input type="password" style={input} value={pw} autoFocus
          onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--text)' }}>
        <input type="checkbox" checked={stay} onChange={e => setStay(e.target.checked)} />
        Stay unlocked on this device (OS keyring)
      </label>
      {err && <span style={errStyle}>{err}</span>}
      <button type="button" style={primaryBtn(accent)} disabled={busy} onClick={submit}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
    </>
  );
}

function MatchesView({ accent, host, clipboardClearSecs, revealRemaskSecs, onOpenVault }) {
  const [matches, setMatches] = useState(null); // null = loading
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setMatches(await creds.matchHost(host));
  }, [host]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      {matches === null && <span style={note}>Searching…</span>}
      {matches && matches.length === 0 && !adding && (
        <span style={note}>No saved logins for {host || 'this site'}.</span>
      )}
      {matches && matches.map(m => (
        <MatchRow key={m.id} m={m} accent={accent}
          clipboardClearSecs={clipboardClearSecs} revealRemaskSecs={revealRemaskSecs} />
      ))}

      {!adding && (
        <button type="button" style={ghostBtn} onClick={() => setAdding(true)}>
          ＋ Add login for this site
        </button>
      )}
      {adding && (
        <AddForm accent={accent} host={host}
          onSaved={() => { setAdding(false); load(); }}
          onCancel={() => setAdding(false)} />
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="button" style={ghostBtn} onClick={() => creds.lock()}>Lock now</button>
        {onOpenVault && <button type="button" style={ghostBtn} onClick={onOpenVault}>Open full vault</button>}
      </div>
    </>
  );
}

function MatchRow({ m, accent, clipboardClearSecs, revealRemaskSecs }) {
  const [revealed, setRevealed] = useState('');
  const [copied, setCopied] = useState('');

  const copyField = async (which) => {
    try {
      const full = await creds.getEntry(m.id);
      const val = which === 'user' ? full.username : full.password;
      if (await copySecret(val, clipboardClearSecs)) {
        setCopied(which);
        setTimeout(() => setCopied(''), 1200);
      }
    } catch { /* locked or gone */ }
  };
  const toggleReveal = async () => {
    if (revealed) { setRevealed(''); return; }
    try {
      const full = await creds.getEntry(m.id);
      setRevealed(full.password || '');
      if (revealRemaskSecs > 0) setTimeout(() => setRevealed(''), revealRemaskSecs * 1000);
    } catch { /* ignore */ }
  };

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      padding: 8, display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--surface-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {m.title || m.username || m.host}
        </strong>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {m.username || '—'}
        </span>
        <button type="button" style={miniTint(copied === 'user', accent)} title="Copy username" onClick={() => copyField('user')}><CopyGlyph /></button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--text)', fontFamily: 'var(--font-mono, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {revealed || '••••••••••'}
        </span>
        <button type="button" style={rowMini} title={revealed ? 'Hide' : 'Reveal'} onClick={toggleReveal}><EyeGlyph off={!!revealed} /></button>
        <button type="button" style={miniTint(copied === 'pass', accent)} title="Copy password" onClick={() => copyField('pass')}><CopyGlyph /></button>
      </div>
    </div>
  );
}

function miniTint(on, accent) {
  return { ...rowMini, ...(on ? { borderColor: accent, color: accent } : {}) };
}

function AddForm({ accent, host, onSaved, onCancel }) {
  const [title, setTitle] = useState(host || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [origin, setOrigin] = useState(host ? `https://${host}` : '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const gen = async () => {
    try {
      const pw = await creds.generate({ length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true });
      setPassword(pw);
    } catch (e) { setErr(e?.message || 'Generate failed.'); }
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await creds.upsert({ title, username, password, origin: origin || null, tags: [], customFields: [], notes: '' });
      onSaved();
    } catch (e) {
      setErr(e?.message || 'Could not save.');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div><label style={label}>Name</label>
        <input style={input} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. GitHub" /></div>
      <div><label style={label}>Username / email</label>
        <input style={input} value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" /></div>
      <div><label style={label}>Password</label>
        <PasswordField value={password} onChange={setPassword} accent={accent} onGenerate={gen} /></div>
      <div><label style={label}>Site</label>
        <input style={input} value={origin} onChange={e => setOrigin(e.target.value)} placeholder="https://example.com" /></div>
      {err && <span style={errStyle}>{err}</span>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={primaryBtn(accent)} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" style={ghostBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

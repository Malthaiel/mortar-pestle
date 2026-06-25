// Password-vault management sections — Backup & restore (ExportImport),
// Security (SettingsPanel), and Master password (ChangeMaster). Moved out of
// VaultRoute's Tools view; their settings home is now the Browser settings
// page (Settings → Modules › Browser › Password Vault). The in-browser vault
// route keeps the Generator and the logins list.

import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import * as creds from './credsStore.js';
import { writeModuleSetting } from '@host/module-sdk/index.js';

const input = { padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', font: 'inherit' };
const ghost = { padding: '7px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', font: 'inherit' };
function primary(accent) { return { ...ghost, border: `1px solid ${accent}`, background: accent, color: '#fff', fontWeight: 600 }; }
function basename(p) { if (!p) return ''; const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i >= 0 ? p.slice(i + 1) : p; }

export function ExportImport({ accent }) {
  const [exPw, setExPw] = useState('');
  const [exOut, setExOut] = useState('');
  const [imData, setImData] = useState('');
  const [imFile, setImFile] = useState('');            // absolute path picked from disk
  const [imFmt, setImFmt] = useState('bitwarden');
  const [imMode, setImMode] = useState('merge');
  const [imPw, setImPw] = useState('');
  const [msg, setMsg] = useState('');
  const [skipped, setSkipped] = useState([]);          // SkipInfo[] from the last import
  const [lastImported, setLastImported] = useState(''); // plaintext file eligible for cleanup

  const doExport = async (encrypted) => {
    setMsg('');
    try {
      if (encrypted && !exPw) { setMsg('Enter an export password (your backup key).'); return; }
      if (!encrypted && !window.confirm('Plaintext export writes your passwords UNENCRYPTED. Continue?')) return;
      const res = await creds.exportVault(encrypted ? exPw : null);
      setExOut(res.data);
      writeModuleSetting('browser', 'vaultBackupDone', true);
      setMsg(encrypted ? 'Encrypted export ready — copy it somewhere safe.' : 'Plaintext export ready (handle with care).');
    } catch (e) { setMsg(e?.message || 'Export failed.'); }
  };
  const pickFile = async () => {
    setMsg('');
    try {
      await creds.suppressBlurLock(); // app-owned dialog blur must not lock the vault mid-import
      const p = await openDialog({ multiple: false, filters: [{ name: 'Vault export', extensions: ['json', 'csv', 'txt'] }] });
      if (typeof p === 'string') setImFile(p);
    } catch (e) { setMsg(String(e?.message || e)); }
  };
  const doImport = async () => {
    setMsg(''); setSkipped([]);
    if (imMode === 'replace' && !window.confirm('Replace all wipes every entry in your current vault. Continue?')) return;
    try {
      let s;
      if (imFile) {
        s = await creds.importVaultFile(imFile, imFmt, imPw || null, imMode);
        setLastImported(imFile);
        setImFile('');
      } else {
        s = await creds.importVault(imData, imFmt, imPw || null, imMode);
        setImData('');
      }
      setMsg(`Imported: ${s.added} added, ${s.updated} updated, ${s.skipped} skipped.`);
      setSkipped(Array.isArray(s.skippedItems) ? s.skippedItems : []);
    } catch (e) { setMsg(e?.message || 'Import failed.'); }
  };
  const doDeleteExport = async () => {
    if (!window.confirm(`Delete the plaintext export file "${basename(lastImported)}" from disk?`)) return;
    try {
      await creds.deleteImportFile(lastImported);
      setMsg(`Deleted ${basename(lastImported)} from disk.`);
      setLastImported('');
    } catch (e) { setMsg(e?.message || 'Delete failed.'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="password" style={{ ...input, flex: 1, minWidth: 160 }} placeholder="Export password" value={exPw} onChange={e => setExPw(e.target.value)} />
        <button type="button" style={primary(accent)} onClick={() => doExport(true)}>Export (encrypted)</button>
        <button type="button" style={ghost} onClick={() => doExport(false)}>Plaintext…</button>
      </div>
      {exOut && <textarea readOnly style={{ ...input, minHeight: 70, fontFamily: 'var(--font-mono,monospace)', fontSize: 11 }} value={exOut} onFocus={e => e.target.select()} />}
      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '4px 0' }} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select style={input} value={imFmt} onChange={e => setImFmt(e.target.value)}>
          <option value="bitwarden">Bitwarden JSON</option>
          <option value="csv">CSV</option>
          <option value="agentic">Agentic JSON</option>
          <option value="encrypted">Encrypted (.enc hex)</option>
        </select>
        <select style={input} value={imMode} onChange={e => setImMode(e.target.value)}>
          <option value="merge">Merge</option>
          <option value="replace">Replace all</option>
        </select>
        {imFmt === 'encrypted' && <input type="password" style={input} placeholder="Import password" value={imPw} onChange={e => setImPw(e.target.value)} />}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input style={{ ...input, flex: 1 }} value={imFile ? basename(imFile) : ''} readOnly placeholder="No file chosen" />
        <button type="button" style={ghost} onClick={pickFile}>Choose file…</button>
        <button type="button" style={primary(accent)} disabled={!imFile && !imData.trim()} onClick={doImport}>Import</button>
      </div>
      <textarea style={{ ...input, minHeight: 70, fontFamily: 'var(--font-mono,monospace)', fontSize: 11 }} placeholder="…or paste export data to import" value={imData} onChange={e => setImData(e.target.value)} />
      {msg && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{msg}</span>}
      {skipped.length > 0 && (
        <details style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          <summary style={{ cursor: 'pointer' }}>{skipped.length} skipped item{skipped.length === 1 ? '' : 's'}</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {skipped.map((s, i) => <li key={i}>{s.name} — {s.reason}</li>)}
          </ul>
        </details>
      )}
      {lastImported && (
        <button type="button" style={{ ...ghost, alignSelf: 'flex-start', borderColor: 'var(--error)', color: 'var(--error)' }} onClick={doDeleteExport}>
          Delete export file (plaintext): {basename(lastImported)}
        </button>
      )}
    </div>
  );
}

export function SettingsPanel({ accent, status }) {
  const [msg, setMsg] = useState('');
  const apply = async (patch) => {
    setMsg('');
    try {
      await creds.settingsSet({
        idleTimeoutSecs: status.idleTimeoutSecs,
        clipboardClearSecs: status.clipboardClearSecs,
        revealRemaskSecs: status.revealRemaskSecs,
        lockOnBlur: status.lockOnBlur,
        ...patch,
      });
    } catch (e) { setMsg(e?.message || 'Failed.'); }
  };
  const slider = (lbl, key, min, max, unit, scale = 1) => (
    <label style={{ fontSize: 12, color: 'var(--text)', display: 'flex', gap: 8, alignItems: 'center' }}>
      <span style={{ width: 150 }}>{lbl}: {Math.round(status[key] / scale)}{unit}</span>
      <input type="range" min={min} max={max} value={Math.round(status[key] / scale)} style={{ flex: 1 }}
        onChange={e => apply({ [key]: Number(e.target.value) * scale })} />
    </label>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {slider('Auto-lock after idle', 'idleTimeoutSecs', 1, 120, ' min', 60)}
      {slider('Clear clipboard after', 'clipboardClearSecs', 5, 120, ' s')}
      {slider('Re-mask reveal after', 'revealRemaskSecs', 3, 120, ' s')}
      <label style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={!!status.lockOnBlur} onChange={e => apply({ lockOnBlur: e.target.checked })} /> Lock when the app loses focus
      </label>
      <label style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={!!status.keyringEnabled}
          onChange={async e => { try { await creds.setKeyringUnlock(e.target.checked); } catch (err) { setMsg(err?.message || 'Keyring unavailable.'); } }} />
        Stay unlocked on this device (OS keyring)
      </label>
      {msg && <span style={{ fontSize: 12, color: 'var(--danger,#e5484d)' }}>{msg}</span>}
    </div>
  );
}

export function ChangeMaster({ accent }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setMsg('');
    if (next !== confirm) { setMsg('New passwords do not match.'); return; }
    setBusy(true);
    try { await creds.changeMaster(cur, next); setCur(''); setNext(''); setConfirm(''); setMsg('Master password changed.'); }
    catch (e) { setMsg(e?.message || 'Failed.'); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320 }}>
      <input type="password" style={input} placeholder="Current master password" value={cur} onChange={e => setCur(e.target.value)} />
      <input type="password" style={input} placeholder="New master password" value={next} onChange={e => setNext(e.target.value)} />
      <input type="password" style={input} placeholder="Confirm new" value={confirm} onChange={e => setConfirm(e.target.value)} />
      {msg && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{msg}</span>}
      <button type="button" style={primary(accent)} disabled={busy} onClick={submit}>{busy ? '…' : 'Change master password'}</button>
    </div>
  );
}

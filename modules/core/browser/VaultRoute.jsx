// Full-page vault management surface, rendered by BrowserPage when the route is
// /tools/browser/vault (the native web view is hidden while it shows). Handles
// locked/setup state, the searchable entry list with a folder rail, the entry
// editor, and a Tools view (generator, export/import, change master, settings).

import { useEffect, useMemo, useState } from 'react';
import * as creds from './credsStore.js';
import { useCredsStore } from './useCredsStore.js';
import { readModuleBag, writeModuleSetting } from '@host/module-sdk/index.js';
import VaultEntryEditor from './VaultEntryEditor.jsx';
import PasswordGenerator from './PasswordGenerator.jsx';
import { LockGlyph } from './vaultIcons.jsx';

const wrap = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg)', position: 'relative' };
const bar = { display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderBottom: '1px solid var(--border)', background: 'var(--surface)', flex: '0 0 auto' };
const input = { padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', font: 'inherit' };
const ghost = { padding: '7px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', font: 'inherit' };
const label = { fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 3 };
function primary(accent) { return { ...ghost, border: `1px solid ${accent}`, background: accent, color: '#fff', fontWeight: 600 }; }

export default function VaultRoute({ api, accent, onClose }) {
  const { status, entries, folders } = useCredsStore();
  const [view, setView] = useState('entries'); // 'entries' | 'tools'
  const [editing, setEditing] = useState(null); // {id} | {new:true} | null
  const [folderSel, setFolderSel] = useState('all');
  const [query, setQuery] = useState('');
  const [naming, setNaming] = useState(null); // {id:null}=adding, {id}=renaming

  useEffect(() => { creds.refresh(); }, []); // re-sync lock state when opening the page

  const unlocked = !!status?.unlocked;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(e => {
      if (folderSel === 'unfiled' && e.folder) return false;
      if (folderSel !== 'all' && folderSel !== 'unfiled' && e.folder !== folderSel) return false;
      if (!q) return true;
      return [e.title, e.username, e.host].some(v => (v || '').toLowerCase().includes(q));
    });
  }, [entries, folderSel, query]);

  if (!status) return <Centered onClose={onClose}>Loading…</Centered>;
  if (!unlocked) return <LockedView initialized={!!status.initialized} accent={accent} onClose={onClose} />;

  const submitName = async (value) => {
    const name = (value || '').trim();
    const target = naming;
    setNaming(null);
    if (!name) return;
    if (target && target.id) {
      if (name === folders.find(x => x.id === target.id)?.name) return;
      await creds.setFolders(folders.map(x => x.id === target.id ? { ...x, name } : x));
    } else {
      const id = (crypto?.randomUUID?.() || ('f' + Date.now()));
      await creds.setFolders([...folders, { id, name, parent: null }]);
    }
  };
  const deleteFolder = async (f) => {
    if (!window.confirm(`Delete folder "${f.name}"? Entries become Unfiled.`)) return;
    await creds.setFolders(folders.filter(x => x.id !== f.id));
    if (folderSel === f.id) setFolderSel('all');
  };

  return (
    <div style={wrap}>
      <div style={bar}>
        <LockGlyph open />
        <strong style={{ fontSize: 14 }}>Password Vault</strong>
        <div style={{ flex: 1 }} />
        <button type="button" style={view === 'entries' ? primary(accent) : ghost} onClick={() => setView('entries')}>Logins</button>
        <button type="button" style={view === 'tools' ? primary(accent) : ghost} onClick={() => setView('tools')}>Tools</button>
        <button type="button" style={ghost} onClick={() => creds.lock()}>Lock</button>
        <button type="button" style={ghost} onClick={onClose} title="Back to browser">✕</button>
      </div>

      <BackupNudge accent={accent} onExport={() => setView('tools')} />

      {view === 'entries' ? (
        <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}>
          <div style={{ width: 200, flex: '0 0 auto', borderRight: '1px solid var(--border)', overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <FolderRow active={folderSel === 'all'} onClick={() => setFolderSel('all')} label={`All (${entries.length})`} accent={accent} />
            <FolderRow active={folderSel === 'unfiled'} onClick={() => setFolderSel('unfiled')} label="Unfiled" accent={accent} />
            {folders.map(f => (
              naming && naming.id === f.id
                ? <FolderNameInput key={f.id} initial={f.name} onSubmit={submitName} onCancel={() => setNaming(null)} />
                : <FolderRow key={f.id} active={folderSel === f.id} onClick={() => setFolderSel(f.id)} label={f.name} accent={accent}
                    onRename={() => setNaming({ id: f.id })} onDelete={() => deleteFolder(f)} />
            ))}
            {naming && !naming.id
              ? <FolderNameInput initial="" onSubmit={submitName} onCancel={() => setNaming(null)} />
              : <button type="button" style={{ ...ghost, marginTop: 6 }} onClick={() => setNaming({ id: null })}>＋ Folder</button>}
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', gap: 8, padding: 10, borderBottom: '1px solid var(--border)' }}>
              <input style={{ ...input, flex: 1 }} placeholder="Search logins…" value={query} onChange={e => setQuery(e.target.value)} />
              <button type="button" style={primary(accent)} onClick={() => setEditing({ new: true })}>＋ New</button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shown.length === 0 && <span style={{ fontSize: 13, color: 'var(--text-muted)', padding: 8 }}>No logins.</span>}
              {shown.map(e => (
                <button key={e.id} type="button" onClick={() => setEditing({ id: e.id })}
                  style={{ textAlign: 'left', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 10px', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title || e.username || e.host || 'Untitled'}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[e.username, e.host].filter(Boolean).join(' · ') || '—'}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <ToolsView accent={accent} status={status} api={api} />
      )}

      {editing && (
        <VaultEntryEditor
          entryId={editing.id || null}
          folders={folders}
          accent={accent}
          settings={status}
          onSaved={() => setEditing(null)}
          onDeleted={() => setEditing(null)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function FolderRow({ active, label, accent, onClick, onRename, onDelete }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <button type="button" onClick={onClick}
        style={{ flex: 1, textAlign: 'left', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid transparent', background: active ? 'var(--surface-2)' : 'transparent', color: active ? accent : 'var(--text)', cursor: 'pointer', font: 'inherit', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </button>
      {onRename && <button type="button" title="Rename" onClick={onRename} style={miniBtn}>✎</button>}
      {onDelete && <button type="button" title="Delete" onClick={onDelete} style={miniBtn}>✕</button>}
    </div>
  );
}
const miniBtn = { width: 22, height: 22, flex: '0 0 auto', display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-sm)', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 };

function FolderNameInput({ initial, onSubmit, onCancel }) {
  const [v, setV] = useState(initial || '');
  return (
    <input autoFocus value={v} onChange={e => setV(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') onSubmit(v); else if (e.key === 'Escape') onCancel(); }}
      onBlur={() => onSubmit(v)} placeholder="Folder name"
      style={{ padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 13 }} />
  );
}

function Centered({ children, onClose }) {
  return (
    <div style={wrap}>
      <div style={bar}><strong style={{ fontSize: 14, flex: 1 }}>Password Vault</strong>
        <button type="button" style={ghost} onClick={onClose}>✕</button></div>
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>{children}</div>
    </div>
  );
}

function LockedView({ initialized, accent, onClose }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [stay, setStay] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      if (initialized) { await creds.unlock(pw, stay); }
      else {
        if (pw !== confirm) { setErr('Passwords do not match.'); setBusy(false); return; }
        await creds.initMaster(pw, stay);
      }
      setPw(''); setConfirm('');
    } catch (e) { setErr(e?.message || 'Failed.'); } finally { setBusy(false); }
  };

  return (
    <div style={wrap}>
      <div style={bar}><strong style={{ fontSize: 14, flex: 1 }}>Password Vault</strong>
        <button type="button" style={ghost} onClick={onClose}>✕</button></div>
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ width: 'min(360px,100%)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <strong style={{ fontSize: 15 }}>{initialized ? 'Unlock vault' : 'Create your vault'}</strong>
          {!initialized && <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>The master password encrypts everything and is never stored — there's no recovery, so export a backup once set up.</span>}
          <input type="password" style={input} placeholder="Master password" value={pw} autoFocus
            onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
          {!initialized && <input type="password" style={input} placeholder="Confirm" value={confirm}
            onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={stay} onChange={e => setStay(e.target.checked)} /> Stay unlocked on this device
          </label>
          {err && <span style={{ fontSize: 12, color: 'var(--danger,var(--text))' }}>{err}</span>}
          <button type="button" style={primary(accent)} disabled={busy} onClick={submit}>{busy ? '…' : (initialized ? 'Unlock' : 'Create vault')}</button>
        </div>
      </div>
    </div>
  );
}

function BackupNudge({ accent, onExport }) {
  const [done, setDone] = useState(() => !!readModuleBag('browser').vaultBackupDone);
  if (done) return null;
  const dismiss = () => { writeModuleSetting('browser', 'vaultBackupDone', true); setDone(true); };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
      <span style={{ flex: 1, color: 'var(--text)' }}>Back up your vault — it lives only on this machine and there's no recovery. Export an encrypted copy from Tools.</span>
      <button type="button" style={primary(accent)} onClick={() => { onExport(); dismiss(); }}>Go to Tools</button>
      <button type="button" style={ghost} onClick={dismiss}>Dismiss</button>
    </div>
  );
}

function ToolsView({ accent, status, api }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 640 }}>
      <section><h3 style={h3}>Generator</h3><PasswordGenerator accent={accent} clearSecs={status?.clipboardClearSecs ?? 30} /></section>
      <section>
        <h3 style={h3}>Backup, security &amp; master password</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Moved to Settings → Modules › Browser › Password Vault.
          </span>
          <button type="button" style={ghost}
            onClick={() => api?.events?.emit('host:open-settings', { path: 'modules/browser/vault' })}>
            Open settings
          </button>
        </div>
      </section>
    </div>
  );
}
const h3 = { fontSize: 13, margin: '0 0 8px', color: 'var(--text)' };

// ExportImport, SettingsPanel, and ChangeMaster moved to
// VaultSettingsSections.jsx — they render in the Browser settings page
// (Settings → Modules › Browser › Password Vault).

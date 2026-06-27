// Settings → Vaults. The full management surface for the multi-vault registry:
// switch the active vault, add a folder via the native picker (.obsidian/
// validated), remove a non-active vault, and (re)generate its app-data
// manifest. Quick-switch also lives in the dock (the DockVaultSwitcher button);
// this tab is where vaults are added/removed.

import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { api } from '../../api.js';
import { useVaults, useConfirmableSwitch } from '../../hooks/useVaults.jsx';
import { sharedEvents } from '../../module-sdk/index.js';
import { OutlinedBtn } from '../ui/Button.jsx';
import EnableToggle from '../ui/EnableToggle.jsx';
import ConfirmModal from '../ui/ConfirmModal.jsx';
import { IconCheck, IconDatabase, IconPlus, IconX, IconRepeat, IconLock } from '../icons.jsx';
import { useVaultStatus } from '../../hooks/useVaultStatus.js';

// Active-vault status strip — connection dot + vault name + Reload, moved
// from the System tab. Reload re-reads vault content into the running app;
// it is distinct from each vault row's "Regen" (on-disk manifest rebuild).
function ActiveVaultStrip({ accent }) {
  const { vaultStatus, vaultName, loadVault } = useVaultStatus();
  return (
    <div className="candy-section" data-search-anchor="set-vaultConnection"
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', marginBottom: 12 }}>
      <VaultStatusDisplay status={vaultStatus} name={vaultName}/>
      <div style={{ flex: 1 }}/>
      <OutlinedBtn small onClick={loadVault} disabled={vaultStatus === 'loading'}>
        {vaultStatus === 'loading' ? 'Loading…' : 'Reload vault'}
      </OutlinedBtn>
    </div>
  );
}

function vaultStatusTodayDs() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function VaultStatusDisplay({ status, name }) {
  let dotColor = 'var(--text-faint)';
  let dotRing = false;
  let label = '';
  let labelColor = 'var(--text-muted)';
  if (status === 'connected') {
    dotColor = 'var(--text-muted)'; dotRing = true; label = name; labelColor = 'var(--text)';
  } else if (status === 'loading') {
    label = 'Loading…'; labelColor = 'var(--text-faint)';
  } else if (status === 'no-note') {
    dotColor = '#d9a55a'; label = `${vaultStatusTodayDs()}.md not found`;
  } else if (status === 'error') {
    dotColor = 'var(--text)'; label = 'Backend unreachable'; labelColor = 'var(--text)';
  } else {
    label = String(status || '');
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: dotColor,
        boxShadow: dotRing ? `0 0 0 3px color-mix(in oklch, ${dotColor} 22%, transparent)` : 'none',
        flexShrink: 0,
      }}/>
      <span style={{
        fontSize: 12, fontFamily: 'var(--font-mono)',
        letterSpacing: '0.04em', color: labelColor,
      }}>{label}</span>
    </div>
  );
}

export default function VaultsTab({ accent }) {
  const { vaults, activeId, activeVault, addVault, createVault, setVaultMapping, removeVault, validate, regenerateManifest } = useVaults();
  const { request, pending, confirm, cancel } = useConfirmableSwitch();
  const [draft, setDraft] = useState(null); // null | { path, name, manifestEnabled, mode: 'create' | 'add' }
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [adopted, setAdopted] = useState(null); // null | { id, name, notes, folders, manifest }
  const [mappingOpen, setMappingOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const notify = (title, message) => {
    try {
      window.dispatchEvent(new CustomEvent('agentic:notify', { detail: { type: 'info', title, message, duration: 4000 } }));
    } catch {}
  };

  // mode 'create' → scaffold an empty folder (refuse-non-empty is enforced
  // server-side, so we skip validate here); mode 'add' → adopt an existing
  // .obsidian/ vault.
  const pickFolder = async (mode) => {
    setError(null); setNote(null); setAdopted(null);
    let picked;
    try {
      picked = await open({
        directory: true, multiple: false,
        title: mode === 'create' ? 'Choose an empty folder for the new vault' : 'Select an Obsidian vault folder',
      });
    } catch {
      setError('Could not open the folder picker.');
      return;
    }
    const path = typeof picked === 'string' ? picked : (picked && picked.path) || null;
    if (!path) return; // cancelled
    const base = path.replace(/\/+$/, '').split('/').pop() || 'Vault';
    if (mode === 'create') {
      setDraft({ path, name: base, manifestEnabled: true, mode: 'create' });
      return;
    }
    try {
      await validate(path);
      setDraft({ path, name: base, manifestEnabled: true, mode: 'add' });
    } catch (e) {
      setError(e?.message || 'Not a valid Obsidian vault.');
    }
  };

  const submit = async () => {
    if (!draft) return;
    const name = draft.name.trim() || 'Vault';
    const isCreate = draft.mode === 'create';
    const manifestOn = draft.manifestEnabled;
    const prevIds = new Set(vaults.map((v) => v.id));
    setBusy(true); setError(null);
    try {
      if (isCreate) {
        const out = await createVault(name, draft.path, manifestOn);
        const created = (out?.vaults || []).find((v) => !prevIds.has(v.id));
        setDraft(null);
        if (created) {
          notify('Vault created', `${created.name} — scaffolded and switched`);
          request(created.id); // confirmable switch → full remount onto the new vault
        }
      } else {
        const out = await addVault(name, draft.path, manifestOn);
        const added = (out?.vaults || []).find((v) => !prevIds.has(v.id));
        setDraft(null);
        if (added) {
          let shape = null;
          try { shape = await api.vaults.shape(added.id); } catch {}
          const folders = shape?.topFolders?.length ?? 0;
          const notes = shape?.noteCount ?? 0;
          setAdopted({ id: added.id, name: added.name, notes, folders, manifest: manifestOn });
          notify('Vault adopted', `${added.name} — ${notes} notes, ${folders} top-level folders`);
        } else {
          setNote(`Added “${name}”.`);
        }
      }
    } catch (e) {
      setError(e?.message || (isCreate ? 'Failed to create vault.' : 'Failed to add vault.'));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (v) => {
    setError(null); setNote(null);
    try { await removeVault(v.id); setNote(`Removed “${v.name}”.`); }
    catch (e) { setError(e?.message || 'Failed to remove vault.'); }
  };

  const onRegen = async (v) => {
    setError(null); setNote(null);
    try { const n = await regenerateManifest(v.id); setNote(`Reindexed “${v.name}” — ${n} pages.`); }
    catch (e) { setError(e?.message || 'Manifest generation failed.'); }
  };

  // Partition the registry by mount role (Phase 2b): switchable content vaults
  // get full controls; the app/pulse singletons render read-only in their own
  // boxes below. Default to 'content' for back-compat with role-less entries.
  const contentVaults = vaults.filter((v) => (v.role || 'content') === 'content');
  const appVaults     = vaults.filter((v) => v.role === 'app');
  const pulseVaults   = vaults.filter((v) => v.role === 'pulse');
  const libraryVaults = vaults.filter((v) => v.role === 'library');

  return (
    <div>
      <ActiveVaultStrip accent={accent}/>
      <SectionLabel>Vaults</SectionLabel>
      <div className="candy-section" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px' }}>
        {contentVaults.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No vaults registered.</div>
        )}
        {contentVaults.map((v) => (
          <VaultRow
            key={v.id}
            v={v}
            isActive={v.id === activeId}
            accent={accent}
            onSwitch={request}
            onRegen={onRegen}
            onRemove={onRemove}
            onConfigureMapping={() => setMappingOpen(true)}
            onNewDomain={() => sharedEvents.emit('domain-builder:open', { vaultId: v.id })}
          />
        ))}
      </div>

      {draft ? (
        <div className="candy-section" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, marginTop: 12 }}>
          <SectionLabel>{draft.mode === 'create' ? 'Create new vault' : 'Add vault'}</SectionLabel>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{draft.path}</div>
          {draft.mode === 'create' && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>An empty folder — <code>.obsidian/</code> + a welcome note will be created here.</div>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              autoFocus
              style={{
                appearance: 'none', background: 'var(--surface-2)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                color: 'var(--text)', fontSize: 13, padding: '7px 10px', outline: 'none',
              }}
            />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text)' }}>Generate manifest <span style={{ color: 'var(--text-faint)' }}>(wikilinks + graph)</span></span>
            <EnableToggle enabled={draft.manifestEnabled} accent={accent || 'var(--accent)'} onChange={(val) => setDraft((d) => ({ ...d, manifestEnabled: val }))} title="Generate a manifest for this vault" />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <OutlinedBtn small onClick={() => { setDraft(null); setError(null); }}>Cancel</OutlinedBtn>
            <OutlinedBtn small onClick={submit} disabled={busy}>
              {draft.mode === 'create' ? (busy ? 'Creating…' : 'Create vault') : (busy ? 'Adding…' : 'Add vault')}
            </OutlinedBtn>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <OutlinedBtn small onClick={() => pickFolder('create')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconPlus size={13} /> Create new…</span>
          </OutlinedBtn>
          <OutlinedBtn small onClick={() => pickFolder('add')}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><IconDatabase size={13} /> Add existing…</span>
          </OutlinedBtn>
        </div>
      )}

      {mappingOpen && activeVault && (activeVault.role || 'content') === 'content' && (
        <VaultMappingEditor
          vault={activeVault}
          onClose={() => setMappingOpen(false)}
          setVaultMapping={setVaultMapping}
          accent={accent}
        />
      )}

      {adopted && (
        <div className="candy-section" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14, marginTop: 12 }}>
          <SectionLabel>Adopted</SectionLabel>
          <div style={{ fontSize: 12.5, color: 'var(--text)' }}>
            Adopted <b>{adopted.name}</b>: {adopted.notes} notes, {adopted.folders} top-level folder{adopted.folders === 1 ? '' : 's'}{adopted.manifest ? ', wikilinks resolved' : ''}.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <OutlinedBtn small onClick={() => setAdopted(null)}>Dismiss</OutlinedBtn>
            <OutlinedBtn small onClick={() => { if (adopted.id) request(adopted.id); }}>Switch to configure</OutlinedBtn>
          </div>
        </div>
      )}

      {appVaults.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <SectionLabel>App</SectionLabel>
          <div className="candy-section" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px' }}>
            {appVaults.map((v) => (
              <VaultRow key={v.id} v={v} accent={accent} readOnly onRegen={onRegen} />
            ))}
          </div>
        </div>
      )}

      {pulseVaults.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <SectionLabel>Pulse</SectionLabel>
          <div className="candy-section" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px' }}>
            {pulseVaults.map((v) => (
              <VaultRow key={v.id} v={v} accent={accent} readOnly onRegen={onRegen} />
            ))}
          </div>
        </div>
      )}

      {libraryVaults.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <SectionLabel>Library</SectionLabel>
          <div className="candy-section" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px' }}>
            {libraryVaults.map((v) => (
              <VaultRow key={v.id} v={v} accent={accent} readOnly />
            ))}
            <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
              Writable, app-managed — your media catalogs live here.
            </div>
          </div>
        </div>
      )}

      {error && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--danger, var(--text))' }}>{error}</div>}
      {note && !error && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>{note}</div>}

      <ConfirmModal
        open={pending}
        title="Unsaved changes"
        message="You have unsaved edits that will be discarded when switching vaults. Switch anyway?"
        confirmLabel="Switch"
        cancelLabel="Keep editing"
        onConfirm={confirm}
        onCancel={cancel}
      />
    </div>
  );
}

// One registry row. Switchable (content) rows get Switch / Regenerate / Remove;
// read-only (app/pulse) rows get a lock glyph + Regenerate only.
function VaultRow({ v, isActive, accent, readOnly, onSwitch, onRegen, onRemove, onConfigureMapping, onNewDomain }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 2px' }}>
      <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', flexShrink: 0, color: isActive ? (accent || 'var(--accent)') : 'var(--text-faint)' }}>
        {readOnly ? <IconLock size={12} /> : isActive ? <IconCheck size={14} /> : <IconDatabase size={13} />}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {v.name}
          {isActive && (
            <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', color: accent || 'var(--accent)' }}>active</span>
          )}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.path}</span>
      </span>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
        {!readOnly && !isActive && <OutlinedBtn small onClick={() => onSwitch(v.id)}>Switch</OutlinedBtn>}
        {!readOnly && isActive && onConfigureMapping && <OutlinedBtn small onClick={() => onConfigureMapping(v)}>Map</OutlinedBtn>}
        {!readOnly && onNewDomain && <OutlinedBtn chip title="New knowledge domain in this vault" onClick={onNewDomain}><span style={{ display: 'inline-flex' }}><IconPlus size={13} /></span></OutlinedBtn>}
        {onRegen && <OutlinedBtn chip title="Regenerate manifest" onClick={() => onRegen(v)}><span style={{ display: 'inline-flex' }}><IconRepeat size={13} /></span></OutlinedBtn>}
        {!readOnly && !isActive && <OutlinedBtn chip title="Remove vault" onClick={() => onRemove(v)}><span style={{ display: 'inline-flex' }}><IconX size={13} /></span></OutlinedBtn>}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'var(--font-mono)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--text-faint)', fontWeight: 600,
      marginBottom: 12,
    }}>{children}</div>
  );
}

// SF4 adapter-mapping editor for the ACTIVE content vault. Maps the vault's own
// folders onto the Knowledge / Infrastructure views (re-root) and hides folders
// from the auto-discovery tree. Blank roots → auto-discovery; all-empty → the
// mapping is cleared (None).
function VaultMappingEditor({ vault, onClose, setVaultMapping, accent }) {
  const [folders, setFolders] = useState(null); // top-level folder names | null while loading
  const [knowledgeRoot, setKnowledgeRoot] = useState(vault?.mapping?.knowledgeRoot || '');
  const [infraRoot, setInfraRoot] = useState(vault?.mapping?.infraRoot || '');
  const [hide, setHide] = useState(vault?.mapping?.hide || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.vaults.shape()
      .then((s) => { if (!cancelled) setFolders((s.topFolders || []).map((f) => f.name)); })
      .catch(() => { if (!cancelled) setFolders([]); });
    return () => { cancelled = true; };
  }, []);

  const toggleHide = (name) =>
    setHide((h) => (h.includes(name) ? h.filter((x) => x !== name) : [...h, name]));

  const save = async () => {
    setBusy(true); setErr(null);
    const isEmpty = !knowledgeRoot && !infraRoot && hide.length === 0;
    const mapping = isEmpty ? null : {
      knowledgeRoot: knowledgeRoot || null,
      infraRoot: infraRoot || null,
      hide,
    };
    try {
      await setVaultMapping(vault.id, mapping);
      onClose();
    } catch (e) {
      setErr(e?.message || 'Failed to save mapping.');
      setBusy(false);
    }
  };

  const selStyle = {
    appearance: 'none', background: 'var(--surface-2)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
    color: 'var(--text)', fontSize: 13, padding: '7px 10px', outline: 'none',
  };

  return (
    <div className="candy-section" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14, marginTop: 12 }}>
      <SectionLabel>Configure mapping — {vault?.name}</SectionLabel>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Treat your own folders as the Knowledge / Infrastructure roots, or hide folders from the tree. Leave a root blank to use auto-discovery.
      </div>
      {folders === null ? (
        <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Loading folders…</div>
      ) : (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Knowledge root</span>
            <select value={knowledgeRoot} onChange={(e) => setKnowledgeRoot(e.target.value)} style={selStyle}>
              <option value="">(none — use Knowledge/ or auto-discovery)</option>
              {folders.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Infrastructure root</span>
            <select value={infraRoot} onChange={(e) => setInfraRoot(e.target.value)} style={selStyle}>
              <option value="">(none — use Infrastructure/)</option>
              {folders.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Hide folders from the tree</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {folders.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>No top-level folders.</span>}
              {folders.map((name) => (
                <label key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text)' }}>
                  <input type="checkbox" checked={hide.includes(name)} onChange={() => toggleHide(name)} style={{ accentColor: accent || 'var(--accent)' }} />
                  {name}
                </label>
              ))}
            </div>
          </div>
        </>
      )}
      {err && <div style={{ fontSize: 12, color: 'var(--danger, var(--text))' }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <OutlinedBtn small onClick={onClose}>Cancel</OutlinedBtn>
        <OutlinedBtn small onClick={save} disabled={busy || folders === null}>{busy ? 'Saving…' : 'Save mapping'}</OutlinedBtn>
      </div>
    </div>
  );
}

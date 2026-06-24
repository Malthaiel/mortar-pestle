// Global recycling bin — a centered modal listing soft-deleted items from every
// surface (Phase 1: vault files/folders). Unified newest-first list with a
// source filter + per-row preview, restore (with per-conflict overwrite/rename/
// skip prompts), per-item + bulk permanent delete, and empty-bin. Rust owns the
// store; this is a thin view over useRecycleBin. Modeled on ConfirmModal's
// fixed backdrop, sized larger and portaled like the other big modals.
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { OutlinedBtn, DangerOutlinedBtn, AppWindow } from './ui';
import ConfirmModal from './ui/ConfirmModal.jsx';
import { IconTrash, IconX } from './icons.jsx';
import { timeAgo } from '../util/time.js';
import { useRecycleBin } from '../hooks/useRecycleBin.js';

const SOURCES = ['all', 'vault', 'planner', 'pulse', 'music', 'anime', 'studio'];
const SOURCE_LABEL = {
  all: 'All', vault: 'Vault', planner: 'Planner', pulse: 'Pulse', music: 'Music', anime: 'Anime', studio: 'Studio',
};

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function SourceBadge({ source }) {
  return (
    <span
      style={{
        fontSize: 9, fontFamily: 'var(--font-mono, ui-monospace, monospace)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        padding: '2px 6px', borderRadius: 5, border: '1px solid var(--border)',
        color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      {SOURCE_LABEL[source] || source}
    </span>
  );
}

export default function RecyclingBinModal({ open, onClose, accent, retentionDays, maxItems }) {
  const { items, loading, refresh, purgeThenRefresh, read, restore, remove, empty, regenManifest, setRetention } =
    useRecycleBin();
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const [preview, setPreview] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind:'delete'|'empty'|'bulkDelete', id?, label?, ids? }
  const [conflict, setConflict] = useState(null); // { id, kind:'occupied'|'parent_missing', renameValue }
  const [busy, setBusy] = useState(false);

  const days = retentionDays ?? 30;
  const maxC = maxItems ?? 200;

  // Keep RecycleBin/retention.json in sync with Settings (drives the Rust
  // startup purge). Fires on mount and whenever the values change.
  useEffect(() => { setRetention(days, maxC); }, [days, maxC, setRetention]);

  // Open: retention sweep + reset transient state.
  useEffect(() => {
    if (!open) return;
    setFilter('all');
    setChecked(new Set());
    setSelectedId(null);
    setPreview(null);
    setConfirm(null);
    setConflict(null);
    purgeThenRefresh(days, maxC);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc closes the bin (only when no nested dialog is up).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !confirm && !conflict) { e.stopPropagation(); onClose?.(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, confirm, conflict, onClose]);

  // Load the preview for the focused row.
  useEffect(() => {
    let alive = true;
    if (selectedId) {
      read(selectedId).then((p) => alive && setPreview(p)).catch(() => alive && setPreview(null));
    } else {
      setPreview(null);
    }
    return () => { alive = false; };
  }, [selectedId, read]);

  const shown = items.filter((i) => filter === 'all' || i.source === filter);
  const selectedItem = items.find((i) => i.id === selectedId) || null;
  // Record-backed items (a block/key inside a living file) can't be restored if
  // that host file is gone — we never recreate a daily log. Surface a truthful
  // "can't restore" message instead of the folder-recreate prompt.
  const conflictItem = conflict ? items.find((i) => i.id === conflict.id) || null : null;
  const conflictIsRecord = !!conflictItem
    && (conflictItem.restoreStrategy === 'recordBlock' || conflictItem.restoreStrategy === 'frontmatterKey');

  const afterMutation = useCallback(
    async ({ regen } = {}) => {
      await refresh();
      if (regen) regenManifest();
    },
    [refresh, regenManifest],
  );

  const dropChecked = (id) => setChecked((p) => { const n = new Set(p); n.delete(id); return n; });
  const toggleCheck = (id) =>
    setChecked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const doRestore = useCallback(
    async (id) => {
      setBusy(true);
      try {
        const r = await restore(id);
        if (r.status === 'conflict') {
          setConflict({ id, kind: r.conflictKind, renameValue: r.suggestedName || '' });
        } else if (r.status === 'restored') {
          dropChecked(id);
          if (selectedId === id) setSelectedId(null);
          await afterMutation({ regen: true });
        }
      } catch (e) {
        console.error('restore failed', e);
      } finally {
        setBusy(false);
      }
    },
    [restore, afterMutation, selectedId],
  );

  const resolveConflict = useCallback(
    async (choice) => {
      const c = conflict;
      setConflict(null);
      if (!c || choice === 'skip') return;
      setBusy(true);
      try {
        const r = await restore(c.id, choice, choice === 'rename' ? c.renameValue : null);
        if (r.status === 'conflict') {
          setConflict({ id: c.id, kind: r.conflictKind, renameValue: r.suggestedName || c.renameValue });
        } else if (r.status === 'restored') {
          dropChecked(c.id);
          if (selectedId === c.id) setSelectedId(null);
          await afterMutation({ regen: true });
        }
      } catch (e) {
        console.error('restore (resolve) failed', e);
      } finally {
        setBusy(false);
      }
    },
    [conflict, restore, afterMutation, selectedId],
  );

  const bulkRestore = useCallback(async () => {
    setBusy(true);
    try {
      for (const id of Array.from(checked)) {
        const r = await restore(id); // eslint-disable-line no-await-in-loop
        if (r.status === 'conflict') {
          setConflict({ id, kind: r.conflictKind, renameValue: r.suggestedName || '' });
          break; // resolve this one, then re-run bulk for the rest
        }
        if (r.status === 'restored') dropChecked(id);
      }
      await afterMutation({ regen: true });
    } catch (e) {
      console.error('bulk restore failed', e);
    } finally {
      setBusy(false);
    }
  }, [checked, restore, afterMutation]);

  const confirmYes = useCallback(async () => {
    const c = confirm;
    setConfirm(null);
    if (!c) return;
    setBusy(true);
    try {
      if (c.kind === 'delete') {
        await remove(c.id);
        if (selectedId === c.id) setSelectedId(null);
        dropChecked(c.id);
      } else if (c.kind === 'empty') {
        await empty();
        setSelectedId(null);
        setChecked(new Set());
      } else if (c.kind === 'bulkDelete') {
        for (const id of c.ids) await remove(id); // eslint-disable-line no-await-in-loop
        setChecked(new Set());
        setSelectedId(null);
      }
      await afterMutation();
    } catch (e) {
      console.error('permanent delete failed', e);
    } finally {
      setBusy(false);
    }
  }, [confirm, remove, empty, afterMutation, selectedId]);

  if (!open) return null;

  const confirmCfg = confirm && {
    delete: {
      title: 'Delete permanently?',
      message: `“${confirm.label}” will be destroyed. This can't be undone.`,
      confirmLabel: 'Delete',
    },
    empty: {
      title: 'Empty recycling bin?',
      message: `Permanently destroy all ${items.length} item(s)? This can't be undone.`,
      confirmLabel: 'Empty bin',
    },
    bulkDelete: {
      title: 'Delete selected?',
      message: `Permanently destroy ${confirm.ids?.length || 0} selected item(s)? This can't be undone.`,
      confirmLabel: 'Delete',
    },
  }[confirm.kind];

  const selectedCount = checked.size;

  return (
    <>
      <AppWindow
        open={open}
        onClose={onClose}
        accent={accent}
        icon={<IconTrash size={18} />}
        title="Recycling bin"
        width="min(780px, 94vw)"
        height="80vh"
        escToClose={false}
        headerContent={(
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {loading ? 'Loading…' : `${items.length} item${items.length === 1 ? '' : 's'}`}
          </div>
        )}
        bodyStyle={{ padding: 0, overflowY: 'hidden', display: 'flex', flexDirection: 'column' }}
      >

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {SOURCES.map((f) => {
              const count = f === 'all' ? items.length : items.filter((i) => i.source === f).length;
              const isActive = filter === f;
              const isEmpty = f !== 'all' && count === 0;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  disabled={isEmpty && !isActive}
                  style={{
                    fontSize: 11, padding: '3px 9px', borderRadius: 7, cursor: isEmpty && !isActive ? 'default' : 'pointer',
                    border: `1px solid ${isActive ? accent || 'var(--accent)' : 'var(--border)'}`,
                    background: isActive ? `color-mix(in srgb, ${accent || 'var(--accent)'} 16%, transparent)` : 'transparent',
                    color: isActive ? 'var(--text)' : 'var(--text-muted)',
                    opacity: isEmpty && !isActive ? 0.4 : 1, whiteSpace: 'nowrap',
                  }}
                >
                  {SOURCE_LABEL[f]}{f !== 'all' && count > 0 ? ` ${count}` : ''}
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1 }} />
          {selectedCount > 0 ? (
            <>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{selectedCount} selected</span>
              <OutlinedBtn small disabled={busy} onClick={bulkRestore}>Restore</OutlinedBtn>
              <DangerOutlinedBtn small disabled={busy} onClick={() => setConfirm({ kind: 'bulkDelete', ids: Array.from(checked) })}>Delete</DangerOutlinedBtn>
            </>
          ) : (
            <DangerOutlinedBtn small disabled={busy || items.length === 0} onClick={() => setConfirm({ kind: 'empty' })}>Empty bin</DangerOutlinedBtn>
          )}
        </div>

        {/* Body: list + preview */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* List */}
          <div style={{ flex: 1, overflowY: 'auto', minWidth: 0, borderRight: '1px solid var(--border)' }}>
            {shown.length === 0 ? (
              <div style={{ padding: 24, fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center' }}>
                {items.length === 0 ? 'The recycling bin is empty.' : 'No items for this filter.'}
              </div>
            ) : (
              shown.map((it) => (
                <div
                  key={it.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                    borderBottom: '1px solid var(--border)',
                    background: selectedId === it.id ? 'color-mix(in srgb, var(--text) 6%, transparent)' : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked.has(it.id)}
                    onChange={() => toggleCheck(it.id)}
                    style={{ flexShrink: 0, cursor: 'pointer' }}
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedId(it.id)}
                    style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <SourceBadge source={it.source} />
                      <span style={{ fontSize: 12.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                      {it.externalIrreversible && <span title={it.externalIrreversible} style={{ fontSize: 11, color: '#d9a55a', flexShrink: 0 }}>⚠</span>}
                      {it.itemCount != null && (
                        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>{it.itemCount} item{it.itemCount === 1 ? '' : 's'}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.sublabel ? `${it.sublabel} · ` : ''}{timeAgo(it.deletedAt)} · {fmtBytes(it.sizeBytes)}
                    </div>
                  </button>
                  <OutlinedBtn small disabled={busy} onClick={() => doRestore(it.id)}>Restore</OutlinedBtn>
                  <DangerOutlinedBtn small disabled={busy} onClick={() => setConfirm({ kind: 'delete', id: it.id, label: it.label })}>Delete</DangerOutlinedBtn>
                </div>
              ))
            )}
          </div>

          {/* Preview */}
          <div style={{ width: 320, flexShrink: 0, overflowY: 'auto', padding: 14 }}>
            {selectedItem?.externalIrreversible && (
              <div style={{ fontSize: 11, lineHeight: 1.5, color: '#d9a55a', background: 'color-mix(in srgb, #d9a55a 12%, transparent)', border: '1px solid color-mix(in srgb, #d9a55a 40%, transparent)', borderRadius: 7, padding: '8px 10px', marginBottom: 10 }}>
                ⚠ {selectedItem.externalIrreversible}
              </div>
            )}
            {!preview ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Select an item to preview.</div>
            ) : preview.kind === 'markdown' ? (
              <div
                style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text)', wordBreak: 'break-word' }}
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
            ) : preview.kind === 'text' ? (
              <pre style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{preview.text}</pre>
            ) : preview.kind === 'folder' ? (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{preview.title} — {preview.tree?.length || 0} entries</div>
                {(preview.tree || []).map((p) => (
                  <div key={p} style={{ fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-muted)', padding: '1px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No preview available ({preview.kind}).</div>
            )}
          </div>
        </div>
      </AppWindow>

      {createPortal(
        <>
          {/* Permanent-delete / empty-bin confirm */}
      <ConfirmModal
        open={!!confirmCfg}
        title={confirmCfg?.title}
        message={confirmCfg?.message}
        danger
        confirmLabel={confirmCfg?.confirmLabel || 'Delete'}
        onConfirm={confirmYes}
        onCancel={() => setConfirm(null)}
      />

      {/* Restore conflict prompt (overwrite / rename / skip, or recreate-parent) */}
      {conflict && (
        <div
          onClick={() => setConflict(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1001,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)',
          }}
        >
          <div onClick={(e) => e.stopPropagation()} className="candy-section" style={{ width: 400, maxWidth: '92vw', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {conflict.kind === 'parent_missing' ? (
              conflictIsRecord ? (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Host log is gone</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>The daily log this record lived in no longer exists, so it can’t be restored.</div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <OutlinedBtn small onClick={() => setConflict(null)}>OK</OutlinedBtn>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Original folder is gone</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>The folder this lived in was deleted. Recreate it and restore?</div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <OutlinedBtn small onClick={() => setConflict(null)}>Skip</OutlinedBtn>
                    <OutlinedBtn small onClick={() => resolveConflict('overwrite')}>Recreate &amp; restore</OutlinedBtn>
                  </div>
                </>
              )
            ) : (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Something's already there</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>An item already exists at the original location. Overwrite it, or restore under a new name?</div>
                <input
                  type="text"
                  value={conflict.renameValue}
                  onChange={(e) => setConflict((c) => ({ ...c, renameValue: e.target.value }))}
                  placeholder="New name"
                  style={{
                    fontSize: 12.5, padding: '7px 10px', borderRadius: 8,
                    border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', outline: 'none',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                  <OutlinedBtn small onClick={() => setConflict(null)}>Skip</OutlinedBtn>
                  <OutlinedBtn small disabled={!conflict.renameValue.trim()} onClick={() => resolveConflict('rename')}>Rename</OutlinedBtn>
                  <DangerOutlinedBtn small onClick={() => resolveConflict('overwrite')}>Overwrite</DangerOutlinedBtn>
                </div>
              </>
            )}
          </div>
        </div>
      )}
        </>,
        document.body,
      )}
    </>
  );
}

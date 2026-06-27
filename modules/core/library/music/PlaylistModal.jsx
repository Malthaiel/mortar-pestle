// Create / edit a playlist: name + optional local cover image. Portaled overlay
// (the UI kit has no Modal primitive — this mirrors ContextMenu's createPortal
// approach). Stateless about persistence: `onSubmit({ title, coverFile })` lets
// the caller decide create vs rename/setCover and close on success. `coverFile`
// is a File (chosen via a native <input type=file>) or null.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TextInput, PrimaryBtn, OutlinedBtn } from '@host/components/ui/index.js';
import { coverSrc } from './util.js';

export default function PlaylistModal({
  open,
  mode = 'create',
  initialTitle = '',
  initialImage = null,
  accent,
  onSubmit,
  onClose,
  busy,
  error,
}) {
  const [title, setTitle] = useState(initialTitle);
  const [coverFile, setCoverFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);

  // Reset fields whenever the modal (re)opens.
  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setCoverFile(null);
      setPreview(null);
    }
  }, [open, initialTitle]);

  // Object-URL preview for a freshly picked file; revoked on change/unmount.
  useEffect(() => {
    if (!coverFile) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(coverFile);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);

  if (!open) return null;

  const a = accent || 'var(--accent)';
  const existing = initialImage ? coverSrc(initialImage) : null;
  const shownCover = preview || existing;
  const canSubmit = title.trim().length > 0 && !busy;
  const submit = () => {
    if (canSubmit) onSubmit({ title: title.trim(), coverFile });
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        onClick={busy ? undefined : onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.46)' }}
      />
      <div
        style={{
          position: 'relative',
          width: 384,
          maxWidth: '90vw',
          background: 'var(--bg, #1a1a1a)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg, 12px)',
          boxShadow: '0 18px 48px rgba(0,0,0,0.42)',
          padding: 22,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
          {mode === 'create' ? 'New playlist' : 'Edit playlist'}
        </div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Choose cover image"
            style={{
              width: 84,
              height: 84,
              flexShrink: 0,
              borderRadius: 8,
              overflow: 'hidden',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-faint)',
              fontSize: 11,
            }}
          >
            {shownCover ? (
              <img src={shownCover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span>+ Cover</span>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setCoverFile(f);
            }}
          />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <TextInput
              value={title}
              onChange={setTitle}
              placeholder="Playlist name"
              accent={a}
              autoFocus
              style={{ width: '100%' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
            {coverFile && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {coverFile.name}
              </div>
            )}
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: 'var(--text)' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <OutlinedBtn onClick={onClose} disabled={busy}>Cancel</OutlinedBtn>
          <PrimaryBtn onClick={submit} disabled={!canSubmit} accent={a}>
            {busy ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </PrimaryBtn>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Vault-native notes for an album, mounted in AlbumDetail. Reads/writes the
// `## Notes` body section of the album's vault page (music_set_notes splices it
// server-side, preserving the machine-generated Cover/Tracks). Supports
// [[wikilinks]] — rendered clickable in a live preview, resolved against the
// vault manifest — and lists pages that link back to this album.

import { useEffect, useMemo, useRef, useState } from 'react';
import { musicApi } from './api.js';
import { useManifestData } from '@host/lib/manifestReader.js';

const goPage = (path) => {
  window.location.hash = '/page/' + path.split('/').map(encodeURIComponent).join('/');
};

// Resolve a wikilink target to a vault path via the manifest (basename / alias /
// title), or treat an explicit a/b/c path directly.
function buildResolver(manifest) {
  const byBase = new Map();
  const byKey = new Map();
  (manifest?.entries || []).forEach((e) => {
    if (!e.path) return;
    const base = e.path.replace(/\.md$/, '').split('/').pop();
    if (!byBase.has(base)) byBase.set(base, e.path);
    if (e.title && !byKey.has(e.title)) byKey.set(e.title, e.path);
    (e.aliases || []).forEach((a) => { if (!byKey.has(a)) byKey.set(a, e.path); });
  });
  return (target) => {
    const t = (target || '').split('#')[0].trim();
    if (!t) return null;
    if (t.includes('/')) return t.endsWith('.md') ? t : t + '.md';
    return byBase.get(t) || byKey.get(t) || null;
  };
}

// Render plain text with [[wikilinks]] as clickable links. Unresolved links show
// struck-through (never silently dropped) so dead links stay visible.
function renderWithLinks(text, resolve, accent) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let last = 0, m, key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const [rawTarget, alias] = m[1].split('|');
    const label = (alias || rawTarget.split('#')[0]).trim();
    const path = resolve(rawTarget);
    out.push(
      <a
        key={key++}
        href="#"
        onClick={(e) => { e.preventDefault(); if (path) goPage(path); }}
        title={path || 'Unresolved link'}
        style={{
          color: path ? (accent || 'var(--accent)') : 'var(--text-faint)',
          textDecoration: path ? 'none' : 'line-through',
          cursor: path ? 'pointer' : 'default',
          fontWeight: 500,
        }}
      >{label}</a>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
  return out;
}

export default function MusicNotes({ album, accent }) {
  const manifest = useManifestData();
  const resolve = useMemo(() => buildResolver(manifest), [manifest]);

  const [text, setText] = useState(album?.notes || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = useRef(false);
  const savedText = useRef(album?.notes || '');

  // Reset when switching albums.
  useEffect(() => {
    setText(album?.notes || '');
    savedText.current = album?.notes || '';
    dirty.current = false;
    setSaved(false);
  }, [album?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    if (!dirty.current || text === savedText.current) return;
    setSaving(true);
    musicApi.setNotes(album.path, text)
      .then((res) => {
        savedText.current = (res && res.notes != null) ? res.notes : text.trim();
        dirty.current = false;
        setSaved(true);
      })
      .catch((e) => alert('Saving notes failed: ' + (e.message || e)))
      .finally(() => setSaving(false));
  };

  // Backlinks: manifest entries whose outbound_links target this album.
  const backlinks = useMemo(() => {
    const base = (album?.path || '').replace(/\.md$/, '').split('/').pop();
    const full = (album?.path || '').replace(/\.md$/, '');
    if (!base) return [];
    return (manifest?.entries || [])
      .filter((e) => e.path !== album.path && (e.outbound_links || []).some((l) => {
        const t = (l.target || '').split('#')[0];
        return t === base || t === full || t.endsWith('/' + base);
      }))
      .slice(0, 24);
  }, [manifest, album?.path]);

  if (!album) return null;
  const hasText = text.trim().length > 0;

  return (
    <div style={{ padding: '4px 24px 26px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        padding: '0 0 6px', borderBottom: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      }}>
        <span>Notes</span>
        <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>
          {saving ? 'Saving…' : (saved ? 'Saved' : '')}
        </span>
      </div>

      {/* Live preview (rendered wikilinks) */}
      {hasText && (
        <div style={{
          fontSize: 13, lineHeight: 1.6, color: 'var(--text)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          padding: '2px 2px',
        }}>
          {renderWithLinks(text, resolve, accent)}
        </div>
      )}

      {/* Editor — saves on blur */}
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); dirty.current = true; setSaved(false); }}
        onBlur={save}
        placeholder="Add a note — [[wikilinks]] to people, journal entries, other albums…"
        spellCheck
        style={{
          width: '100%', minHeight: 84, resize: 'vertical',
          background: 'var(--surface-2)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 8,
          padding: '10px 12px', fontSize: 13, lineHeight: 1.55,
          fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
        }}
      />

      {/* Backlinks */}
      {backlinks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
          <div style={{
            fontSize: 9, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>Linked from</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {backlinks.map((e) => (
              <button
                key={e.path}
                onClick={() => goPage(e.path)}
                className="candy-btn" data-shape="chip"
                style={{ '--accent': accent || 'var(--accent)' }}
                title={e.path}
              >
                <span className="candy-face" style={{ padding: '4px 10px', fontSize: 11 }}>
                  {e.title || e.path.replace(/\.md$/, '').split('/').pop()}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

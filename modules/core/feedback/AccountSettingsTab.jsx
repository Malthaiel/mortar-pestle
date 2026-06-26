import { useMemo, useState, useEffect, useRef } from 'react';
import { TextInput } from '@host/components/ui/Input.jsx';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import { makeFeedbackApi } from './feedbackApi.js';
import { useSession } from './useSession.js';
import UserAvatar from './UserAvatar.jsx';

// Settings → Feedback tab: manage handle + display name. Avatar upload lands in
// Phase 4 (UserAvatar). Reuses candy primitives only.
export default function AccountSettingsTab({ api, accent }) {
  const fb = useMemo(() => makeFeedbackApi(api), [api]);
  const { session, loading, refresh } = useSession(fb);
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    if (session?.profile) {
      setHandle(session.profile.handle || '');
      setDisplayName(session.profile.display_name || '');
      setAvatarUrl(session.profile.avatar_url || '');
    }
  }, [session]);

  const onPickAvatar = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setMsg(''); setUploading(true);
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const r = await fb.avatarUpload(bytes, file.type);
      setAvatarUrl(r?.avatarUrl || '');
      await refresh();
      setMsg('Avatar updated.');
    } catch (e2) { setError(e2.message || 'Could not upload avatar'); }
    finally { setUploading(false); }
  };

  const save = async () => {
    setError(''); setMsg(''); setBusy(true);
    try {
      await fb.profileUpsert(handle.trim().toLowerCase(), displayName.trim());
      await refresh();
      setMsg('Saved.');
    } catch (e) { setError(e.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  const signOut = async () => {
    setBusy(true);
    try { await fb.signOut(); await refresh(); setMsg(''); }
    finally { setBusy(false); }
  };

  if (loading) return <div style={muted}>Loading…</div>;
  if (!session?.signedIn) {
    return <div style={muted}>Open the Feedback board and sign in to manage your account.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 420 }}>
      <div>
        <label style={label}>Handle</label>
        <TextInput value={handle} onChange={setHandle} placeholder="your_handle" accent={accent} style={{ width: '100%' }} />
        <div style={hint}>3–30 characters: lowercase letters, numbers, underscore.</div>
      </div>
      <div>
        <label style={label}>Display name</label>
        <TextInput value={displayName} onChange={setDisplayName} placeholder="Your name" accent={accent} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={label}>Avatar</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <UserAvatar src={avatarUrl} name={handle} size={48} />
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={onPickAvatar} style={{ display: 'none' }} />
          <OutlinedBtn onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? 'Uploading…' : 'Change avatar'}</OutlinedBtn>
        </div>
        <div style={hint}>PNG, JPEG, or WebP · max 4 MB · cropped to a circle.</div>
      </div>
      {error && <div style={{ color: 'var(--error)', fontSize: 12 }}>{error}</div>}
      {msg && <div style={{ color: 'var(--accent)', fontSize: 12 }}>{msg}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <PrimaryBtn onClick={save} disabled={busy || handle.trim().length < 3}>{busy ? 'Saving…' : 'Save'}</PrimaryBtn>
        <OutlinedBtn onClick={signOut} disabled={busy}>Sign out</OutlinedBtn>
      </div>
    </div>
  );
}

const label = { display: 'block', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-faint)', marginBottom: 6 };
const hint = { fontSize: 11, color: 'var(--text-faint)', marginTop: 4 };
const muted = { color: 'var(--text-muted)', fontSize: 13 };

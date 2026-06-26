import { useState } from 'react';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import StatusDropdown from '@host/components/ui/StatusDropdown.jsx';

// Role-gated dev powers on a post: set roadmap status (reuses the shared
// StatusDropdown), pin, hide, and post an official reply. The real gate is RLS
// server-side (is_dev()); this component is only rendered when the caller's
// profile.role === 'dev', so a non-dev never sees it.
const STATUSES = ['open', 'under_review', 'planned', 'in_progress', 'done', 'declined'];
const HUE = {
  open: '#8a8f98', under_review: '#d6a445', planned: '#9b7fd4',
  in_progress: 'var(--accent)', done: '#5bb98c', declined: 'var(--error)',
};

export default function DevControls({ fb, post, accent, onChanged }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); await onChanged?.(); } catch (e) { console.error('dev action failed', e); }
    finally { setBusy(false); }
  };

  const sendReply = async () => {
    if (!reply.trim()) return;
    await run(() => fb.commentOfficialReply(post.id, reply.trim()));
    setReply('');
  };

  return (
    <div className="fb-devbar">
      <div className="fb-devbar-row">
        <span className="fb-devbar-label">DEV</span>
        <StatusDropdown
          value={post.status}
          statuses={STATUSES}
          accent={accent}
          dotFor={(s) => HUE[s]}
          title="Set roadmap status"
          disabled={busy}
          onChange={(s) => { if (s) run(() => fb.postSetStatus(post.id, s)); }}
        />
        <OutlinedBtn small disabled={busy} onClick={() => run(() => fb.postPin(post.id, !post.pinned))}>
          {post.pinned ? 'Unpin' : 'Pin'}
        </OutlinedBtn>
        <OutlinedBtn small disabled={busy} onClick={() => run(() => fb.postDeleteAny(post.id, true))}>
          Hide
        </OutlinedBtn>
      </div>
      <div>
        <textarea
          className="candy-input"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Official reply…"
          rows={2}
          style={{ width: '100%', resize: 'vertical', padding: '8px 10px', fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--text)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <PrimaryBtn small disabled={busy || !reply.trim()} onClick={sendReply}>Post official reply</PrimaryBtn>
        </div>
      </div>
    </div>
  );
}

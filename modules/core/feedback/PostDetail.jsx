import { useState, useEffect, useCallback } from 'react';
import { PrimaryBtn, OutlinedBtn } from '@host/components/ui/Button.jsx';
import SignInModal from './SignInModal.jsx';
import { useSession } from './useSession.js';

const STATUS_LABELS = {
  open: 'Open', under_review: 'Under review', planned: 'Planned',
  in_progress: 'In progress', done: 'Done', declined: 'Declined',
};

export default function PostDetail({ api, fb, accent, postId }) {
  const { session, refresh: refreshSession } = useSession(fb);
  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [voted, setVoted] = useState(false);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [p, c] = await Promise.all([fb.postGet(postId), fb.commentsList(postId)]);
      setPost(p);
      setComments(Array.isArray(c) ? c : []);
    } catch (e) { setError(e.message || 'Could not load this post'); }
    finally { setLoading(false); }
  }, [fb, postId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!session?.signedIn) { setVoted(false); setFollowing(false); return; }
    fb.myInteractions().then((r) => {
      setVoted(new Set((r?.votes || []).map((v) => v.post_id)).has(postId));
      setFollowing(new Set((r?.follows || []).map((f) => f.post_id)).has(postId));
    }).catch(() => {});
  }, [session, fb, postId]);

  const requireAuth = () => { if (!session?.signedIn) { setShowSignIn(true); return false; } return true; };

  const onVote = async () => {
    if (!requireAuth()) return;
    try {
      const r = await fb.voteToggle(postId);
      setVoted(r.voted);
      setPost((p) => (p ? { ...p, vote_count: (p.vote_count || 0) + (r.voted ? 1 : -1) } : p));
    } catch (e) { console.error(e); }
  };
  const onFollow = async () => {
    if (!requireAuth()) return;
    try { const r = await fb.followToggle(postId); setFollowing(r.following); } catch (e) { console.error(e); }
  };
  const submitComment = async () => {
    if (!requireAuth()) return;
    if (!draft.trim()) return;
    setBusy(true);
    try { await fb.commentCreate(postId, draft.trim()); setDraft(''); await load(); }
    catch (e) { setError(e.message || 'Could not comment'); }
    finally { setBusy(false); }
  };

  if (loading) return <div style={{ padding: 28, color: 'var(--text-muted)' }}>Loading…</div>;
  if (error) return <div style={{ padding: 28, color: 'var(--error)' }}>{error}</div>;
  if (!post) return null;

  return (
    <div style={{ padding: '24px 28px', maxWidth: 760, margin: '0 auto' }}>
      <OutlinedBtn small onClick={() => api.router.navigate('/tools/feedback')}>← Board</OutlinedBtn>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginTop: 16 }}>
        {/* PLACEHOLDER vote → <VoteButton> after green light */}
        <OutlinedBtn onClick={onVote} title={voted ? 'Remove vote' : 'Upvote'}>▲ {post.vote_count ?? 0}</OutlinedBtn>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--text)' }}>{post.title}</h2>
          <div style={{ display: 'flex', gap: 10, fontSize: 12, color: 'var(--text-muted)', marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ textTransform: 'capitalize' }}>{post.category}</span><span>·</span>
            {/* PLACEHOLDER status → <StatusBadge> after green light */}
            <span>{STATUS_LABELS[post.status] || post.status}</span>
            {post.author?.handle && <><span>·</span><span>@{post.author.handle}</span></>}
          </div>
        </div>
        <OutlinedBtn small onClick={onFollow}>{following ? 'Following' : 'Follow'}</OutlinedBtn>
      </div>

      {post.body && (
        <div style={{ marginTop: 16, fontSize: 14, lineHeight: 1.6, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
          {post.body}
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>
          {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {comments.map((c) => (
            <div key={c.id} style={{
              padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
              background: c.is_official ? 'color-mix(in oklch, var(--accent) 8%, var(--surface-2))' : 'var(--surface-2)',
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                @{c.author?.handle || 'user'}
                {c.is_official && <span style={{ color: 'var(--accent)', marginLeft: 6, fontWeight: 600 }}>· official</span>}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{c.body}</div>
            </div>
          ))}
          {comments.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No comments yet.</div>}
        </div>

        <div style={{ marginTop: 16 }}>
          <textarea className="candy-input" value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder={session?.signedIn ? 'Add a comment…' : 'Sign in to comment'}
            disabled={!session?.signedIn}
            style={{ width: '100%', minHeight: 80, resize: 'vertical', padding: '8px 10px',
              fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--text)' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            {session?.signedIn
              ? <PrimaryBtn small onClick={submitComment} disabled={busy || !draft.trim()}>{busy ? 'Posting…' : 'Comment'}</PrimaryBtn>
              : <OutlinedBtn small onClick={() => setShowSignIn(true)}>Sign in to comment</OutlinedBtn>}
          </div>
        </div>
      </div>

      {/* Dev controls (set status / pin / official reply / hide) land in Phase 3 (role-gated). */}

      <SignInModal open={showSignIn} onClose={() => setShowSignIn(false)} fb={fb} accent={accent}
        onSignedIn={() => { refreshSession(); load(); }} />
    </div>
  );
}

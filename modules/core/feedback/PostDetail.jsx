import { useState, useEffect, useCallback } from 'react';
import { FilterChip } from '@host/components/ui/Pill.jsx';
import SignInModal from './SignInModal.jsx';
import { useSession } from './useSession.js';
import VoteButton from './VoteButton.jsx';
import PostIdentity from './PostIdentity.jsx';
import MetaRun from './MetaRun.jsx';
import UserAvatar from './UserAvatar.jsx';
import DevControls from './DevControls.jsx';

export default function PostDetail({ fb, accent, postId, onBack }) {
  const { session, refresh: refreshSession, ensureHandle } = useSession(fb);
  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [myVote, setMyVote] = useState(0);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const needsHandle = session?.signedIn && !session?.profile?.handle;

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
    if (!session?.signedIn) { setMyVote(0); setFollowing(false); return; }
    fb.myInteractions().then((r) => {
      const mine = new Map((r?.votes || []).map((v) => [v.post_id, v.value]));
      setMyVote(mine.get(postId) || 0);
      setFollowing(new Set((r?.follows || []).map((f) => f.post_id)).has(postId));
    }).catch(() => {});
  }, [session, fb, postId]);

  const requireAuth = async () => {
    if (!session?.signedIn) { setShowSignIn(true); return false; }
    return ensureHandle();                         // banner + disabled composer explain
  };

  const onVote = async (value) => {
    if (!(await requireAuth())) return;
    try {
      const r = await fb.voteSet(postId, value);
      setMyVote(r.value);
      setPost((p) => (p ? { ...p, upvote_count: r.upvote_count, downvote_count: r.downvote_count, score: r.score } : p));
    } catch (e) { console.error(e); }
  };
  const onFollow = async () => {
    if (!(await requireAuth())) return;
    try { const r = await fb.followToggle(postId); setFollowing(r.following); } catch (e) { console.error(e); }
  };
  const submitComment = async () => {
    if (!(await requireAuth())) return;
    if (!draft.trim()) return;
    setBusy(true);
    try { await fb.commentCreate(postId, draft.trim()); setDraft(''); await load(); }
    catch (e) { setError(e.message || 'Could not comment'); }
    finally { setBusy(false); }
  };

  if (loading) return <div style={{ padding: 28, color: 'var(--text-muted)' }}>Loading</div>;
  if (error) return <div style={{ padding: 28, color: 'var(--error)' }}>{error}</div>;
  if (!post) return null;

  return (
    <div style={{ padding: 20 }}>
      <FilterChip className="is-hover-accent" onClick={onBack}>← Board</FilterChip>

      {needsHandle && (
        <div style={{
          fontSize: 13, color: 'var(--text)', marginTop: 16, padding: '10px 14px',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
          background: 'color-mix(in oklch, var(--accent) 10%, var(--surface-2))',
        }}>
          Pick a handle in <strong>Settings → Feedback</strong> to vote, follow, or comment.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, alignSelf: 'stretch' }}>
          <PostIdentity author={post.author} createdAt={post.created_at} />
          <div style={{ flex: 1 }} />
          <MetaRun category={post.category} status={post.status} commentCount={comments.length} />
          <FilterChip className="is-hover-accent" active={following} accent={accent} onClick={onFollow}>{following ? 'Following' : 'Follow'}</FilterChip>
        </div>

        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: 'var(--text)' }}>{post.title}</h2>

        <VoteButton up={post.upvote_count ?? 0} down={post.downvote_count ?? 0} myVote={myVote} onVote={onVote} />
      </div>

      {/* The post's picture. Full width here, so no flex sizing round to lose —
          unlike the board card, where an in-flow image stole the text column's
          width entirely. Same frame a candy chip wears, from the same tokens. */}
      {post.image_url && (
        <div style={{
          marginTop: 16, aspectRatio: '16 / 9', overflow: 'hidden',
          borderRadius: 'var(--radius-md)', background: 'var(--surface-3)',
          border: '2px solid color-mix(in oklch, var(--cbtn-rest), black 22%)',
        }}>
          <img src={post.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </div>
      )}

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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                <UserAvatar name={c.author?.handle} src={c.author?.avatar_url} size={18} />
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
            placeholder={!session?.signedIn ? 'Sign in to comment' : needsHandle ? 'Pick a handle in Settings → Feedback to comment' : 'Add a comment'}
            disabled={!session?.signedIn || needsHandle}
            style={{ width: '100%', minHeight: 80, resize: 'vertical', padding: '8px 10px',
              fontSize: 13, fontFamily: 'var(--font-body)', color: 'var(--text)' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            {session?.signedIn
              ? <FilterChip active accent={accent} disabled={busy || !draft.trim()} onClick={submitComment}>{busy ? 'Posting' : 'Comment'}</FilterChip>
              : <FilterChip className="is-hover-accent" onClick={() => setShowSignIn(true)}>Sign in to comment</FilterChip>}
          </div>
        </div>
      </div>

      {session?.profile?.role === 'dev' && (
        <DevControls fb={fb} post={post} accent={accent} onChanged={load} />
      )}

      <SignInModal open={showSignIn} onClose={() => setShowSignIn(false)} fb={fb} accent={accent}
        onSignedIn={() => { refreshSession(); load(); }} />
    </div>
  );
}
